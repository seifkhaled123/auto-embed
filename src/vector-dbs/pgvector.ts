import { AutoEmbedError, ExitCode } from "../errors.js";
import { Embedded } from "../embed/engine.js";
import { CollectionInfo, VectorDB } from "./types.js";

interface PgArgs {
  url: string;
}

interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

interface PgClientCtor {
  new (config: { connectionString: string }): PgClientLike;
}

const VALID_TABLE = /^[a-z_][a-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!VALID_TABLE.test(name)) {
    throw new AutoEmbedError(
      `pgvector: invalid collection name "${name}" — must match [a-z_][a-z0-9_]*`,
      ExitCode.UserConfig,
    );
  }
  return `"${name}"`;
}

/**
 * Format a JS number[] as pgvector's text literal: '[1,2,3]'.
 * Avoiding NaN / Infinity preserves the column's NOT NULL semantics.
 */
function formatVector(vec: number[]): string {
  let out = "[";
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    if (!Number.isFinite(v)) {
      throw new AutoEmbedError(
        "pgvector: vector contains non-finite values",
        ExitCode.Integrity,
      );
    }
    out += i === 0 ? String(v) : "," + String(v);
  }
  out += "]";
  return out;
}

class PgvectorAdapter implements VectorDB {
  readonly name = "pgvector";
  private clientPromise: Promise<PgClientLike> | null = null;

  constructor(private readonly args: PgArgs) {}

  private async client(): Promise<PgClientLike> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      let pg: { Client: PgClientCtor };
      try {
        pg = (await import("pg")) as unknown as { Client: PgClientCtor };
      } catch (err) {
        throw new AutoEmbedError(
          `pgvector: failed to load pg: ${(err as Error).message}`,
          ExitCode.VectorDb,
        );
      }
      const client = new pg.Client({ connectionString: this.args.url });
      try {
        await (client as unknown as { connect(): Promise<void> }).connect();
      } catch (err) {
        throw new AutoEmbedError(
          `pgvector: connect failed: ${(err as Error).message}`,
          ExitCode.VectorDb,
          "Verify DATABASE_URL and that the Postgres server is reachable.",
        );
      }
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      } catch (err) {
        throw new AutoEmbedError(
          `pgvector: failed to ensure the "vector" extension: ${(err as Error).message}`,
          ExitCode.VectorDb,
          "Install pgvector on the server (https://github.com/pgvector/pgvector).",
        );
      }
      return client;
    })();
    return this.clientPromise;
  }

  async ensureCollection(name: string, dim: number): Promise<void> {
    const table = quoteIdent(name);
    const c = await this.client();
    try {
      await c.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
           id TEXT PRIMARY KEY,
           embedding vector(${dim}) NOT NULL,
           content TEXT NOT NULL,
           metadata JSONB NOT NULL DEFAULT '{}'::jsonb
         )`,
      );
    } catch (err) {
      throw new AutoEmbedError(
        `pgvector: failed to create table "${name}": ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
  }

  async describeCollection(name: string): Promise<CollectionInfo | null> {
    const c = await this.client();
    let rows: Array<Record<string, unknown>>;
    try {
      const result = await c.query(
        `SELECT udt_name, character_maximum_length
           FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'embedding'`,
        [name],
      );
      rows = result.rows;
    } catch (err) {
      throw new AutoEmbedError(
        `pgvector: failed to describe collection "${name}": ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
    if (rows.length === 0) return null;
    // Postgres exposes vector(N) via atttypmod; information_schema doesn't.
    // Re-query pg_attribute to get the dim.
    let dimRows: Array<Record<string, unknown>>;
    try {
      const r = await c.query(
        `SELECT atttypmod
           FROM pg_attribute a
           JOIN pg_class t ON t.oid = a.attrelid
          WHERE t.relname = $1 AND a.attname = 'embedding'`,
        [name],
      );
      dimRows = r.rows;
    } catch {
      // If pg_attribute is inaccessible we'd rather skip the guard than crash.
      return { dim: 0 };
    }
    const typmod = Number(dimRows[0]?.atttypmod ?? -1);
    return { dim: typmod > 0 ? typmod : 0 };
  }

  async upsert(collection: string, rows: Embedded[]): Promise<void> {
    if (rows.length === 0) return;
    const table = quoteIdent(collection);
    const c = await this.client();
    // pg's parameterised placeholders ($1, $2, ...) keep this safe.
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const row of rows) {
      valuesSql.push(`($${p++}, $${p++}::vector, $${p++}, $${p++}::jsonb)`);
      params.push(row.id, formatVector(row.vector), row.text, JSON.stringify(row.meta));
    }
    const sql = `INSERT INTO ${table} (id, embedding, content, metadata)
                 VALUES ${valuesSql.join(", ")}
                 ON CONFLICT (id) DO UPDATE SET
                   embedding = EXCLUDED.embedding,
                   content   = EXCLUDED.content,
                   metadata  = EXCLUDED.metadata`;
    try {
      await c.query(sql, params);
    } catch (err) {
      throw new AutoEmbedError(
        `pgvector: upsert failed: ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const table = quoteIdent(collection);
    const c = await this.client();
    try {
      await c.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
    } catch (err) {
      throw new AutoEmbedError(
        `pgvector: delete failed: ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.clientPromise) return;
    const c = await this.clientPromise;
    this.clientPromise = null;
    try {
      await c.end();
    } catch {
      // ignore — close errors are not user-actionable
    }
  }
}

export function createPgvectorAdapter(args: PgArgs): VectorDB {
  if (!args.url) {
    throw new AutoEmbedError(
      "pgvector: connection URL is required.",
      ExitCode.UserConfig,
      "Set DATABASE_URL or run `auto-embed init` to save one.",
    );
  }
  return new PgvectorAdapter(args);
}
