import { EvalChunk } from "./types.js";

export interface RankedScore {
  chunkId: string;
  score: number;
}

export function rankLexicalTfidf(query: string, chunks: readonly EvalChunk[]): RankedScore[] {
  const tokenized = chunks.map((chunk) => tokenize(chunk.text));
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const queryVector = vectorize(tokenize(query), documentFrequency, chunks.length);
  return chunks
    .map((chunk, index) => ({
      chunkId: chunk.id,
      score: cosine(
        queryVector,
        vectorize(tokenized[index]!, documentFrequency, chunks.length),
      ),
    }))
    .sort((a, b) => b.score - a.score || compareText(a.chunkId, b.chunkId));
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => !STOP_WORDS.has(token),
  );
}

function vectorize(
  tokens: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const vector = new Map<string, number>();
  for (const [token, count] of counts) {
    const idf = Math.log((documentCount + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
    vector.set(token, (1 + Math.log(count)) * idf);
  }
  return vector;
}

function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of a.values()) normA += value * value;
  for (const value of b.values()) normB += value * value;
  for (const [token, value] of a) dot += value * (b.get(token) ?? 0);
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "the", "to", "what", "when", "which", "with",
]);
