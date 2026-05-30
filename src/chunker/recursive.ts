/**
 * Token-aware recursive character splitter. A port of the algorithm in
 * LangChain's RecursiveCharacterTextSplitter, intentionally kept tiny so we
 * can drop the langchain dependency entirely.
 *
 * Tries `separators` in order; the first one present in the text wins. Splits
 * by that separator, then merges adjacent fragments back into chunks no
 * larger than `chunkSize` tokens, with `overlap` tokens of trailing context
 * carried into the next chunk. Any single fragment that already exceeds
 * `chunkSize` recurses with the remaining separators.
 */

export type TokenCounter = (text: string) => number;

export interface RecursiveOpts {
  separators: string[];
  chunkSize: number;
  overlap: number;
  countTokens: TokenCounter;
}

export function recursiveSplit(text: string, opts: RecursiveOpts): string[] {
  if (text === "") return [];
  return splitOn(text, opts.separators, opts);
}

function splitOn(text: string, separators: string[], opts: RecursiveOpts): string[] {
  const { chunkSize, overlap, countTokens } = opts;

  // Pick the best separator: the first one in the list that actually appears
  // in the text. Empty string is the last-ditch character-level fallback.
  let separator = separators[separators.length - 1] ?? "";
  let nextSeparators: string[] = [];
  for (let i = 0; i < separators.length; i++) {
    const s = separators[i]!;
    if (s === "") {
      separator = "";
      nextSeparators = [];
      break;
    }
    if (text.indexOf(s) !== -1) {
      separator = s;
      nextSeparators = separators.slice(i + 1);
      break;
    }
  }

  const splits = separator === "" ? Array.from(text) : text.split(separator);

  const out: string[] = [];
  const goodSplits: string[] = [];
  for (const part of splits) {
    if (countTokens(part) < chunkSize) {
      goodSplits.push(part);
      continue;
    }
    if (goodSplits.length > 0) {
      out.push(...mergeSplits(goodSplits, separator, chunkSize, overlap, countTokens));
      goodSplits.length = 0;
    }
    if (nextSeparators.length === 0) {
      // No finer separator: keep the oversized fragment rather than corrupt it.
      out.push(part);
    } else {
      out.push(...splitOn(part, nextSeparators, opts));
    }
  }
  if (goodSplits.length > 0) {
    out.push(...mergeSplits(goodSplits, separator, chunkSize, overlap, countTokens));
  }
  return out;
}

function mergeSplits(
  splits: string[],
  separator: string,
  chunkSize: number,
  overlap: number,
  countTokens: TokenCounter,
): string[] {
  const sepLen = countTokens(separator);
  const out: string[] = [];
  const current: string[] = [];
  let total = 0;
  for (const part of splits) {
    const partLen = countTokens(part);
    const sepHere = current.length > 0 ? sepLen : 0;
    if (total + partLen + sepHere > chunkSize) {
      if (current.length > 0) {
        const joined = joinDocs(current, separator);
        if (joined !== null) out.push(joined);
        while (
          total > overlap ||
          (total + partLen + (current.length > 0 ? sepLen : 0) > chunkSize && total > 0)
        ) {
          const head = current.shift();
          if (head === undefined) break;
          total -= countTokens(head) + (current.length > 0 ? sepLen : 0);
        }
      }
    }
    current.push(part);
    total += partLen + (current.length > 1 ? sepLen : 0);
  }
  const joined = joinDocs(current, separator);
  if (joined !== null) out.push(joined);
  return out;
}

function joinDocs(docs: string[], separator: string): string | null {
  const text = docs.join(separator).trim();
  return text === "" ? null : text;
}

export const DEFAULT_SEPARATORS: Record<string, string[]> = {
  recursive: ["\n\n", "\n", ". ", " ", ""],
  markdown: ["\n## ", "\n### ", "\n#### ", "\n\n", "\n", ". ", " ", ""],
  html: ["\n\n", "\n", ". ", " ", ""],
  // Code separators come from chunker/code.ts (language-tuned).
};
