import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkSource } from "../src/chunker/index.js";
import {
  parseFile,
  parseSource,
  WHOLE_DOCUMENT_LIMIT_BYTES,
} from "../src/parsers/index.js";
import { ParsedSection } from "../src/parsers/types.js";
import { EmbedPlan } from "../src/plan/schema.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-stream-"));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function plan(splitter: EmbedPlan["splitter"]): EmbedPlan {
  return {
    version: 1,
    splitter,
    chunkSize: 24,
    overlap: 4,
    metadata: { corpus: "stream-test" },
    collection: "stream-test",
    embeddingModel: "fake-model",
  };
}

async function collectSections(sourcePath: string): Promise<ParsedSection[]> {
  const source = await parseSource(sourcePath);
  const sections: ParsedSection[] = [];
  for await (const section of source.sections()) sections.push(section);
  return sections;
}

describe("streaming parser sources", () => {
  it("streams text blocks while parseFile remains array-compatible", async () => {
    const file = path.join(tmp, "large.txt");
    const text = "alpha beta gamma\n".repeat(10_000);
    await fsp.writeFile(file, text);
    const readFile = vi.spyOn(fsp, "readFile");
    try {
      const source = await parseSource(file);
      expect(source.mode).toBe("stream-text");
      const sections: ParsedSection[] = [];
      for await (const section of source.sections()) sections.push(section);
      expect(sections.length).toBeGreaterThan(1);
      expect(sections.map((section) => section.text).join("")).toBe(text);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }

    const document = await parseFile(file);
    expect(document.sections).toHaveLength(1);
    expect(document.sections[0]!.text).toBe(text);
  });

  it("streams JSONL records with stable line metadata", async () => {
    const file = path.join(tmp, "records.jsonl");
    await fsp.writeFile(file, '{"id":1}\n\n{"id":2,"name":"two"}\n');
    const sections = await collectSections(file);
    expect(sections).toEqual([
      { text: '{\n  "id": 1\n}', meta: { line: 1 } },
      { text: '{\n  "id": 2,\n  "name": "two"\n}', meta: { line: 3 } },
    ]);
  });

  it("streams CSV records including quoted newlines", async () => {
    const file = path.join(tmp, "records.csv");
    await fsp.writeFile(file, 'id,note\n1,"line one\nline two"\n2,plain\n');
    const sections = await collectSections(file);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.text).toContain("note: line one\nline two");
    expect(sections[0]!.meta).toEqual({
      row: 1,
      columns: { id: "1", note: "line one\nline two" },
    });
    expect(sections[1]!.meta).toEqual({ row: 2, columns: { id: "2", note: "plain" } });
  });

  it("fails early with guidance when a whole-document parser exceeds its limit", async () => {
    const file = path.join(tmp, "oversized.md");
    await fsp.writeFile(file, "# Oversized\n");
    await fsp.truncate(file, WHOLE_DOCUMENT_LIMIT_BYTES + 1);
    await expect(parseSource(file)).rejects.toMatchObject({
      message: expect.stringMatching(/100 MB whole-document parser limit/i),
      hint: expect.stringMatching(/TXT\/CSV\/JSONL/i),
    });
  });
});

describe("streaming chunker", () => {
  it("produces deterministic IDs without materializing the text source", async () => {
    const file = path.join(tmp, "deterministic.txt");
    await fsp.writeFile(file, "paragraph one has several words.\n\n".repeat(5_000));
    const source = await parseSource(file);

    const first = [];
    for await (const chunk of chunkSource(source, plan("recursive"))) first.push(chunk);
    const second = [];
    for await (const chunk of chunkSource(source, plan("recursive"))) second.push(chunk);

    expect(first.length).toBeGreaterThan(100);
    expect(second.map((chunk) => chunk.id)).toEqual(first.map((chunk) => chunk.id));
    expect(first[0]!.meta).toMatchObject({
      sectionIndex: 0,
      chunkInSection: 0,
      chunkIndex: 0,
      corpus: "stream-test",
    });
  });

  it("keeps one JSONL record per chunk", async () => {
    const file = path.join(tmp, "chunks.jsonl");
    await fsp.writeFile(file, '{"id":1}\n{"id":2}\n{"id":3}\n');
    const source = await parseSource(file);
    const chunks = [];
    for await (const chunk of chunkSource(source, plan("jsonl"))) chunks.push(chunk);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.meta.line)).toEqual([1, 2, 3]);
  });
});
