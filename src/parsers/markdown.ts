import fsp from "node:fs/promises";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { ParsedDocument, ParsedSection } from "./types.js";

export async function parseMarkdown(sourcePath: string): Promise<ParsedDocument> {
  const raw = await fsp.readFile(sourcePath, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  });

  return {
    sourcePath,
    contentType: "markdown",
    sections: await splitMarkdownByHeaders(raw),
  };
}

/**
 * Split markdown into sections keyed by header path. A new section begins at
 * every H1/H2/H3; H4–H6 stay within their parent section. Each section's text
 * is a slice of the original markdown source so the downstream chunker can
 * further split it without losing formatting.
 *
 * Exported for the docx parser, which converts to markdown via mammoth then
 * reuses this splitter.
 */
export async function splitMarkdownByHeaders(raw: string): Promise<ParsedSection[]> {
  const { unified } = await import("unified");
  const remarkParse = (await import("remark-parse")).default;
  const { toString: mdastToString } = await import("mdast-util-to-string");

  const frontmatterRanges = markdownFrontmatterRanges(raw);
  const parseable = maskRanges(raw, frontmatterRanges);
  const tree = unified().use(remarkParse).parse(parseable) as {
    children: Array<{
      type: string;
      depth?: number;
      position?: { start: { offset: number }; end: { offset: number } };
    }>;
  };

  const SECTION_DEPTHS = new Set([1, 2, 3]);
  const sections: ParsedSection[] = [];
  let currentHeaderPath: string[] = [];
  let currentDepth: number | null = null;
  let currentStart: number | null = null;
  let leadingEnd: number | null = null;

  const pushSection = (endOffset: number) => {
    if (currentStart === null) return;
    const text = sliceWithoutRanges(raw, currentStart, endOffset, frontmatterRanges).trim();
    if (!text) return;
    sections.push({
      text,
      meta: {
        headerPath: currentHeaderPath.filter(
          (header): header is string => typeof header === "string" && header.trim() !== "",
        ),
        headerDepth: currentDepth ?? 0,
      },
    });
  };

  for (const node of tree.children) {
    if (
      node.type === "heading" &&
      node.depth !== undefined &&
      SECTION_DEPTHS.has(node.depth) &&
      node.position
    ) {
      if (currentStart !== null) {
        pushSection(node.position.start.offset);
      } else if (leadingEnd === null && node.position.start.offset > 0) {
        const preamble = sliceWithoutRanges(
          raw,
          0,
          node.position.start.offset,
          frontmatterRanges,
        ).trim();
        if (preamble) {
          sections.push({ text: preamble, meta: { headerPath: [], headerDepth: 0 } });
        }
        leadingEnd = node.position.start.offset;
      }
      const title = mdastToString(node as Parameters<typeof mdastToString>[0]).trim();
      const depth = node.depth;
      currentHeaderPath = currentHeaderPath.slice(0, depth - 1);
      currentHeaderPath[depth - 1] = title;
      currentDepth = depth;
      currentStart = node.position.start.offset;
    }
  }

  if (currentStart !== null) {
    pushSection(raw.length);
  } else if (sections.length === 0) {
    const trimmed = sliceWithoutRanges(raw, 0, raw.length, frontmatterRanges).trim();
    if (trimmed) sections.push({ text: trimmed, meta: { headerPath: [], headerDepth: 0 } });
  }

  if (
    sections.length > 1 &&
    Array.isArray(sections[0]!.meta.headerPath) &&
    (sections[0]!.meta.headerPath as unknown[]).length === 0
  ) {
    const preamble = sections.shift()!;
    sections[0]!.text = insertPreambleAfterHeading(sections[0]!.text, preamble.text);
  }

  // A parent heading immediately followed by a child heading has no content
  // of its own. Its breadcrumb is already carried by every child section, so
  // emitting it separately creates a low-value header-only chunk.
  return sections.filter((section) => !/^#{1,6}[\t ]+[^\n]+$/.test(section.text.trim()));
}

function markdownFrontmatterRanges(raw: string): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf("\n", offset);
    const end = newline === -1 ? raw.length : newline + 1;
    lines.push({ start: offset, end, text: raw.slice(offset, newline === -1 ? raw.length : newline).replace(/\r$/, "") });
    if (newline === -1) break;
    offset = newline + 1;
  }

  const firstHeading = lines.findIndex((line) => /^#{1,3}[\t ]+/.test(line.text));
  const searchEnd = firstHeading === -1 ? lines.length : firstHeading;
  for (let index = 0; index < searchEnd; index++) {
    if (lines[index]!.text.trim() !== "---") continue;
    for (let closing = index + 2; closing < searchEnd; closing++) {
      if (!["---", "..."].includes(lines[closing]!.text.trim())) continue;
      const body = lines.slice(index + 1, closing).map((line) => line.text);
      const significant = body.filter((line) => line.trim() !== "");
      const hasKey = significant.some((line) => /^[A-Za-z_][\w.-]*[\t ]*:/.test(line.trim()));
      const looksLikeYaml = significant.every((line) =>
        /^[A-Za-z_][\w.-]*[\t ]*:/.test(line.trim()) ||
        /^[\t ]+/.test(line) ||
        /^[\t ]*[-#]/.test(line),
      );
      if (hasKey && looksLikeYaml) {
        return [{ start: lines[index]!.start, end: lines[closing]!.end }];
      }
      break;
    }
  }
  return [];
}

function maskRanges(raw: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return raw;
  const characters = raw.split("");
  // Work in UTF-16 code units, matching mdast offsets. Preserve newlines so
  // every heading and code-node position remains stable.
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index++) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return characters.join("");
}

function sliceWithoutRanges(
  raw: string,
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): string {
  let result = "";
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) continue;
    result += raw.slice(cursor, Math.max(cursor, range.start));
    cursor = Math.min(end, range.end);
  }
  return result + raw.slice(cursor, end);
}

function insertPreambleAfterHeading(section: string, preamble: string): string {
  const match = /^(#{1,3}[\t ]+[^\n]*)(?:\r?\n|$)/.exec(section);
  if (!match) return `${preamble}\n\n${section}`;
  const body = section.slice(match[0].length).trimStart();
  return [match[1], preamble, body].filter(Boolean).join("\n\n");
}
