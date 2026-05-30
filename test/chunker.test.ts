import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHUNKER_VERSION,
  chunkDocument,
  chunkId,
} from "../src/chunker/index.js";
import { countTokensSync, primeTokenizer } from "../src/chunker/tokens.js";
import {
  DEFAULT_SEPARATORS,
  recursiveSplit,
} from "../src/chunker/recursive.js";
import { parseFile } from "../src/parsers/index.js";
import { heuristicPlan } from "../src/plan/heuristic.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fx = (name: string) => path.join(here, "fixtures", "parsers", name);

describe("chunkId determinism", () => {
  it("is stable for the same (path, index, text)", () => {
    const a = chunkId("/a/b.md", 3, "hello world");
    const b = chunkId("/a/b.md", 3, "hello world");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("changes when any input changes", () => {
    const base = chunkId("/a/b.md", 3, "hello world");
    expect(chunkId("/a/c.md", 3, "hello world")).not.toBe(base);
    expect(chunkId("/a/b.md", 4, "hello world")).not.toBe(base);
    expect(chunkId("/a/b.md", 3, "hello world!")).not.toBe(base);
  });

  it("uses CHUNKER_VERSION in the hash", () => {
    expect(CHUNKER_VERSION).toBe("1");
  });
});

describe("recursiveSplit", () => {
  const fakeTokens = (s: string) => s.length;

  it("returns one chunk when text fits within chunkSize", () => {
    const out = recursiveSplit("hello world", {
      separators: DEFAULT_SEPARATORS.recursive!,
      chunkSize: 100,
      overlap: 0,
      countTokens: fakeTokens,
    });
    expect(out).toEqual(["hello world"]);
  });

  it("prefers coarser separators first", () => {
    const text = "para1.\n\npara2.\n\npara3.";
    const out = recursiveSplit(text, {
      separators: DEFAULT_SEPARATORS.recursive!,
      chunkSize: 8,
      overlap: 0,
      countTokens: fakeTokens,
    });
    expect(out.every((c) => c.length <= 12)).toBe(true);
    expect(out.join(" ")).toContain("para1");
    expect(out.join(" ")).toContain("para3");
  });

  it("recurses to finer separators when one paragraph is too big", () => {
    const longLine = "a ".repeat(60).trim();
    const out = recursiveSplit(longLine, {
      separators: DEFAULT_SEPARATORS.recursive!,
      chunkSize: 20,
      overlap: 0,
      countTokens: fakeTokens,
    });
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  it("emits empty array for empty input", () => {
    expect(
      recursiveSplit("", {
        separators: DEFAULT_SEPARATORS.recursive!,
        chunkSize: 10,
        overlap: 0,
        countTokens: fakeTokens,
      }),
    ).toEqual([]);
  });

  it("produces overlap-carrying chunks (last fragments persist)", () => {
    // Sentences separated by ". " — chunkSize 10 forces re-emit; we want to
    // see that the carry mechanism does NOT exceed chunkSize.
    const text = "alpha. beta. gamma. delta. epsilon. zeta.";
    const out = recursiveSplit(text, {
      separators: [". ", " ", ""],
      chunkSize: 12,
      overlap: 4,
      countTokens: fakeTokens,
    });
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(14);
    }
    expect(out.join(" ")).toContain("alpha");
    expect(out.join(" ")).toContain("zeta");
  });
});

describe("chunkDocument", () => {
  it("produces deterministic chunk IDs across two runs", async () => {
    const doc = await parseFile(fx("sample.md"));
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
    });
    const a = await chunkDocument(doc, plan);
    const b = await chunkDocument(doc, plan);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a.map((c) => c.text)).toEqual(b.map((c) => c.text));
  });

  it("emits one chunk per markdown section for the small fixture", async () => {
    const doc = await parseFile(fx("sample.md"));
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
    });
    const chunks = await chunkDocument(doc, plan);
    expect(chunks).toHaveLength(8);
    expect(chunks[0]!.meta.headerPath).toEqual(["Onboarding Handbook"]);
    expect(chunks[2]!.meta.headerPath).toEqual([
      "Onboarding Handbook",
      "Setup",
      "Toolchain",
    ]);
  });

  it("passes csv rows through one-to-one (no recursive split)", async () => {
    const doc = await parseFile(fx("sample.csv"));
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
    });
    const chunks = await chunkDocument(doc, plan);
    expect(chunks).toHaveLength(10);
    expect(chunks[0]!.meta.row).toBe(1);
    expect(chunks[9]!.meta.row).toBe(10);
  });

  it("preserves pageNumber meta for pdf chunks", async () => {
    const doc = await parseFile(fx("sample.pdf"));
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
    });
    const chunks = await chunkDocument(doc, plan);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.meta.pageNumber)).toEqual([1, 2, 3]);
    expect(chunks.every((c) => c.meta.pageCount === 3)).toBe(true);
  });

  it("monotonically assigns chunkIndex across all sections", async () => {
    const doc = await parseFile(fx("sample.md"));
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
    });
    const chunks = await chunkDocument(doc, plan);
    chunks.forEach((c, i) => expect(c.meta.chunkIndex).toBe(i));
  });

  it("splits oversized text into multiple chunks", async () => {
    const doc = await parseFile(fx("sample.txt"));
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
      overrides: { chunkSize: 50, overlap: 10 },
    });
    const chunks = await chunkDocument(doc, plan);
    expect(chunks.length).toBeGreaterThan(3);
    await primeTokenizer();
    for (const chunk of chunks) {
      expect(countTokensSync(chunk.text)).toBeLessThanOrEqual(60);
    }
  });

  it("attaches plan.metadata to every chunk", async () => {
    const doc = await parseFile(fx("sample.md"));
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
      overrides: { metadata: { project: "alpha", owner: "ada" } },
    });
    const chunks = await chunkDocument(doc, plan);
    for (const chunk of chunks) {
      expect(chunk.meta.project).toBe("alpha");
      expect(chunk.meta.owner).toBe("ada");
    }
  });
});
