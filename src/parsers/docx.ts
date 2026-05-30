import fsp from "node:fs/promises";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { splitMarkdownByHeaders } from "./markdown.js";
import { ParsedDocument } from "./types.js";

export async function parseDocx(sourcePath: string): Promise<ParsedDocument> {
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }

  let mammoth: {
    convertToMarkdown(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  try {
    const mod = (await import("mammoth")) as unknown as {
      default?: typeof mammoth;
      convertToMarkdown?: typeof mammoth.convertToMarkdown;
    };
    if (mod.convertToMarkdown) {
      mammoth = { convertToMarkdown: mod.convertToMarkdown };
    } else if (mod.default?.convertToMarkdown) {
      mammoth = mod.default;
    } else {
      throw new Error("mammoth.convertToMarkdown is not available");
    }
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to load mammoth: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }

  let markdown: string;
  try {
    const result = await mammoth.convertToMarkdown({ buffer });
    markdown = result.value;
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to convert ${sourcePath} to markdown: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }

  const sections = await splitMarkdownByHeaders(markdown);
  return { sourcePath, contentType: "docx", sections };
}
