import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { primeTokenizer } from "../src/chunker/tokens.js";
import {
  ChunkReportEntry,
  defaultChunksReportPath,
  renderChunksReport,
  writeChunksReport,
} from "../src/commands/chunks-report.js";

let tmpDir: string;

const entries: ChunkReportEntry[] = [
  {
    file: "docs/guide.md",
    plan: {
      version: 1,
      splitter: "markdown",
      chunkSize: 800,
      overlap: 100,
      metadata: {},
      collection: "guide",
      embeddingModel: "text-embedding-3-small",
    },
    chunks: [
      {
        id: "0123456789abcdef",
        text: "# Exact chunk text\n\nNothing is embedded.",
        meta: { headerPath: ["Exact chunk text"], chunkIndex: 0 },
      },
    ],
  },
];

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-chunks-"));
  await primeTokenizer();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("chunk report", () => {
  it("derives a source-specific default filename in the current directory", () => {
    expect(defaultChunksReportPath("docs/guide.md")).toBe(
      path.resolve("guide-chunks.txt"),
    );
    expect(defaultChunksReportPath("reports/quarter.final.pdf")).toBe(
      path.resolve("quarter.final-chunks.txt"),
    );
  });

  it("includes the exact text, ID, token count, and metadata", () => {
    const report = renderChunksReport(entries);

    expect(report).toContain("Chunks: 1");
    expect(report).toContain("ID: 0123456789abcdef");
    expect(report).toContain("Tokens:");
    expect(report).toContain(
      'Metadata: {"headerPath":["Exact chunk text"],"chunkIndex":0}',
    );
    expect(report).toContain("# Exact chunk text\n\nNothing is embedded.");
  });

  it("writes a .txt report and creates parent directories", async () => {
    const output = path.join(tmpDir, "nested", "preview.txt");
    const resolved = await writeChunksReport(entries, output);

    expect(resolved).toBe(output);
    expect(await fsp.readFile(output, "utf8")).toBe(renderChunksReport(entries));
  });

  it("rejects non-text output paths", async () => {
    await expect(
      writeChunksReport(entries, path.join(tmpDir, "preview.json")),
    ).rejects.toThrow(/must be a \.txt file/);
  });
});
