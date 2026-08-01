import { DEFAULT_SEPARATORS, recursiveSplit, TokenCounter } from "./recursive.js";

interface ProtectedBlock {
  marker: string;
  text: string;
}

/**
 * Markdown chunker. The parser has already split the document into
 * header-keyed sections, so here we only need to further split sections that
 * exceed `chunkSize` tokens — preferring markdown-aware separators
 * (header boundaries, blank lines, sentences) over raw whitespace.
 */
export function splitMarkdownSection(
  text: string,
  opts: { chunkSize: number; overlap: number; countTokens: TokenCounter },
): string[] {
  if (opts.countTokens(text) <= opts.chunkSize) return [text];

  const protectedMarkdown = protectFencedCodeBlocks(text);
  const restore = fencedCodeBlockRestorer(protectedMarkdown.blocks);
  const chunks = recursiveSplit(protectedMarkdown.text, {
    separators: DEFAULT_SEPARATORS.markdown!,
    chunkSize: opts.chunkSize,
    overlap: opts.overlap,
    // Count each marker as the original block. This lets normal chunk-size
    // decisions continue to work while making the block itself indivisible.
    countTokens: (candidate) => opts.countTokens(restore(candidate)),
  });
  return chunks.map(restore);
}

/**
 * Replace fenced Markdown code blocks with single-code-point markers before
 * recursive splitting. Character-level fallback can therefore never cut a
 * block in half. A block larger than chunkSize is intentionally emitted as a
 * single oversized chunk rather than corrupted.
 *
 * Both backtick and tilde fences are supported, regardless of the info string
 * (`json`, `ts`, `python`, etc.). An unclosed fence protects through EOF.
 */
function protectFencedCodeBlocks(text: string): {
  text: string;
  blocks: ProtectedBlock[];
} {
  const ranges = fencedCodeBlockRanges(text);
  if (ranges.length === 0) return { text, blocks: [] };

  const blocks: ProtectedBlock[] = [];
  let protectedText = "";
  let cursor = 0;
  let markerCodePoint = 0xf0000;
  const unavailableMarkers = new Set<string>();
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xf0000 && codePoint <= 0xffffd) {
      unavailableMarkers.add(character);
    }
  }

  for (const range of ranges) {
    protectedText += text.slice(cursor, range.start);
    while (markerCodePoint <= 0xffffd) {
      const candidate = String.fromCodePoint(markerCodePoint++);
      if (!unavailableMarkers.has(candidate)) {
        const block = { marker: candidate, text: text.slice(range.start, range.end) };
        blocks.push(block);
        protectedText += block.marker;
        break;
      }
    }
    cursor = range.end;
  }

  // The supplementary private-use area has 65,534 code points. Falling back
  // to the original text is safer than risking content loss in an implausibly
  // large document with more distinct fenced blocks than that.
  if (blocks.length !== ranges.length) return { text, blocks: [] };
  protectedText += text.slice(cursor);
  return { text: protectedText, blocks };
}

function fencedCodeBlockRestorer(blocks: ProtectedBlock[]): (text: string) => string {
  if (blocks.length === 0) return (text) => text;
  const byMarker = new Map(blocks.map((block) => [block.marker, block.text]));
  const markerPattern = /[\u{F0000}-\u{FFFFD}]/gu;
  return (text) => text.replace(markerPattern, (marker) => byMarker.get(marker) ?? marker);
}

function fencedCodeBlockRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  let open: { start: number; character: "`" | "~"; length: number } | null = null;

  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const rawLine = text.slice(offset, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (open) {
      if (isClosingFence(line, open.character, open.length)) {
        ranges.push({ start: open.start, end: lineEnd });
        open = null;
      }
    } else {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) {
        const fence = match[1]!;
        const character = fence[0] as "`" | "~";
        const info = match[2]!;
        // CommonMark does not allow a backtick in a backtick fence's info
        // string. Enforcing that avoids treating inline backticks as a fence.
        if (character === "~" || !info.includes("`")) {
          open = { start: offset, character, length: fence.length };
        }
      }
    }

    if (newline === -1) break;
    offset = newline + 1;
  }

  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function isClosingFence(line: string, character: "`" | "~", minimumLength: number): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
  return Boolean(
    match &&
    match[1]![0] === character &&
    match[1]!.length >= minimumLength,
  );
}
