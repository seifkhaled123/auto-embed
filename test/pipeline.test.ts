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

async function setupPipelineWithFakes(
  dim = 4,
  hooks: { writeLockfile?: () => Promise<string> } = {},
) {
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
  if (hooks.writeLockfile) {
    vi.doMock("../src/lockfile.js", async () => {
      const actual = (await vi.importActual("../src/lockfile.js")) as object;
      return { ...actual, writeLockfile: hooks.writeLockfile };
    });
  } else {
    vi.doUnmock("../src/lockfile.js");
  }

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
    expect(db.close).toHaveBeenCalledTimes(1);
    // Lockfile exists
    const lockfiles = (await fsp.readdir(path.join(tmp, ".auto-embed"))).filter(
      (entry) => entry.endsWith(".lock.json"),
    );
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

  it("regenerates and captures every vector when export is explicitly requested", async () => {
    const file = path.join(tmp, "doc.txt");
    await fsp.writeFile(file, "the quick brown fox jumps over the lazy dog.");
    {
      const { runPipeline } = await setupPipelineWithFakes();
      await runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      });
    }

    vi.resetModules();
    const { runPipeline, provider, db } = await setupPipelineWithFakes();
    const captured = vi.fn(async (_rows: readonly unknown[]) => undefined);
    const result = await runPipeline({
      file,
      config: {},
      env: {},
      resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      captureVectors: captured,
    });

    expect(result.kind).toBe("embedded");
    expect(provider.embed).toHaveBeenCalled();
    expect(db.upsert).toHaveBeenCalled();
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0]![0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ vector: [0.1, 0.1, 0.1, 0.1] })]),
    );
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
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("resumes after the last committed batch without re-embedding it", async () => {
    const file = path.join(tmp, "resume.md");
    await fsp.writeFile(file, "# A\nalpha\n\n# B\nbeta\n\n# C\ngamma\n");
    const first = await setupPipelineWithFakes();
    let upsertAttempt = 0;
    first.db.upsert.mockImplementation(async () => {
      upsertAttempt++;
      if (upsertAttempt === 2) throw new Error("injected upsert failure");
    });

    await expect(
      first.runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
        overrides: { batchSize: 1, concurrency: 1 },
      }),
    ).rejects.toThrow(/injected upsert failure/);
    expect(first.db.close).toHaveBeenCalledTimes(1);
    expect(await fsp.readdir(path.join(tmp, ".auto-embed", "jobs"))).toHaveLength(1);

    vi.resetModules();
    const second = await setupPipelineWithFakes();
    const result = await second.runPipeline({
      file,
      config: {},
      env: {},
      resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      overrides: { batchSize: 1, concurrency: 1 },
    });

    expect(result.kind).toBe("embedded");
    const resumedTexts = second.provider.embed.mock.calls.flatMap((call) => call[0] as string[]);
    expect(resumedTexts).toHaveLength(2);
    expect(resumedTexts.join("\n")).not.toContain("# A");
    expect(await fsp.readdir(path.join(tmp, ".auto-embed", "jobs"))).toEqual([]);
  });

  it("defers removed-chunk deletion until replacement upserts succeed", async () => {
    const file = path.join(tmp, "replace.md");
    await fsp.writeFile(file, "# A\nkeep\n\n# B\nold value\n");
    {
      const first = await setupPipelineWithFakes();
      await first.runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
        overrides: { batchSize: 1, concurrency: 1 },
      });
    }

    await fsp.writeFile(file, "# A\nkeep\n\n# B\nnew value\n");
    vi.resetModules();
    const second = await setupPipelineWithFakes();
    second.db.upsert.mockRejectedValue(new Error("replacement upsert failed"));
    await expect(
      second.runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
        overrides: { batchSize: 1, concurrency: 1 },
      }),
    ).rejects.toThrow(/replacement upsert failed/);
    expect(second.db.deleteByIds).not.toHaveBeenCalled();
  });

  it("resumes after a final lockfile-write failure without new provider calls", async () => {
    const file = path.join(tmp, "lock-failure.md");
    await fsp.writeFile(file, "# A\nalpha\n\n# B\nbeta\n");
    const failedWrite = vi.fn(async () => {
      throw new Error("injected lockfile failure");
    });
    const first = await setupPipelineWithFakes(4, { writeLockfile: failedWrite });
    await expect(
      first.runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
        overrides: { batchSize: 1, concurrency: 1 },
      }),
    ).rejects.toThrow(/injected lockfile failure/);
    expect(await fsp.readdir(path.join(tmp, ".auto-embed", "jobs"))).toHaveLength(1);

    vi.resetModules();
    const second = await setupPipelineWithFakes();
    const result = await second.runPipeline({
      file,
      config: {},
      env: {},
      resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      overrides: { batchSize: 1, concurrency: 1 },
    });
    expect(result.kind).toBe("embedded");
    expect(second.provider.embed).not.toHaveBeenCalled();
    expect(await fsp.readdir(path.join(tmp, ".auto-embed", "jobs"))).toEqual([]);
  });

  it("preserves the primary pipeline error when cleanup also fails", async () => {
    const file = path.join(tmp, "cleanup.txt");
    await fsp.writeFile(file, "cleanup failure test");
    const { runPipeline, db } = await setupPipelineWithFakes();
    db.describeCollection.mockResolvedValue({ dim: 999 });
    db.close.mockRejectedValue(new Error("close also failed"));

    await expect(
      runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      }),
    ).rejects.toThrow(/dim 999.*dim 4/);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a cleanup failure after otherwise successful ingestion", async () => {
    const file = path.join(tmp, "cleanup-success.txt");
    await fsp.writeFile(file, "cleanup success-path test");
    const { runPipeline, db } = await setupPipelineWithFakes();
    db.close.mockRejectedValue(new Error("close failed"));

    await expect(
      runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      }),
    ).rejects.toMatchObject({ exitCode: 4, message: expect.stringMatching(/failed to close/i) });
  });

  it("checkpoints no vectors and closes the DB when interrupted before embedding", async () => {
    const file = path.join(tmp, "interrupt.txt");
    await fsp.writeFile(file, "interrupt test");
    const { runPipeline, provider, db } = await setupPipelineWithFakes();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/interrupted/i);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(await fsp.readdir(path.join(tmp, ".auto-embed", "jobs"))).toHaveLength(1);
  });

  it("closes the DB and keeps resumable state after a provider failure", async () => {
    const file = path.join(tmp, "provider-failure.txt");
    await fsp.writeFile(file, "provider failure test");
    const { runPipeline, provider, db } = await setupPipelineWithFakes();
    const failure = Object.assign(new Error("provider rejected input"), { retryable: false });
    provider.embed.mockRejectedValue(failure);

    await expect(
      runPipeline({
        file,
        config: {},
        env: {},
        resolved: { provider: "openai", model: "fake-model", apiKey: "k", db: "chroma" },
      }),
    ).rejects.toThrow(/provider rejected input/);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(await fsp.readdir(path.join(tmp, ".auto-embed", "jobs"))).toHaveLength(1);
  });
});
