import { AutoEmbedError, ExitCode } from "../errors.js";
import { Config } from "../config/index.js";
import { DB_ENV, VectorDbName } from "../config/schema.js";
import { VectorDB } from "./types.js";

export type { VectorDB, CollectionInfo } from "./types.js";

export interface ResolveDbInput {
  db: VectorDbName;
  config: Config;
  env: NodeJS.ProcessEnv;
  /** Set by --local for chroma; when true and url is unset, defaults to ./chroma. */
  local?: boolean;
}

export async function resolveVectorDb(input: ResolveDbInput): Promise<VectorDB> {
  switch (input.db) {
    case "chroma": {
      const { createChromaAdapter } = await import("./chroma.js");
      const url =
        input.env.CHROMA_URL ??
        input.config.dbs?.chroma?.url ??
        (input.local ? "./chroma" : "http://localhost:8000");
      return createChromaAdapter({ url, autoSpawn: input.local !== false });
    }
    case "pgvector": {
      const { createPgvectorAdapter } = await import("./pgvector.js");
      const url = input.env[DB_ENV.pgvector.url] ?? input.config.dbs?.pgvector?.url ?? "";
      if (!url) {
        throw new AutoEmbedError(
          "pgvector: no connection URL configured.",
          ExitCode.UserConfig,
          "Set DATABASE_URL or run `auto-embed init`.",
        );
      }
      return createPgvectorAdapter({ url });
    }
    case "pinecone": {
      const { createPineconeAdapter } = await import("./pinecone.js");
      const apiKey = input.env[DB_ENV.pinecone.apiKey] ?? input.config.apiKeys?.pinecone ?? "";
      if (!apiKey) {
        throw new AutoEmbedError(
          "pinecone: no API key configured.",
          ExitCode.UserConfig,
          "Set PINECONE_API_KEY or run `auto-embed init`.",
        );
      }
      return createPineconeAdapter({ apiKey });
    }
    case "qdrant": {
      const { createQdrantAdapter } = await import("./qdrant.js");
      const url =
        input.env[DB_ENV.qdrant.url] ??
        input.config.dbs?.qdrant?.url ??
        "http://localhost:6333";
      const apiKey = input.env[DB_ENV.qdrant.apiKey] ?? input.config.apiKeys?.qdrant;
      return createQdrantAdapter({ url, apiKey });
    }
    default:
      throw new AutoEmbedError(
        `Unknown vector DB: ${input.db as string}`,
        ExitCode.UserConfig,
      );
  }
}
