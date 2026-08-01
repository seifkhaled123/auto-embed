import crypto from "node:crypto";
import { ParsedDocument, ParsedSection, ParsedSource } from "../parsers/types.js";
import { EmbedPlan } from "../plan/schema.js";
import { separatorsForLanguage } from "./code.js";
import { splitMarkdownSection } from "./markdown.js";
import { DEFAULT_SEPARATORS, recursiveSplit, TokenCounter } from "./recursive.js";
import { countTokensSync, primeTokenizer } from "./tokens.js";

/** Bump on ANY chunker algorithm change. Invalidates all lockfiles. */
export const CHUNKER_VERSION = "3";

export interface Chunk {
  id: string;
  text: string;
  meta: Record<string, unknown>;
}

export async function chunkDocument(
  document: ParsedDocument,
  plan: EmbedPlan,
): Promise<Chunk[]> {
  const out: Chunk[] = [];
  const source: ParsedSource = {
    sourcePath: document.sourcePath,
    contentType: document.contentType,
    mode: "sections",
    async *sections() {
      for (const section of document.sections) yield section;
    },
  };
  for await (const chunk of chunkSource(source, plan)) out.push(chunk);
  return out;
}

export async function* chunkSource(
  source: ParsedSource,
  plan: EmbedPlan,
): AsyncGenerator<Chunk> {
  await primeTokenizer();
  const countTokens = cachedTokenCounter(countTokensSync);
  if (source.mode === "stream-text") {
    yield* chunkStreamingText(source, plan, countTokens);
    return;
  }

  let sectionIndex = 0;
  let chunkIndex = 0;
  for await (const section of source.sections()) {
    const document = documentShape(source);
    const pieces = splitSection(section, document, plan, countTokens);
    let chunkInSection = 0;
    for (const text of pieces) {
      const chunk = createChunk(
        source,
        plan,
        section.meta,
        sectionIndex,
        chunkInSection,
        chunkIndex,
        text,
      );
      if (!chunk) continue;
      yield chunk;
      chunkInSection++;
      chunkIndex++;
    }
    sectionIndex++;
  }
}

async function* chunkStreamingText(
  source: ParsedSource,
  plan: EmbedPlan,
  countTokens: TokenCounter,
): AsyncGenerator<Chunk> {
  let buffer = "";
  let baseMeta: Record<string, unknown> = {};
  let chunkIndex = 0;
  const flushAtChars = Math.max(plan.chunkSize * 8, 4096);

  for await (const section of source.sections()) {
    baseMeta = { ...baseMeta, ...section.meta };
    buffer += section.text;
    if (buffer.length < flushAtChars) continue;

    const pieces = splitStreamingBuffer(buffer, baseMeta, source, plan, countTokens);
    if (pieces.length < 2) continue;
    const carry = pieces.pop() ?? "";
    for (const piece of pieces) {
      const chunk = createChunk(source, plan, baseMeta, 0, chunkIndex, chunkIndex, piece);
      if (!chunk) continue;
      yield chunk;
      chunkIndex++;
    }
    buffer = carry;
  }

  for (const piece of splitStreamingBuffer(buffer, baseMeta, source, plan, countTokens)) {
    const chunk = createChunk(source, plan, baseMeta, 0, chunkIndex, chunkIndex, piece);
    if (!chunk) continue;
    yield chunk;
    chunkIndex++;
  }
}

function splitStreamingBuffer(
  text: string,
  meta: Record<string, unknown>,
  source: ParsedSource,
  plan: EmbedPlan,
  countTokens: TokenCounter,
): string[] {
  if (!text) return [];
  const effectivePlan = plan.splitter === "csv" || plan.splitter === "jsonl"
    ? { ...plan, splitter: "recursive" as const }
    : plan;
  return splitSection(
    { text, meta },
    documentShape(source),
    effectivePlan,
    countTokens,
  );
}

function cachedTokenCounter(base: TokenCounter): TokenCounter {
  const cache = new Map<string, number>();
  return (text: string) => {
    if (text.length > 4096) return base(text);
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const count = base(text);
    if (cache.size >= 4096) cache.clear();
    cache.set(text, count);
    return count;
  };
}

function createChunk(
  source: ParsedSource,
  plan: EmbedPlan,
  sectionMeta: Record<string, unknown>,
  sectionIndex: number,
  chunkInSection: number,
  chunkIndex: number,
  text: string,
): Chunk | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const meta: Record<string, unknown> = {
    ...sectionMeta,
    ...plan.metadata,
    sectionIndex,
    chunkInSection,
    sourcePath: source.sourcePath,
    contentType: source.contentType,
    chunkIndex,
  };
  return {
    id: chunkId(source.sourcePath, chunkIndex, trimmed),
    text: trimmed,
    meta,
  };
}

function documentShape(source: ParsedSource): ParsedDocument {
  return {
    sourcePath: source.sourcePath,
    contentType: source.contentType,
    sections: [],
  };
}

function splitSection(
  section: ParsedSection,
  document: ParsedDocument,
  plan: EmbedPlan,
  countTokens: TokenCounter,
): string[] {
  switch (plan.splitter) {
    case "csv":
    case "jsonl":
      // Parser already emitted one section per row / line — pass through.
      return [section.text];
    case "markdown":
      return splitMarkdownSection(section.text, {
        chunkSize: plan.chunkSize,
        overlap: plan.overlap,
        countTokens,
      });
    case "code": {
      const language = String(section.meta.language ?? "unknown");
      return runRecursive(section.text, separatorsForLanguage(language), plan, countTokens);
    }
    case "html":
      return runRecursive(section.text, DEFAULT_SEPARATORS.html!, plan, countTokens);
    case "pdf":
    case "recursive":
    default:
      return runRecursive(section.text, DEFAULT_SEPARATORS.recursive!, plan, countTokens);
  }
}

function runRecursive(
  text: string,
  separators: string[],
  plan: EmbedPlan,
  countTokens: TokenCounter,
): string[] {
  if (countTokens(text) <= plan.chunkSize) return [text];
  return recursiveSplit(text, {
    separators,
    chunkSize: plan.chunkSize,
    overlap: plan.overlap,
    countTokens,
  });
}

/**
 * Deterministic chunk ID: sha256(sourcePath + index + chunkerVersion + text)[:16].
 * Must not depend on Date.now(), Math.random(), or any other non-content input.
 */
export function chunkId(sourcePath: string, index: number, text: string): string {
  const h = crypto.createHash("sha256");
  h.update(sourcePath);
  h.update("\u0000");
  h.update(String(index));
  h.update("\u0000");
  h.update(CHUNKER_VERSION);
  h.update("\u0000");
  h.update(text);
  return h.digest("hex").slice(0, 16);
}
