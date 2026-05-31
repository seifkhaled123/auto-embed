import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmp: string;
let cwd: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-pipe-"));
  cwd = process.cwd();
  process.chdir(tmp);
  vi.resetModules();
});

afterEach(async () => {
  process.chdir(cwd);
  await fsp.rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface FakeDB {
  name: string;
  ensureCollection: ReturnType<typeof vi.fn>;
  describeCollection: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  deleteByIds: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  upserts: { collection: string; rows: { id: string }[] }[];
}

function makeFakeDb(): FakeDB {
  const upserts: { collection: string; rows: { id: string }[] }[] = [];
  return {
    name: "fake-db",
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    describeCollection: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockImplementation(async (collection: string, rows: { id: string }[]) => {
      upserts.push({ collection, rows: rows.map((r) => ({ id: r.id })) });
    }),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    upserts,
  };
}

async function setupPipelineWithFakes(dim = 4) {
  const db = makeFakeDb();
  const provider = {
    name: "openai", // must match resolved.provider so the integrity check passes
    defaultModel: "fake-model",
    defaultBatchSize: 16,
    embed: vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => Array.from({ length: dim }, () => 0.1)),
      usage: { promptTokens: 0, totalTokens: 0 },
    })),
    dimensions: () => dim,
  };

  vi.doMock("../src/providers/index.js", async () => {
    const actual = (await vi.importActual("../src/providers/index.js")) as object;
    return { ...actual, resolveProvider: async () => provider };
  });
  vi.doMock("../src/vector-dbs/index.js", async () => {
    const actual = (await vi.importActual("../src/vector-dbs/index.js")) as object;
    return { ...actual, resolveVectorDb: async () => db };
  });

  const { runPipeline } = await import("../src/embed/pipeline.js");
  return { runPipeline, provider, db };
}

describe("runPipeline", () => {
  it("embeds chunks on a fresh run, writes a lockfile, and upserts", async () => {
    const file = path.join(tmp, "doc.txt");
    await fsp.writeFile(file, "alpha beta gamma delta epsilon zeta eta theta iota kappa.");
    const { runPipeline, provider, db } = await setupPipelineWithFakes();

    const outcome = await runPipeline({
      file,
      config: {},
      env: {},
      resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
    });

    expect(outcome.kind).toBe("embedded");
    if (outcome.kind !== "embedded") throw new Error("type guard");
    expect(outcome.addedCount).toBeGreaterThanOrEqual(1);
    expect(provider.embed).toHaveBeenCalled();
    expect(db.upsert).toHaveBeenCalledTimes(1);
    expect(db.ensureCollection).toHaveBeenCalledWith(expect.any(String), 4);
    // Lockfile exists
    const lockfiles = await fsp.readdir(path.join(tmp, ".auto-embed"));
    expect(lockfiles.length).toBe(1);
    expect(lockfiles[0]).toMatch(/\.lock\.json$/);
  });

  it("returns upToDate without provider or db calls on a second run", async () => {
    const file = path.join(tmp, "doc.txt");
    await fsp.writeFile(file, "the quick brown fox jumps over the lazy dog.");
    {
      const { runPipeline } = await setupPipelineWithFakes();
      const r = await runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      });
      expect(r.kind).toBe("embedded");
    }
    vi.resetModules();
    const { runPipeline, provider, db } = await setupPipelineWithFakes();
    const r2 = await runPipeline({
      file,
      config: {},
      env: {},
      resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
    });
    expect(r2.kind).toBe("upToDate");
    expect(provider.embed).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("only re-embeds changed chunks after a content edit", async () => {
    const file = path.join(tmp, "doc.md");
    await fsp.writeFile(file, "# A\nhello world\n\n# B\nfoo bar\n");
    {
      const { runPipeline } = await setupPipelineWithFakes();
      await runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      });
    }
    // Edit one section only
    await fsp.writeFile(file, "# A\nhello world\n\n# B\nfoo bar baz quux\n");
    vi.resetModules();
    const { runPipeline, provider } = await setupPipelineWithFakes();
    const r = await runPipeline({
      file,
      config: {},
      env: {},
      resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
    });
    expect(r.kind).toBe("embedded");
    if (r.kind !== "embedded") throw new Error("type guard");
    // Only one batch with one chunk re-embedded — not both
    const callsWithTexts = provider.embed.mock.calls.flatMap((c) => c[0] as string[]);
    expect(callsWithTexts.length).toBeLessThan(2);
  });

  it("refuses to mix dimensions when the model dim changes", async () => {
    const file = path.join(tmp, "doc.txt");
    await fsp.writeFile(file, "hello world content for dimension test.");
    {
      const { runPipeline } = await setupPipelineWithFakes(4);
      await runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      });
    }
    vi.resetModules();
    const { runPipeline } = await setupPipelineWithFakes(8); // different dim!
    await expect(
      runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      }),
    ).rejects.toThrow(/dimensions changed/);
  });

  it("refuses if the existing collection dim differs from the model dim", async () => {
    const file = path.join(tmp, "doc.txt");
    await fsp.writeFile(file, "small content for the collection-dim guard.");
    const db = makeFakeDb();
    db.describeCollection.mockResolvedValue({ dim: 999 });
    const provider = {
      name: "fake",
      defaultModel: "fake-model",
      defaultBatchSize: 16,
      embed: vi.fn(async () => ({ vectors: [], usage: { promptTokens: 0, totalTokens: 0 } })),
      dimensions: () => 4,
    };
    vi.doMock("../src/providers/index.js", async () => {
      const actual = (await vi.importActual("../src/providers/index.js")) as object;
      return { ...actual, resolveProvider: async () => provider };
    });
    vi.doMock("../src/vector-dbs/index.js", async () => {
      const actual = (await vi.importActual("../src/vector-dbs/index.js")) as object;
      return { ...actual, resolveVectorDb: async () => db };
    });
    const { runPipeline } = await import("../src/embed/pipeline.js");
    await expect(
      runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      }),
    ).rejects.toThrow(/dim 999.*dim 4/);
  });
});
