import path from "node:path";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { ParsedDocument } from "./types.js";

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

/**
 * Dispatch a file to the right parser. Lazy-imports the parser module so we
 * never pay parser load cost for unrelated commands (e.g. `--help`, `init`).
 *
 * TODO(v2): content-sniff fallback for files with the wrong extension.
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
    case "":
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
      throw new AutoEmbedError(
        `Unsupported file type: ${ext || "(no extension)"} (${sourcePath})`,
        ExitCode.Parser,
        "Supported: .md .mdx .pdf .html .htm .docx .csv .json .jsonl .txt and common code extensions.",
      );
  }
}

export type { ParsedDocument, ParsedSection, ContentType, Parser } from "./types.js";
