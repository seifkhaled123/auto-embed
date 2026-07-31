import fsp from "node:fs/promises";
import path from "node:path";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { log } from "../log.js";
import { ParsedDocument, ParsedSource } from "./types.js";

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
]);
export const WHOLE_DOCUMENT_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * Dispatch a file to the right parser. Lazy-imports the parser module so we
 * never pay parser load cost for unrelated commands (e.g. `--help`, `init`).
 *
 */
export async function parseFile(sourcePath: string): Promise<ParsedDocument> {
  const ext = path.extname(sourcePath).toLowerCase();

  switch (ext) {
    case ".md":
    case ".mdx":
    case ".markdown": {
      const { parseMarkdown } = await import("./markdown.js");
      return parseMarkdown(sourcePath);
    }
    case ".pdf": {
      const { parsePdf } = await import("./pdf.js");
      return parsePdf(sourcePath);
    }
    case ".html":
    case ".htm": {
      const { parseHtml } = await import("./html.js");
      return parseHtml(sourcePath);
    }
    case ".docx": {
      const { parseDocx } = await import("./docx.js");
      return parseDocx(sourcePath);
    }
    case ".csv": {
      const { parseCsv } = await import("./text.js");
      return parseCsv(sourcePath);
    }
    case ".json": {
      const { parseJson } = await import("./text.js");
      return parseJson(sourcePath);
    }
    case ".jsonl":
    case ".ndjson": {
      const { parseJsonl } = await import("./text.js");
      return parseJsonl(sourcePath);
    }
    case ".txt":
    case ".log":
    case ".text": {
      const { parseText } = await import("./text.js");
      return parseText(sourcePath);
    }
    default:
      if (CODE_EXTENSIONS.has(ext)) {
        const { parseCode } = await import("./text.js");
        return parseCode(sourcePath);
      }
      return parseSniffedFile(sourcePath, ext);
  }
}

export async function parseSource(sourcePath: string): Promise<ParsedSource> {
  const ext = path.extname(sourcePath).toLowerCase();
  const { sourceFromDocument } = await import("./stream.js");

  if ([".txt", ".text", ".log"].includes(ext)) {
    const { createTextStreamSource } = await import("./stream.js");
    return createTextStreamSource(sourcePath, "text");
  }
  if (CODE_EXTENSIONS.has(ext)) {
    const { createTextStreamSource } = await import("./stream.js");
    return createTextStreamSource(sourcePath, "code");
  }
  if (ext === ".jsonl" || ext === ".ndjson") {
    const { createJsonlStreamSource } = await import("./stream.js");
    return createJsonlStreamSource(sourcePath);
  }
  if (ext === ".csv") {
    const { createCsvStreamSource } = await import("./stream.js");
    return createCsvStreamSource(sourcePath);
  }

  await assertWholeDocumentLimit(sourcePath);
  return sourceFromDocument(await parseFile(sourcePath));
}

async function assertWholeDocumentLimit(sourcePath: string): Promise<void> {
  let size: number;
  try {
    size = (await fsp.stat(sourcePath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to inspect ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }
  if (size > WHOLE_DOCUMENT_LIMIT_BYTES) {
    throw new AutoEmbedError(
      `File exceeds the 100 MB whole-document parser limit: ${sourcePath}`,
      ExitCode.Parser,
      "Split the file, convert it to TXT/CSV/JSONL, or use a smaller source document.",
    );
  }
}

type SniffedType = "pdf" | "html" | "json" | "text" | "binary";

async function parseSniffedFile(sourcePath: string, ext: string): Promise<ParsedDocument> {
  const type = await sniffContent(sourcePath);
  switch (type) {
    case "pdf": {
      log.warn(`unrecognized extension ${ext || "(none)"}; detected PDF content`);
      const { parsePdf } = await import("./pdf.js");
      return parsePdf(sourcePath);
    }
    case "html": {
      log.warn(`unrecognized extension ${ext || "(none)"}; detected HTML content`);
      const { parseHtml } = await import("./html.js");
      return parseHtml(sourcePath);
    }
    case "json": {
      log.warn(`unrecognized extension ${ext || "(none)"}; detected JSON content`);
      const { parseJson } = await import("./text.js");
      return parseJson(sourcePath);
    }
    case "text": {
      log.warn(
        `unrecognized extension ${ext || "(none)"}; falling back to text parsing`,
      );
      const { parseText } = await import("./text.js");
      return parseText(sourcePath);
    }
    case "binary":
      throw new AutoEmbedError(
        `Unsupported binary file: ${sourcePath}`,
        ExitCode.Parser,
        "Convert it to a supported text-bearing format before ingestion.",
      );
  }
}

async function sniffContent(sourcePath: string): Promise<SniffedType> {
  const probe = Buffer.alloc(8192);
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let bytesRead = 0;
  try {
    handle = await fsp.open(sourcePath, "r");
    ({ bytesRead } = await handle.read(probe, 0, probe.length, 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to inspect ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  } finally {
    await handle?.close();
  }

  const bytes = probe.subarray(0, bytesRead);
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (bytes.includes(0)) return "binary";

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: bytesRead === probe.length,
    });
  } catch {
    return "binary";
  }

  const trimmed = text.trimStart();
  const lower = trimmed.slice(0, 128).toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) return "html";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";

  let controls = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) controls++;
  }
  if (text.length > 0 && controls / text.length > 0.02) return "binary";
  return "text";
}

export type {
  ParsedDocument,
  ParsedSection,
  ParsedSource,
  ContentType,
  Parser,
} from "./types.js";
