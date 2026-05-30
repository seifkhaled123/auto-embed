import { DEFAULT_SEPARATORS, recursiveSplit, TokenCounter } from "./recursive.js";

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
  return recursiveSplit(text, {
    separators: DEFAULT_SEPARATORS.markdown!,
    chunkSize: opts.chunkSize,
    overlap: opts.overlap,
    countTokens: opts.countTokens,
  });
}
