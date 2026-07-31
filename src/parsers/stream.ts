import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { codeLanguageForPath, stringifyValue } from "./text.js";
import { ContentType, ParsedSection, ParsedSource } from "./types.js";

export const TEXT_STREAM_HIGH_WATER_MARK = 16 * 1024;

export function createTextStreamSource(
  sourcePath: string,
  contentType: "text" | "code",
): ParsedSource {
  const meta = contentType === "code" ? { language: codeLanguageForPath(sourcePath) } : {};
  return {
    sourcePath,
    contentType,
    mode: "stream-text",
    sections: () => streamTextBlocks(sourcePath, meta),
  };
}

export function createJsonlStreamSource(sourcePath: string): ParsedSource {
  return {
    sourcePath,
    contentType: "json",
    mode: "sections",
    sections: () => streamJsonlSections(sourcePath),
  };
}

export function createCsvStreamSource(sourcePath: string): ParsedSource {
  return {
    sourcePath,
    contentType: "csv",
    mode: "sections",
    sections: () => streamCsvSections(sourcePath),
  };
}

export function sourceFromDocument(document: {
  sourcePath: string;
  contentType: ContentType;
  sections: ParsedSection[];
}): ParsedSource {
  return {
    sourcePath: document.sourcePath,
    contentType: document.contentType,
    mode: "sections",
    async *sections() {
      for (const section of document.sections) yield section;
    },
  };
}

async function* streamTextBlocks(
  sourcePath: string,
  meta: Record<string, unknown>,
): AsyncGenerator<ParsedSection> {
  const stream = createReadStream(sourcePath, {
    encoding: "utf8",
    highWaterMark: TEXT_STREAM_HIGH_WATER_MARK,
  });
  try {
    for await (const block of stream) {
      yield { text: block as string, meta };
    }
  } catch (err) {
    throw streamError(sourcePath, err);
  }
}

async function* streamJsonlSections(sourcePath: string): AsyncGenerator<ParsedSection> {
  const input = createReadStream(sourcePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new AutoEmbedError(
          `Failed to parse line ${lineNumber} of ${path.basename(sourcePath)} as JSON: ${(err as Error).message}`,
          ExitCode.Parser,
        );
      }
      yield { text: stringifyValue(parsed), meta: { line: lineNumber } };
    }
  } catch (err) {
    if (err instanceof AutoEmbedError) throw err;
    throw streamError(sourcePath, err);
  } finally {
    lines.close();
  }
}

async function* streamCsvSections(sourcePath: string): AsyncGenerator<ParsedSection> {
  let header: string[] | undefined;
  let rowNumber = 0;
  for await (const row of streamCsvRows(sourcePath)) {
    if (!header) {
      header = row;
      continue;
    }
    rowNumber++;
    if (row.length === 1 && row[0] === "") continue;
    const columns: Record<string, string> = {};
    header.forEach((column, index) => {
      columns[column] = row[index] ?? "";
    });
    yield {
      text: header.map((column) => `${column}: ${columns[column]}`).join("\n"),
      meta: { row: rowNumber, columns },
    };
  }
}

async function* streamCsvRows(sourcePath: string): AsyncGenerator<string[]> {
  const input = createReadStream(sourcePath, {
    encoding: "utf8",
    highWaterMark: TEXT_STREAM_HIGH_WATER_MARK,
  });
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let skipLf = false;

  const finishRow = (): string[] => {
    row.push(field);
    const completed = row;
    row = [];
    field = "";
    return completed;
  };

  try {
    for await (const block of input) {
      for (const char of block as string) {
        if (skipLf) {
          skipLf = false;
          if (char === "\n") continue;
        }
        if (afterQuote) {
          if (char === '"') {
            field += '"';
            afterQuote = false;
            continue;
          }
          afterQuote = false;
          inQuotes = false;
        }
        if (inQuotes) {
          if (char === '"') afterQuote = true;
          else field += char;
          continue;
        }
        if (char === '"') {
          inQuotes = true;
        } else if (char === ",") {
          row.push(field);
          field = "";
        } else if (char === "\n" || char === "\r") {
          if (char === "\r") skipLf = true;
          yield finishRow();
        } else {
          field += char;
        }
      }
    }
  } catch (err) {
    throw streamError(sourcePath, err);
  }

  if (afterQuote) inQuotes = false;
  if (inQuotes) {
    throw new AutoEmbedError(
      `Failed to parse ${path.basename(sourcePath)} as CSV: unterminated quoted field`,
      ExitCode.Parser,
    );
  }
  if (field.length > 0 || row.length > 0) yield finishRow();
}

function streamError(sourcePath: string, err: unknown): AutoEmbedError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
  }
  return new AutoEmbedError(
    `Failed to stream ${sourcePath}: ${(err as Error).message}`,
    ExitCode.Parser,
  );
}
