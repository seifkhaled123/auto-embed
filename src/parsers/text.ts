import fsp from "node:fs/promises";
import path from "node:path";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { ParsedDocument, ParsedSection } from "./types.js";

export async function parseText(sourcePath: string): Promise<ParsedDocument> {
  const text = await readFile(sourcePath);
  return {
    sourcePath,
    contentType: "text",
    sections: [{ text, meta: {} }],
  };
}

export async function parseJson(sourcePath: string): Promise<ParsedDocument> {
  const raw = await readFile(sourcePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to parse ${path.basename(sourcePath)} as JSON: ${(err as Error).message}`,
      ExitCode.Parser,
      "Check the file with `jq . <path>` or validate the structure.",
    );
  }

  const sections: ParsedSection[] = [];
  if (Array.isArray(parsed)) {
    parsed.forEach((value, index) => {
      sections.push({
        text: stringifyValue(value),
        meta: { keyPath: `[${index}]`, index },
      });
    });
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      sections.push({
        text: stringifyValue(value),
        meta: { keyPath: key },
      });
    }
  } else {
    sections.push({ text: stringifyValue(parsed), meta: {} });
  }

  return { sourcePath, contentType: "json", sections };
}

export async function parseJsonl(sourcePath: string): Promise<ParsedDocument> {
  const raw = await readFile(sourcePath);
  const lines = raw.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new AutoEmbedError(
        `Failed to parse line ${idx + 1} of ${path.basename(sourcePath)} as JSON: ${(err as Error).message}`,
        ExitCode.Parser,
      );
    }
    sections.push({
      text: stringifyValue(parsed),
      meta: { line: idx + 1 },
    });
  });
  return { sourcePath, contentType: "json", sections };
}

export async function parseCsv(sourcePath: string): Promise<ParsedDocument> {
  const raw = await readFile(sourcePath);
  const rows = parseCsvRows(raw);
  if (rows.length === 0) {
    return { sourcePath, contentType: "csv", sections: [] };
  }
  const header = rows[0]!;
  const sections: ParsedSection[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length === 1 && row[0] === "") continue;
    const obj: Record<string, string> = {};
    header.forEach((col, ci) => {
      obj[col] = row[ci] ?? "";
    });
    const text = header.map((col) => `${col}: ${obj[col]}`).join("\n");
    sections.push({ text, meta: { row: i, columns: obj } });
  }
  return { sourcePath, contentType: "csv", sections };
}

const CODE_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

export async function parseCode(sourcePath: string): Promise<ParsedDocument> {
  const text = await readFile(sourcePath);
  const ext = path.extname(sourcePath).toLowerCase();
  const language = CODE_LANG[ext] ?? "unknown";
  return {
    sourcePath,
    contentType: "code",
    sections: [{ text, meta: { language } }],
  };
}

// ---------- helpers ----------

async function readFile(sourcePath: string): Promise<string> {
  try {
    return await fsp.readFile(sourcePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields, embedded commas,
 * embedded newlines inside quotes, and "" → " escapes. No streaming — fine for
 * v1 files; revisit when ingesting CSVs over 100 MB.
 */
export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && input[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
