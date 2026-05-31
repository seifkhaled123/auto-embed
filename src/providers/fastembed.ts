import { AutoEmbedError, ExitCode } from "../errors.js";
import { MODEL_DIMENSIONS } from "../config/schema.js";
import { EmbedResult, EmbeddingProvider } from "./types.js";

interface FlagEmbeddingInstance {
  embed(texts: string[], batchSize?: number): AsyncIterable<number[][] | Float32Array[]>;
}

/** Map our canonical model names to fastembed's EmbeddingModel enum values. */
const MODEL_MAP: Record<string, string> = {
  "BAAI/bge-small-en-v1.5": "fast-bge-small-en-v1.5",
  "BAAI/bge-base-en-v1.5": "fast-bge-base-en-v1.5",
  "BAAI/bge-small-en": "fast-bge-small-en",
  "BAAI/bge-base-en": "fast-bge-base-en",
  "sentence-transformers/all-MiniLM-L6-v2": "fast-all-MiniLM-L6-v2",
  "intfloat/multilingual-e5-large": "fast-multilingual-e5-large",
};

const cache = new Map<string, Promise<FlagEmbeddingInstance>>();

async function getModel(modelName: string): Promise<FlagEmbeddingInstance> {
  const fastembedKey = MODEL_MAP[modelName];
  if (!fastembedKey) {
    throw new AutoEmbedError(
      `fastembed has no built-in for model "${modelName}".`,
      ExitCode.UserConfig,
      `Supported: ${Object.keys(MODEL_MAP).join(", ")}.`,
    );
  }
  const existing = cache.get(fastembedKey);
  if (existing) return existing;

  const promise = (async () => {
    let mod: {
      FlagEmbedding: { init(opts: { model: string; maxLength?: number }): Promise<FlagEmbeddingInstance> };
      EmbeddingModel: Record<string, string>;
    };
    try {
      mod = (await import("fastembed")) as unknown as typeof mod;
    } catch (err) {
      throw new AutoEmbedError(
        `Failed to load fastembed: ${(err as Error).message}`,
        ExitCode.ProviderApi,
        "Reinstall dependencies with `bun install` or `npm install`.",
      );
    }
    const enumValue = Object.values(mod.EmbeddingModel).find((v) => v === fastembedKey);
    if (!enumValue) {
      throw new AutoEmbedError(
        `fastembed dropped support for "${fastembedKey}". Pick another model.`,
        ExitCode.ProviderApi,
      );
    }
    return mod.FlagEmbedding.init({ model: enumValue, maxLength: 512 });
  })();

  cache.set(fastembedKey, promise);
  try {
    return await promise;
  } catch (err) {
    cache.delete(fastembedKey);
    throw err;
  }
}

class FastembedProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly defaultModel = "BAAI/bge-small-en-v1.5";
  readonly defaultBatchSize = 32;

  async embed(texts: string[], opts: { model?: string } = {}): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
    }
    const model = await getModel(opts.model ?? this.defaultModel);
    const vectors: number[][] = [];
    try {
      for await (const batch of model.embed(texts, texts.length)) {
        for (const vec of batch) {
          vectors.push(Array.isArray(vec) ? vec : Array.from(vec));
        }
      }
    } catch (err) {
      throw new AutoEmbedError(
        `fastembed failed: ${(err as Error).message}`,
        ExitCode.ProviderApi,
      );
    }
    return {
      vectors,
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }

  dimensions(model: string): number {
    const dim = MODEL_DIMENSIONS[model];
    if (!dim) {
      throw new AutoEmbedError(
        `Unknown dimensions for fastembed model "${model}".`,
        ExitCode.UserConfig,
        "Add the model to MODEL_DIMENSIONS in src/config/schema.ts.",
      );
    }
    return dim;
  }
}

export const fastembedProvider = new FastembedProvider();
