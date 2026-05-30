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

  const tree = unified().use(remarkParse).parse(raw) as {
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
    const text = raw.slice(currentStart, endOffset).trim();
    if (!text) return;
    sections.push({
      text,
      meta: {
        headerPath: [...currentHeaderPath],
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
        const preamble = raw.slice(0, node.position.start.offset).trim();
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
    const trimmed = raw.trim();
    if (trimmed) sections.push({ text: trimmed, meta: { headerPath: [], headerDepth: 0 } });
  }

  return sections;
}
