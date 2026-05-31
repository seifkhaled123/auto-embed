import { describe, expect, it, vi } from "vitest";
import { embedChunks } from "../src/embed/engine.js";
import { Chunk } from "../src/chunker/index.js";
import { EmbeddingProvider } from "../src/providers/index.js";

function fakeChunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id${i.toString().padStart(2, "0")}aaaaaaaa`.slice(0, 16),
    text: `chunk #${i}`,
    meta: { i },
  }));
}

function fakeProvider(opts: {
  defaultBatchSize?: number;
  dim?: number;
  embed?: (texts: string[]) => Promise<number[][]> | number[][];
} = {}): { provider: EmbeddingProvider; calls: string[][] } {
  const calls: string[][] = [];
  const dim = opts.dim ?? 3;
  const provider: EmbeddingProvider = {
    name: "fake",
    defaultModel: "fake-model",
    defaultBatchSize: opts.defaultBatchSize ?? 4,
    async embed(texts: string[]) {
      calls.push([...texts]);
      const vectors = opts.embed
        ? await opts.embed(texts)
        : texts.map((_, i) => Array.from({ length: dim }, (__, k) => calls.length + i + k * 0.01));
      return { vectors, usage: { promptTokens: 0, totalTokens: 0 } };
    },
    dimensions: () => dim,
  };
  return { provider, calls };
}

describe("embedChunks", () => {
  it("splits chunks into batches and preserves order", async () => {
    const chunks = fakeChunks(10);
    const { provider, calls } = fakeProvider({ defaultBatchSize: 3 });
    const out = await embedChunks(chunks, provider, { model: "fake-model" });
    expect(out).toHaveLength(10);
    // Original chunk order preserved
    out.forEach((e, i) => {
      expect(e.id).toBe(chunks[i]!.id);
      expect(e.text).toBe(chunks[i]!.text);
      expect(e.model).toBe("fake-model");
      expect(e.dim).toBe(3);
    });
    // Four batches: 3 + 3 + 3 + 1
    expect(calls.map((c) => c.length)).toEqual([3, 3, 3, 1]);
  });

  it("returns empty array for no chunks (no API call)", async () => {
    const { provider, calls } = fakeProvider();
    const out = await embedChunks([], provider, { model: "m" });
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("retries on retryable errors", async () => {
    const chunks = fakeChunks(2);
    let attempts = 0;
    const provider: EmbeddingProvider = {
      name: "flaky",
      defaultModel: "m",
      defaultBatchSize: 10,
      async embed(texts: string[]) {
        attempts++;
        if (attempts < 3) {
          const err = new Error("transient") as Error & { retryable?: boolean };
          err.retryable = true;
          throw err;
        }
        return {
          vectors: texts.map(() => [1, 2, 3]),
          usage: { promptTokens: 0, totalTokens: 0 },
        };
      },
      dimensions: () => 3,
    };
    const out = await embedChunks(chunks, provider, {
      model: "m",
      retries: 3,
    });
    expect(out).toHaveLength(2);
    expect(attempts).toBe(3);
  });

  it("does not retry on non-retryable errors", async () => {
    const chunks = fakeChunks(2);
    let attempts = 0;
    const provider: EmbeddingProvider = {
      name: "broken",
      defaultModel: "m",
      defaultBatchSize: 10,
      async embed() {
        attempts++;
        const err = new Error("invalid input") as Error & { retryable?: boolean };
        err.retryable = false;
        throw err;
      },
      dimensions: () => 3,
    };
    await expect(
      embedChunks(chunks, provider, { model: "m", retries: 5 }),
    ).rejects.toThrow(/invalid input/);
    expect(attempts).toBe(1);
  });

  it("calls onProgress with a monotonically increasing done count", async () => {
    const chunks = fakeChunks(6);
    const { provider } = fakeProvider({ defaultBatchSize: 2 });
    const progress = vi.fn();
    await embedChunks(chunks, provider, { model: "m", onProgress: progress });
    const calls = progress.mock.calls.map((c) => c[0] as number);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toBe(6);
    // monotonically non-decreasing
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]).toBeGreaterThanOrEqual(calls[i - 1]!);
    }
  });

  it("rejects when provider returns wrong number of vectors", async () => {
    const chunks = fakeChunks(3);
    const provider: EmbeddingProvider = {
      name: "wrong-count",
      defaultModel: "m",
      defaultBatchSize: 10,
      embed: async () => ({ vectors: [[1, 2, 3]], usage: { promptTokens: 0, totalTokens: 0 } }),
      dimensions: () => 3,
    };
    await expect(embedChunks(chunks, provider, { model: "m" })).rejects.toThrow(
      /expected 3 vectors, got 1/,
    );
  });

  it("rejects when a vector's dim != model dim", async () => {
    const chunks = fakeChunks(1);
    const provider: EmbeddingProvider = {
      name: "wrong-dim",
      defaultModel: "m",
      defaultBatchSize: 10,
      embed: async () => ({ vectors: [[1, 2]], usage: { promptTokens: 0, totalTokens: 0 } }),
      dimensions: () => 3,
    };
    await expect(embedChunks(chunks, provider, { model: "m" })).rejects.toThrow(
      /vector dim 2 != model dim 3/,
    );
  });
});
