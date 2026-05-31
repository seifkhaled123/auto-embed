import { AutoEmbedError, ExitCode } from "../errors.js";
import { MODEL_DIMENSIONS } from "../config/schema.js";
import { httpError, isRetryable, safeJson } from "./openai.js";
import { EmbedResult, EmbeddingProvider } from "./types.js";

interface Args {
  apiKey: string;
}

interface GoogleBatchResponse {
  embeddings?: Array<{ values: number[] }>;
}

class GoogleProvider implements EmbeddingProvider {
  readonly name = "google";
  readonly defaultModel = "text-embedding-004";
  readonly defaultBatchSize = 100;

  constructor(private readonly args: Args) {}

  async embed(texts: string[], opts: { model?: string } = {}): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
    }
    const model = opts.model ?? this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(this.args.apiKey)}`;
    const body = {
      requests: texts.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
      })),
    };
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw httpError(`google: network failure (${(err as Error).message})`, true);
    }
    if (!res.ok) {
      const errBody = await safeJson<{ error?: { message?: string } }>(res);
      const msg = errBody?.error?.message ?? `${res.status} ${res.statusText}`;
      throw httpError(`google: ${msg}`, isRetryable(res.status), res.status);
    }
    const data = (await res.json()) as GoogleBatchResponse;
    const embeddings = data.embeddings ?? [];
    if (embeddings.length !== texts.length) {
      throw httpError(
        `google: expected ${texts.length} embeddings, got ${embeddings.length}`,
        false,
      );
    }
    return {
      vectors: embeddings.map((e) => e.values),
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }

  dimensions(model: string): number {
    const dim = MODEL_DIMENSIONS[model];
    if (!dim) {
      throw new AutoEmbedError(
        `Unknown dimensions for google model "${model}".`,
        ExitCode.UserConfig,
      );
    }
    return dim;
  }
}

export function createGoogleProvider(args: Args): EmbeddingProvider {
  if (!args.apiKey) {
    throw new AutoEmbedError(
      "google: API key is required.",
      ExitCode.UserConfig,
      "Set GOOGLE_API_KEY or run `auto-embed init`.",
    );
  }
  return new GoogleProvider(args);
}
