import { AutoEmbedError, ExitCode } from "../errors.js";
import { Embedded } from "../embed/engine.js";
import { CollectionInfo, VectorDB } from "./types.js";

interface QdrantArgs {
  url: string;
  apiKey?: string;
}

interface QdrantClientLike {
  getCollection(name: string): Promise<{
    config?: {
      params?: {
        vectors?: { size?: number } | Record<string, { size?: number }>;
      };
    };
  }>;
  createCollection(
    name: string,
    body: { vectors: { size: number; distance: "Cosine" | "Euclid" | "Dot" } },
  ): Promise<boolean>;
  upsert(
    name: string,
    body: {
      wait?: boolean;
      points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }>;
    },
  ): Promise<unknown>;
  delete(
    name: string,
    body: { wait?: boolean; points: Array<string | number> },
  ): Promise<unknown>;
}

interface QdrantCtor {
  new (config: { url: string; apiKey?: string }): QdrantClientLike;
}

const UPSERT_BATCH = 200;

function sanitizePayload(meta: Record<string, unknown>, text: string): Record<string, unknown> {
  return { ...meta, _text: text };
}

/**
 * Qdrant point IDs must be unsigned ints OR UUIDs — arbitrary strings are
 * rejected. Our chunk IDs are 16-char hex (sha256 prefix). Expand to a UUID
 * by repeating the 16 hex chars (deterministic, reversible-by-prefix, and
 * the same input always maps to the same UUID so upsert/delete align).
 */
function toQdrantId(chunkId: string): string {
  // Take 32 hex chars: chunkId twice gives us 32 deterministic hex chars.
  const hex = (chunkId + chunkId).slice(0, 32).padEnd(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

class QdrantAdapter implements VectorDB {
  readonly name = "qdrant";
  private clientPromise: Promise<QdrantClientLike> | null = null;

  constructor(private readonly args: QdrantArgs) {}

  private async client(): Promise<QdrantClientLike> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      let mod: { QdrantClient: QdrantCtor };
      try {
        mod = (await import("@qdrant/js-client-rest")) as unknown as typeof mod;
      } catch (err) {
        throw new AutoEmbedError(
          `qdrant: failed to load @qdrant/js-client-rest: ${(err as Error).message}`,
          ExitCode.VectorDb,
        );
      }
      return new mod.QdrantClient({ url: this.args.url, apiKey: this.args.apiKey });
    })();
    return this.clientPromise;
  }

  async ensureCollection(name: string, dim: number): Promise<void> {
    const c = await this.client();
    const existing = await this.describeCollection(name);
    if (existing) {
      if (existing.dim && existing.dim !== dim) {
        throw new AutoEmbedError(
          `qdrant: collection "${name}" exists with dim ${existing.dim}, requested ${dim}.`,
          ExitCode.Integrity,
          "Use a fresh --collection name or recreate the collection manually.",
        );
      }
      return;
    }
    try {
      await c.createCollection(name, { vectors: { size: dim, distance: "Cosine" } });
    } catch (err) {
      throw new AutoEmbedError(
        `qdrant: failed to create collection "${name}": ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
  }

  async describeCollection(name: string): Promise<CollectionInfo | null> {
    const c = await this.client();
    try {
      const info = await c.getCollection(name);
      const vec = info.config?.params?.vectors;
      let size = 0;
      if (vec && typeof vec === "object") {
        if ("size" in vec && typeof (vec as { size?: number }).size === "number") {
          size = (vec as { size: number }).size;
        } else {
          // Multi-vector config: take the first named vector's size.
          const first = Object.values(vec as Record<string, { size?: number }>)[0];
          if (first?.size) size = first.size;
        }
      }
      return { dim: size };
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/not found|doesn't exist|404|Not Found/i.test(msg)) return null;
      throw new AutoEmbedError(
        `qdrant: failed to describe collection "${name}": ${msg}`,
        ExitCode.VectorDb,
      );
    }
  }

  async upsert(collection: string, rows: Embedded[]): Promise<void> {
    if (rows.length === 0) return;
    const c = await this.client();
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH);
      try {
        await c.upsert(collection, {
          wait: true,
          points: batch.map((r) => ({
            id: toQdrantId(r.id),
            vector: r.vector,
            payload: { ...sanitizePayload(r.meta, r.text), _chunkId: r.id },
          })),
        });
      } catch (err) {
        throw new AutoEmbedError(
          `qdrant: upsert failed: ${(err as Error).message}`,
          ExitCode.VectorDb,
        );
      }
    }
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const c = await this.client();
    try {
      await c.delete(collection, { wait: true, points: ids.map(toQdrantId) });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/not found|404/i.test(msg)) return;
      throw new AutoEmbedError(
        `qdrant: delete failed: ${msg}`,
        ExitCode.VectorDb,
      );
    }
  }
}

export function createQdrantAdapter(args: QdrantArgs): VectorDB {
  if (!args.url) {
    throw new AutoEmbedError(
      "qdrant: URL is required.",
      ExitCode.UserConfig,
      "Set QDRANT_URL or run `auto-embed init`.",
    );
  }
  return new QdrantAdapter(args);
}
