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
import { splitMarkdownSection } from "../src/chunker/markdown.js";
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
    expect(CHUNKER_VERSION).toBe("4");
  });
});

describe("splitMarkdownSection", () => {
  const fakeTokens = (text: string) => text.length;

  it("splits oversized indented JSON fences into valid, contextual JSON excerpts", async () => {
    const values = Array.from({ length: 12 }, (_, index) => ({
      name: `field-${index}`,
      type: "text",
      required: index % 2 === 0,
    }));
    const indentedJson = [
      "    ```json expandable",
      ...JSON.stringify(values, null, 2).split("\n").map((line) => `    ${line}`),
      "    ```",
    ].join("\n");
    const text = `### v1\n\n${indentedJson}`;
    const chunks = await splitMarkdownSection(text, {
      chunkSize: 220,
      overlap: 0,
      countTokens: fakeTokens,
      headerPath: ["Guide", "Fields", "v1"],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("# Guide\n\n## Fields\n\n### v1"))).toBe(true);
    const jsonBodies = chunks.flatMap((chunk) =>
      [...chunk.matchAll(/```json expandable\n([\s\S]*?)\n```/g)].map((match) => match[1]!),
    );
    expect(jsonBodies.length).toBeGreaterThan(1);
    for (const body of jsonBodies) expect(() => JSON.parse(body)).not.toThrow();
    expect(chunks.every((chunk) => (chunk.match(/^```/gm)?.length ?? 0) % 2 === 0)).toBe(true);
  });

  it("re-fences oversized code excerpts instead of emitting an oversized block", async () => {
    const code = [
      "~~~typescript",
      ...Array.from({ length: 18 }, (_, index) => `export const value${index} = ${index};`),
      "~~~",
    ].join("\n");
    const chunks = await splitMarkdownSection(`Before.\n\n${code}\n\nAfter.`, {
      chunkSize: 140,
      overlap: 0,
      countTokens: fakeTokens,
    });

    const excerpts = chunks.filter((chunk) => chunk.includes("Code excerpt (typescript)"));
    expect(excerpts.length).toBeGreaterThan(1);
    expect(excerpts.every((chunk) => (chunk.match(/^```/gm)?.length ?? 0) === 2)).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 140)).toBe(true);
  });

  it("closes and safely divides an unclosed source fence", async () => {
    const unfinishedSource = [
      "Prose before the example.",
      "",
      "```python",
      "def greet(name):",
      '    return f"Hello, {name}"',
      "# the Markdown source itself forgot its closing fence",
    ].join("\n");
    const chunks = await splitMarkdownSection(unfinishedSource, {
      chunkSize: 100,
      overlap: 0,
      countTokens: fakeTokens,
    });

    const reconstructed = chunks
      .flatMap((chunk) => [...chunk.matchAll(/```python\n([\s\S]*?)\n```/g)].map((match) => match[1]!))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(reconstructed).toContain("# the Markdown source itself forgot its closing fence");
    expect(chunks.every((chunk) => (chunk.match(/^```/gm)?.length ?? 0) % 2 === 0)).toBe(true);
  });

  it("hard-splits a single enormous JSON scalar into bounded valid JSON excerpts", async () => {
    const text = `\`\`\`json\n${JSON.stringify({ payload: "x".repeat(4_000) })}\n\`\`\``;
    const chunks = await splitMarkdownSection(text, {
      chunkSize: 180,
      overlap: 0,
      countTokens: fakeTokens,
    });

    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true);
    expect(chunks.every((chunk) => chunk.includes("JSON excerpt:"))).toBe(true);
    for (const chunk of chunks) {
      const body = /```json\n([\s\S]*?)\n```/.exec(chunk)?.[1];
      expect(body).toBeDefined();
      expect(() => JSON.parse(body!)).not.toThrow();
    }
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

  it("hard-limits a pathological single JSONL record", async () => {
    const doc = {
      sourcePath: "captured.jsonl",
      contentType: "json" as const,
      sections: [{ text: JSON.stringify({ payload: "x".repeat(1_000) }), meta: { line: 1 } }],
    };
    const plan = heuristicPlan({
      sourcePath: doc.sourcePath,
      embeddingModel: "text-embedding-3-small",
      overrides: { chunkSize: 100, overlap: 0 },
    });
    const chunks = await chunkDocument(doc, plan);

    expect(chunks.length).toBeGreaterThan(1);
    await primeTokenizer();
    expect(chunks.every((chunk) => countTokensSync(chunk.text) <= 100)).toBe(true);
  });
});
