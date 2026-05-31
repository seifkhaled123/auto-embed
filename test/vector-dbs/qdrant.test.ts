import { beforeEach, describe, expect, it, vi } from "vitest";
import { Embedded } from "../../src/embed/engine.js";

function makeFake(opts: { getCollection?: unknown; getThrows?: Error } = {}) {
  const client = {
    createCollection: vi.fn(async () => true),
    getCollection: opts.getThrows
      ? vi.fn(async () => {
          throw opts.getThrows;
        })
      : vi.fn(async () => opts.getCollection ?? { config: { params: { vectors: { size: 0 } } } }),
    upsert: vi.fn(async () => ({ status: "ok" })),
    delete: vi.fn(async () => ({ status: "ok" })),
  };
  return client;
}

function mockQdrant(fake: ReturnType<typeof makeFake>) {
  vi.doMock("@qdrant/js-client-rest", () => ({
    QdrantClient: function MockQdrantClient() {
      return fake;
    },
  }));
}

const sample: Embedded = {
  id: "aaaaaaaaaaaaaaaa",
  text: "hi",
  meta: { tag: "x" },
  vector: [0.1, 0.2, 0.3, 0.4],
  model: "m",
  dim: 4,
};

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("qdrant adapter", () => {
  it("creates a collection with Cosine distance when none exists", async () => {
    const fake = makeFake({ getThrows: new Error("Not Found") });
    mockQdrant(fake);
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    const db = createQdrantAdapter({ url: "http://localhost:6333" });
    await db.ensureCollection("c", 384);
    expect(fake.createCollection).toHaveBeenCalledWith("c", {
      vectors: { size: 384, distance: "Cosine" },
    });
  });

  it("describeCollection returns the configured size", async () => {
    const fake = makeFake({
      getCollection: { config: { params: { vectors: { size: 384, distance: "Cosine" } } } },
    });
    mockQdrant(fake);
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    const db = createQdrantAdapter({ url: "http://localhost:6333" });
    expect(await db.describeCollection("c")).toEqual({ dim: 384 });
  });

  it("describeCollection returns null on a 404", async () => {
    const fake = makeFake({ getThrows: new Error("Collection not found") });
    mockQdrant(fake);
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    const db = createQdrantAdapter({ url: "http://localhost:6333" });
    expect(await db.describeCollection("missing")).toBeNull();
  });

  it("refuses ensureCollection on dim mismatch", async () => {
    const fake = makeFake({
      getCollection: { config: { params: { vectors: { size: 1024 } } } },
    });
    mockQdrant(fake);
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    const db = createQdrantAdapter({ url: "http://localhost:6333" });
    await expect(db.ensureCollection("c", 384)).rejects.toThrow(/dim 1024.*requested 384/);
  });

  it("upsert sends points with UUID-shaped ids derived from chunk ids", async () => {
    const fake = makeFake({
      getCollection: { config: { params: { vectors: { size: 4 } } } },
    });
    mockQdrant(fake);
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    const db = createQdrantAdapter({ url: "http://localhost:6333" });
    await db.upsert("c", [sample]);
    const calls = fake.upsert.mock.calls as unknown as Array<
      [string, { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> }]
    >;
    expect(calls[0]![0]).toBe("c");
    const body = calls[0]![1];
    expect(body.points).toHaveLength(1);
    expect(body.points[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.points[0]!.vector).toEqual(sample.vector);
    expect(body.points[0]!.payload._text).toBe(sample.text);
    expect(body.points[0]!.payload._chunkId).toBe(sample.id);
  });

  it("uses the same derived id for upsert and deleteByIds (round-trip)", async () => {
    const fake = makeFake({
      getCollection: { config: { params: { vectors: { size: 4 } } } },
    });
    mockQdrant(fake);
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    const db = createQdrantAdapter({ url: "http://localhost:6333" });
    await db.upsert("c", [sample]);
    await db.deleteByIds("c", [sample.id]);
    const upsertCalls = fake.upsert.mock.calls as unknown as Array<
      [string, { points: Array<{ id: string }> }]
    >;
    const deleteCalls = fake.delete.mock.calls as unknown as Array<
      [string, { points: string[] }]
    >;
    expect(deleteCalls[0]![1].points[0]).toBe(upsertCalls[0]![1].points[0]!.id);
  });

  it("delete is a no-op for empty input", async () => {
    const fake = makeFake();
    mockQdrant(fake);
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    const db = createQdrantAdapter({ url: "http://localhost:6333" });
    await db.deleteByIds("c", []);
    expect(fake.delete).not.toHaveBeenCalled();
  });

  it("refuses to construct without URL", async () => {
    const { createQdrantAdapter } = await import("../../src/vector-dbs/qdrant.js");
    expect(() => createQdrantAdapter({ url: "" })).toThrow(/URL is required/);
  });
});
