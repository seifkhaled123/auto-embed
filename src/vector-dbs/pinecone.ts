import { AutoEmbedError, ExitCode } from "../errors.js";
import { Embedded } from "../embed/engine.js";
import { CollectionInfo, VectorDB } from "./types.js";

interface PineconeArgs {
  apiKey: string;
  /** Where to create serverless indexes when ensureCollection has to spin one up. */
  cloud?: "aws" | "gcp" | "azure";
  region?: string;
}

interface PineconeIndexLike {
  upsert(records: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<void>;
  deleteMany(arg: { ids: string[] } | string[]): Promise<void>;
}

interface PineconeClientLike {
  listIndexes(): Promise<{ indexes?: Array<{ name: string }> }>;
  describeIndex(name: string): Promise<{ dimension?: number; status?: { ready?: boolean } }>;
  createIndex(options: {
    name: string;
    dimension: number;
    metric?: "cosine" | "euclidean" | "dotproduct";
    spec: { serverless: { cloud: string; region: string } };
    waitUntilReady?: boolean;
  }): Promise<unknown>;
  index(name: string): PineconeIndexLike;
}

interface PineconeCtor {
  new (config: { apiKey: string }): PineconeClientLike;
}

const UPSERT_BATCH = 100;

function sanitizeMeta(meta: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v as string[];
    } else if (Array.isArray(v)) {
      out[k] = v.map(String);
    } else if (typeof v === "object") {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

class PineconeAdapter implements VectorDB {
  readonly name = "pinecone";
  private clientPromise: Promise<PineconeClientLike> | null = null;

  constructor(private readonly args: PineconeArgs) {}

  private async client(): Promise<PineconeClientLike> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      let mod: { Pinecone: PineconeCtor };
      try {
        mod = (await import("@pinecone-database/pinecone")) as unknown as typeof mod;
      } catch (err) {
        throw new AutoEmbedError(
          `pinecone: failed to load @pinecone-database/pinecone: ${(err as Error).message}`,
          ExitCode.VectorDb,
        );
      }
      return new mod.Pinecone({ apiKey: this.args.apiKey });
    })();
    return this.clientPromise;
  }

  async ensureCollection(name: string, dim: number): Promise<void> {
    const c = await this.client();
    const existing = await this.describeRaw(c, name);
    if (existing) {
      if (existing.dim && existing.dim !== dim) {
        throw new AutoEmbedError(
          `pinecone: index "${name}" exists with dim ${existing.dim}, requested ${dim}.`,
          ExitCode.Integrity,
          "Use a fresh --collection name or re-create the index manually.",
        );
      }
      return;
    }
    try {
      await c.createIndex({
        name,
        dimension: dim,
        metric: "cosine",
        spec: {
          serverless: {
            cloud: this.args.cloud ?? "aws",
            region: this.args.region ?? "us-east-1",
          },
        },
        waitUntilReady: true,
      });
    } catch (err) {
      throw new AutoEmbedError(
        `pinecone: failed to create index "${name}": ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
  }

  private async describeRaw(
    client: PineconeClientLike,
    name: string,
  ): Promise<{ dim: number; ready: boolean } | null> {
    try {
      const desc = await client.describeIndex(name);
      const dim = desc.dimension ?? 0;
      const ready = desc.status?.ready ?? false;
      return { dim, ready };
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/not found|NotFound|404/i.test(msg)) return null;
      throw new AutoEmbedError(
        `pinecone: failed to describe index "${name}": ${msg}`,
        ExitCode.VectorDb,
      );
    }
  }

  async describeCollection(name: string): Promise<CollectionInfo | null> {
    const c = await this.client();
    const info = await this.describeRaw(c, name);
    return info ? { dim: info.dim } : null;
  }

  async upsert(collection: string, rows: Embedded[]): Promise<void> {
    if (rows.length === 0) return;
    const c = await this.client();
    const idx = c.index(collection);
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH);
      const records = batch.map((r) => ({
        id: r.id,
        values: r.vector,
        metadata: { ...sanitizeMeta(r.meta), _text: r.text },
      }));
      try {
        await idx.upsert(records);
      } catch (err) {
        throw new AutoEmbedError(
          `pinecone: upsert failed: ${(err as Error).message}`,
          ExitCode.VectorDb,
        );
      }
    }
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const c = await this.client();
    const idx = c.index(collection);
    try {
      await idx.deleteMany({ ids });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/not found|NotFound|404/i.test(msg)) return;
      throw new AutoEmbedError(
        `pinecone: delete failed: ${msg}`,
        ExitCode.VectorDb,
      );
    }
  }
}

export function createPineconeAdapter(args: PineconeArgs): VectorDB {
  if (!args.apiKey) {
    throw new AutoEmbedError(
      "pinecone: API key is required.",
      ExitCode.UserConfig,
      "Set PINECONE_API_KEY or run `auto-embed init`.",
    );
  }
  return new PineconeAdapter(args);
}
