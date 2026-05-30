import { describe, expect, it } from "vitest";
import { heuristicPlan, deriveCollectionName } from "../src/plan/heuristic.js";
import { canonicalJson, hashPlan } from "../src/plan/schema.js";

describe("heuristicPlan", () => {
  it("maps markdown extension to markdown splitter", () => {
    const plan = heuristicPlan({
      sourcePath: "/x/handbook.md",
      embeddingModel: "text-embedding-3-small",
    });
    expect(plan.splitter).toBe("markdown");
    expect(plan.chunkSize).toBe(800);
    expect(plan.overlap).toBe(100);
    expect(plan.embeddingModel).toBe("text-embedding-3-small");
    expect(plan.collection).toBe("handbook");
  });

  it("maps pdf, html, docx, csv, jsonl, code", () => {
    expect(heuristicPlan({ sourcePath: "x.pdf", embeddingModel: "m" }).splitter).toBe("pdf");
    expect(heuristicPlan({ sourcePath: "x.html", embeddingModel: "m" }).splitter).toBe("html");
    expect(heuristicPlan({ sourcePath: "x.docx", embeddingModel: "m" }).splitter).toBe(
      "markdown",
    );
    expect(heuristicPlan({ sourcePath: "x.csv", embeddingModel: "m" }).splitter).toBe("csv");
    expect(heuristicPlan({ sourcePath: "x.jsonl", embeddingModel: "m" }).splitter).toBe(
      "jsonl",
    );
    expect(heuristicPlan({ sourcePath: "x.ts", embeddingModel: "m" }).splitter).toBe("code");
    expect(heuristicPlan({ sourcePath: "x.py", embeddingModel: "m" }).splitter).toBe("code");
  });

  it("falls back to recursive for unknown extensions", () => {
    expect(heuristicPlan({ sourcePath: "x.xyz", embeddingModel: "m" }).splitter).toBe(
      "recursive",
    );
  });

  it("gives csv/jsonl a larger chunk-size cap (row-sized chunks)", () => {
    expect(heuristicPlan({ sourcePath: "x.csv", embeddingModel: "m" }).chunkSize).toBe(4096);
    expect(heuristicPlan({ sourcePath: "x.jsonl", embeddingModel: "m" }).chunkSize).toBe(
      4096,
    );
  });

  it("respects overrides", () => {
    const plan = heuristicPlan({
      sourcePath: "x.md",
      embeddingModel: "m",
      overrides: {
        chunkSize: 256,
        overlap: 32,
        collection: "custom",
        metadata: { team: "x" },
      },
    });
    expect(plan.chunkSize).toBe(256);
    expect(plan.overlap).toBe(32);
    expect(plan.collection).toBe("custom");
    expect(plan.metadata).toEqual({ team: "x" });
  });

  it("rejects invalid collection names", () => {
    expect(() =>
      heuristicPlan({
        sourcePath: "x.md",
        embeddingModel: "m",
        overrides: { collection: "Has Spaces" },
      }),
    ).toThrow();
  });
});

describe("deriveCollectionName", () => {
  it("kebab-cases and lowercases", () => {
    expect(deriveCollectionName("Onboarding Handbook.PDF")).toBe("onboarding-handbook");
  });

  it("strips leading non-alphanumeric chars", () => {
    expect(deriveCollectionName("__weird--name.md")).toBe("weird--name");
  });

  it("falls back to 'default' for empty results", () => {
    expect(deriveCollectionName("---.md")).toBe("default");
  });
});

describe("canonicalJson + hashPlan", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it("serializes arrays in order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("produces identical plan hashes regardless of key insertion order", () => {
    const a = hashPlan({
      version: 1,
      splitter: "markdown",
      chunkSize: 800,
      overlap: 100,
      metadata: { b: "2", a: "1" },
      collection: "c",
      embeddingModel: "m",
    });
    const b = hashPlan({
      embeddingModel: "m",
      collection: "c",
      metadata: { a: "1", b: "2" },
      overlap: 100,
      chunkSize: 800,
      splitter: "markdown",
      version: 1,
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("changes when any plan field changes", () => {
    const base = hashPlan({
      version: 1,
      splitter: "markdown",
      chunkSize: 800,
      overlap: 100,
      metadata: {},
      collection: "c",
      embeddingModel: "m",
    });
    const other = hashPlan({
      version: 1,
      splitter: "markdown",
      chunkSize: 800,
      overlap: 101, // changed
      metadata: {},
      collection: "c",
      embeddingModel: "m",
    });
    expect(other).not.toBe(base);
  });
});
