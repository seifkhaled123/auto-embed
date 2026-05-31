import { beforeEach, describe, expect, it, vi } from "vitest";
import { Embedded } from "../../src/embed/engine.js";

function makeFakePg(rows: Record<string, unknown[]> = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      for (const key of Object.keys(rows)) {
        if (sql.includes(key)) return { rows: rows[key]! };
      }
      return { rows: [] };
    }),
  };
  return { client, calls };
}

function mockPg(fake: ReturnType<typeof makeFakePg>) {
  vi.doMock("pg", () => ({
    Client: function MockClient() {
      return fake.client;
    },
  }));
}

const sample: Embedded[] = [
  {
    id: "aaaaaaaaaaaaaaaa",
    text: "hello",
    meta: { i: 0 },
    vector: [0.1, 0.2, 0.3, 0.4],
    model: "test-model",
    dim: 4,
  },
  {
    id: "bbbbbbbbbbbbbbbb",
    text: "world",
    meta: { i: 1 },
    vector: [0.5, 0.6, 0.7, 0.8],
    model: "test-model",
    dim: 4,
  },
];

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("pgvector adapter", () => {
  it("creates the vector extension and the table on ensureCollection", async () => {
    const fake = makeFakePg();
    mockPg(fake);
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    const db = createPgvectorAdapter({ url: "postgres://test" });
    await db.ensureCollection("my_table", 384);
    const sqls = fake.calls.map((c) => c.sql);
    expect(sqls.some((s) => /CREATE EXTENSION IF NOT EXISTS vector/i.test(s))).toBe(true);
    expect(sqls.some((s) => /CREATE TABLE IF NOT EXISTS "my_table"/.test(s))).toBe(true);
    expect(sqls.some((s) => /vector\(384\)/.test(s))).toBe(true);
  });

  it("rejects invalid collection names", async () => {
    mockPg(makeFakePg());
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    const db = createPgvectorAdapter({ url: "postgres://test" });
    await expect(db.ensureCollection("Has Spaces", 4)).rejects.toThrow(/invalid collection name/);
    await expect(db.ensureCollection("drop;tables", 4)).rejects.toThrow(/invalid collection name/);
  });

  it("upsert uses parameterised INSERT ... ON CONFLICT", async () => {
    const fake = makeFakePg();
    mockPg(fake);
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    const db = createPgvectorAdapter({ url: "postgres://test" });
    await db.upsert("t", sample);
    const upsert = fake.calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(upsert.sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
    // 4 params per row × 2 rows = 8 params.
    expect(upsert.params).toHaveLength(8);
    // Vector formatted as pgvector literal.
    expect(upsert.params![1]).toBe("[0.1,0.2,0.3,0.4]");
  });

  it("describeCollection returns dim from pg_attribute typmod", async () => {
    const fake = makeFakePg({
      information_schema: [{ udt_name: "vector" }],
      pg_attribute: [{ atttypmod: 384 }],
    });
    mockPg(fake);
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    const db = createPgvectorAdapter({ url: "postgres://test" });
    const info = await db.describeCollection("t");
    expect(info).toEqual({ dim: 384 });
  });

  it("describeCollection returns null when the table is absent", async () => {
    const fake = makeFakePg(); // empty rows for every query
    mockPg(fake);
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    const db = createPgvectorAdapter({ url: "postgres://test" });
    expect(await db.describeCollection("missing")).toBeNull();
  });

  it("deleteByIds uses ANY array binding", async () => {
    const fake = makeFakePg();
    mockPg(fake);
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    const db = createPgvectorAdapter({ url: "postgres://test" });
    await db.deleteByIds("t", ["a", "b"]);
    const del = fake.calls.find((c) => /DELETE FROM/.test(c.sql))!;
    expect(del.sql).toMatch(/= ANY\(\$1::text\[\]\)/);
    expect(del.params).toEqual([["a", "b"]]);
  });

  it("rejects non-finite vector values", async () => {
    const fake = makeFakePg();
    mockPg(fake);
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    const db = createPgvectorAdapter({ url: "postgres://test" });
    const bad: Embedded[] = [
      { ...sample[0]!, vector: [0.1, Number.NaN, 0.3, 0.4] },
    ];
    await expect(db.upsert("t", bad)).rejects.toThrow(/non-finite/);
  });

  it("refuses to construct without a URL", async () => {
    const { createPgvectorAdapter } = await import("../../src/vector-dbs/pgvector.js");
    expect(() => createPgvectorAdapter({ url: "" })).toThrow(/connection URL is required/);
  });
});
