import { AutoEmbedError, ExitCode } from "../errors.js";
import { Config } from "../config/index.js";
import { VectorDbName } from "../config/schema.js";
import { VectorDB } from "./types.js";

export type { VectorDB, CollectionInfo } from "./types.js";

export interface ResolveDbInput {
  db: VectorDbName;
  config: Config;
  env: NodeJS.ProcessEnv;
  /** Set by --local for chroma; if true and url is unset, defaults to ./chroma. */
  local?: boolean;
}

export async function resolveVectorDb(input: ResolveDbInput): Promise<VectorDB> {
  switch (input.db) {
    case "chroma": {
      const { createChromaAdapter } = await import("./chroma.js");
      const url =
        input.env.CHROMA_URL ?? input.config.dbs?.chroma?.url ?? (input.local ? "./chroma" : "http://localhost:8000");
      return createChromaAdapter({ url, autoSpawn: input.local !== false });
    }
    case "pgvector":
    case "pinecone":
    case "qdrant":
      throw new AutoEmbedError(
        `Vector DB "${input.db}" is wired in M5.`,
        ExitCode.UserConfig,
        "For now use --db chroma (default for --local).",
      );
    default:
      throw new AutoEmbedError(
        `Unknown vector DB: ${input.db as string}`,
        ExitCode.UserConfig,
      );
  }
}
