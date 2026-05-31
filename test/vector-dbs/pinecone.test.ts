import { beforeEach, describe, expect, it, vi } from "vitest";
import { Embedded } from "../../src/embed/engine.js";

interface FakePinecone {
  describeIndex: ReturnType<typeof vi.fn>;
  createIndex: ReturnType<typeof vi.fn>;
  listIndexes: ReturnType<typeof vi.fn>;
  index: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
}

function makeFake(opts: { describe?: unknown; describeThrows?: Error } = {}): FakePinecone {
  const upsert = vi.fn(async () => undefined);
  const deleteMany = vi.fn(async () => undefined);
  const describeIndex = opts.describeThrows
    ? vi.fn(async () => {
        throw opts.describeThrows;
      })
    : vi.fn(async () => opts.describe ?? null);
  return {
    describeIndex,
    createIndex: vi.fn(async () => undefined),
    listIndexes: vi.fn(async () => ({ indexes: [] })),
    index: vi.fn(() => ({ upsert, deleteMany })),
    upsert,
    deleteMany,
  };
}

function mockPinecone(fake: FakePinecone) {
  vi.doMock("@pinecone-database/pinecone", () => ({
    Pinecone: function MockPinecone() {
      return {
        describeIndex: fake.describeIndex,
        createIndex: fake.createIndex,
        listIndexes: fake.listIndexes,
        index: fake.index,
      };
    },
  }));
}

const sample: Embedded[] = Array.from({ length: 3 }, (_, i) => ({
  id: `id${i.toString().padStart(2, "0")}aaaaaaaa`.slice(0, 16),
  text: `chunk ${i}`,
  meta: { i, tag: "hello" },
  vector: [0.1, 0.2, 0.3],
  model: "m",
  dim: 3,
}));

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("pinecone adapter", () => {
  it("creates a serverless index when none exists", async () => {
    const notFound = new Error("Index not found");
    const fake = makeFake({ describeThrows: notFound });
    mockPinecone(fake);
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    const db = createPineconeAdapter({ apiKey: "key" });
    await db.ensureCollection("idx", 1536);
    expect(fake.createIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "idx",
        dimension: 1536,
        spec: { serverless: { cloud: "aws", region: "us-east-1" } },
        waitUntilReady: true,
      }),
    );
  });

  it("refuses to ensure an index with mismatched dim", async () => {
    const fake = makeFake({ describe: { dimension: 1024, status: { ready: true } } });
    mockPinecone(fake);
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    const db = createPineconeAdapter({ apiKey: "key" });
    await expect(db.ensureCollection("idx", 1536)).rejects.toThrow(
      /dim 1024.*requested 1536/,
    );
  });

  it("describeCollection returns the index dimension when present", async () => {
    const fake = makeFake({ describe: { dimension: 768, status: { ready: true } } });
    mockPinecone(fake);
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    const db = createPineconeAdapter({ apiKey: "key" });
    expect(await db.describeCollection("idx")).toEqual({ dim: 768 });
  });

  it("describeCollection returns null for missing indexes", async () => {
    const fake = makeFake({ describeThrows: new Error("404 Not Found") });
    mockPinecone(fake);
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    const db = createPineconeAdapter({ apiKey: "key" });
    expect(await db.describeCollection("idx")).toBeNull();
  });

  it("upsert batches at 100/request and attaches text as metadata", async () => {
    const fake = makeFake({ describe: { dimension: 3 } });
    mockPinecone(fake);
    const big: Embedded[] = Array.from({ length: 250 }, (_, i) => ({
      id: `i${i.toString().padStart(15, "0")}`.slice(0, 16),
      text: `t${i}`,
      meta: { i },
      vector: [0.1, 0.2, 0.3],
      model: "m",
      dim: 3,
    }));
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    const db = createPineconeAdapter({ apiKey: "key" });
    await db.upsert("idx", big);
    // 250 / 100 = 3 batches
    expect(fake.upsert).toHaveBeenCalledTimes(3);
    const firstCall = fake.upsert.mock.calls[0]![0] as Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>;
    expect(firstCall).toHaveLength(100);
    expect(firstCall[0]!.metadata?._text).toBe("t0");
  });

  it("deleteByIds is a no-op for empty input", async () => {
    const fake = makeFake({ describe: { dimension: 3 } });
    mockPinecone(fake);
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    const db = createPineconeAdapter({ apiKey: "key" });
    await db.deleteByIds("idx", []);
    expect(fake.deleteMany).not.toHaveBeenCalled();
  });

  it("deleteByIds calls deleteMany with the ids array", async () => {
    const fake = makeFake({ describe: { dimension: 3 } });
    mockPinecone(fake);
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    const db = createPineconeAdapter({ apiKey: "key" });
    await db.deleteByIds("idx", [sample[0]!.id, sample[1]!.id]);
    expect(fake.deleteMany).toHaveBeenCalledWith({ ids: [sample[0]!.id, sample[1]!.id] });
  });

  it("refuses to construct without an API key", async () => {
    const { createPineconeAdapter } = await import("../../src/vector-dbs/pinecone.js");
    expect(() => createPineconeAdapter({ apiKey: "" })).toThrow(/API key is required/);
  });
});
