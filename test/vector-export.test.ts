import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVectorExportWriter } from "../src/commands/vector-export.js";
import { Embedded } from "../src/embed/engine.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-vectors-"));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function row(id: string, value: number): Embedded {
  return {
    id,
    text: `text-${id}`,
    meta: { chunkIndex: value },
    vector: [value, value + 0.5],
    model: "fake-model",
    dim: 2,
  };
}

describe("vector export writer", () => {
  it("requires a JSONL output extension", async () => {
    await expect(
      createVectorExportWriter(path.join(tmp, "vectors.json")),
    ).rejects.toThrow(/must be a \.jsonl file/i);
  });

  it("keeps the final path absent until an atomic commit", async () => {
    const output = path.join(tmp, "nested", "vectors.jsonl");
    const writer = await createVectorExportWriter(output);
    await writer.append("docs/a.md", [row("aaaaaaaaaaaaaaaa", 1)]);
    await expect(fsp.stat(output)).rejects.toMatchObject({ code: "ENOENT" });

    await writer.commit();

    const lines = (await fsp.readFile(output, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      sourcePath: "docs/a.md",
      id: "aaaaaaaaaaaaaaaa",
      text: "text-aaaaaaaaaaaaaaaa",
      metadata: { chunkIndex: 1 },
      model: "fake-model",
      dimensions: 2,
      vector: [1, 1.5],
    });
  });

  it("preserves append order across multiple source files", async () => {
    const output = path.join(tmp, "vectors.jsonl");
    const writer = await createVectorExportWriter(output);
    await writer.append("b.md", [row("bbbbbbbbbbbbbbbb", 2)]);
    await writer.append("c.md", [row("cccccccccccccccc", 3)]);
    await writer.commit();

    const rows = (await fsp.readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sourcePath: string });
    expect(rows.map((entry) => entry.sourcePath)).toEqual(["b.md", "c.md"]);
  });

  it("removes temporary output when aborted", async () => {
    const output = path.join(tmp, "vectors.jsonl");
    const writer = await createVectorExportWriter(output);
    await writer.append("docs/a.md", [row("aaaaaaaaaaaaaaaa", 1)]);
    await writer.abort();

    await expect(fsp.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fsp.readdir(tmp)).toEqual([]);
  });
});
