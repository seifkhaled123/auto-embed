import { z } from "zod";

export const EmbeddingProviderName = z.enum([
  "openai",
  "google",
  "voyage",
  "cohere",
  "local",
]);
export type EmbeddingProviderName = z.infer<typeof EmbeddingProviderName>;

export const VectorDbName = z.enum(["pgvector", "pinecone", "qdrant", "chroma"]);
export type VectorDbName = z.infer<typeof VectorDbName>;

export const DEFAULT_MODELS: Record<EmbeddingProviderName, string> = {
  openai: "text-embedding-3-small",
  google: "text-embedding-004",
  voyage: "voyage-3",
  cohere: "embed-english-v3.0",
  local: "BAAI/bge-small-en-v1.5",
};

export const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "embed-english-v3.0": 1024,
  "embed-multilingual-v3.0": 1024,
  "BAAI/bge-small-en-v1.5": 384,
};

export const ConfigSchema = z.object({
  defaults: z
    .object({
      provider: EmbeddingProviderName.optional(),
      db: VectorDbName.optional(),
      model: z.string().optional(),
      collection: z.string().optional(),
    })
    .partial()
    .optional(),
  models: z
    .object({
      openai: z.string().optional(),
      google: z.string().optional(),
      voyage: z.string().optional(),
      cohere: z.string().optional(),
      local: z.string().optional(),
    })
    .partial()
    .optional(),
  apiKeys: z
    .object({
      openai: z.string().optional(),
      google: z.string().optional(),
      voyage: z.string().optional(),
      cohere: z.string().optional(),
      pinecone: z.string().optional(),
      qdrant: z.string().optional(),
    })
    .partial()
    .optional(),
  dbs: z
    .object({
      pgvector: z.object({ url: z.string().optional() }).partial().optional(),
      pinecone: z.object({ indexName: z.string().optional() }).partial().optional(),
      qdrant: z.object({ url: z.string().optional() }).partial().optional(),
      chroma: z.object({ url: z.string().optional() }).partial().optional(),
    })
    .partial()
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const EMPTY_CONFIG: Config = {};

/** Provider → env var holding the API key. */
export const PROVIDER_ENV: Record<EmbeddingProviderName, string | null> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  voyage: "VOYAGE_API_KEY",
  cohere: "COHERE_API_KEY",
  local: null,
};

/** Vector DB → env var(s) used to derive connection. */
export const DB_ENV = {
  pgvector: { url: "DATABASE_URL" },
  pinecone: { apiKey: "PINECONE_API_KEY" },
  qdrant: { url: "QDRANT_URL", apiKey: "QDRANT_API_KEY" },
  chroma: { url: "CHROMA_URL" },
} as const;
