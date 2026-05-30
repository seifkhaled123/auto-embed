import fsp from "node:fs/promises";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { ParsedDocument, ParsedSection } from "./types.js";

export async function parsePdf(sourcePath: string): Promise<ParsedDocument> {
  let bytes: Uint8Array;
  try {
    const buf = await fsp.readFile(sourcePath);
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }

  let extractText: typeof import("unpdf").extractText;
  try {
    ({ extractText } = await import("unpdf"));
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to load unpdf: ${(err as Error).message}`,
      ExitCode.Parser,
      "Reinstall dependencies with `bun install` or `npm install`.",
    );
  }

  let result: { totalPages: number; text: string | string[] };
  try {
    result = await extractText(bytes, { mergePages: false });
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to extract text from ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
      "PDF may be scanned, encrypted, or malformed. OCR is not supported in v1.",
    );
  }

  const pages = Array.isArray(result.text) ? result.text : [result.text];
  const totalPages = result.totalPages ?? pages.length;

  const sections: ParsedSection[] = [];
  pages.forEach((pageText, idx) => {
    const cleaned = (pageText ?? "").trim();
    if (!cleaned) return;
    sections.push({
      text: cleaned,
      meta: { pageNumber: idx + 1, pageCount: totalPages },
    });
  });

  return { sourcePath, contentType: "pdf", sections };
}
