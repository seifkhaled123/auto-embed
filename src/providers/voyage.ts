import { AutoEmbedError, ExitCode } from "../errors.js";
import { MODEL_DIMENSIONS } from "../config/schema.js";
import { httpError, isRetryable, safeJson } from "./openai.js";
import { EmbedResult, EmbeddingProvider } from "./types.js";

interface Args {
  apiKey: string;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

class VoyageProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly defaultModel = "voyage-3";
  readonly defaultBatchSize = 128;

  constructor(private readonly args: Args) {}

  async embed(texts: string[], opts: { model?: string } = {}): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
    }
    const model = opts.model ?? this.defaultModel;
    let res: Response;
    try {
      res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.args.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err) {
      throw httpError(`voyage: network failure (${(err as Error).message})`, true);
    }
    if (!res.ok) {
      const errBody = await safeJson<{ detail?: string; error?: string }>(res);
      const msg = errBody?.detail ?? errBody?.error ?? `${res.status} ${res.statusText}`;
      throw httpError(`voyage: ${msg}`, isRetryable(res.status), res.status);
    }
    const body = (await res.json()) as VoyageResponse;
    const sorted = body.data.slice().sort((a, b) => a.index - b.index);
    return {
      vectors: sorted.map((d) => d.embedding),
      usage: {
        promptTokens: body.usage?.total_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
      },
    };
  }

  dimensions(model: string): number {
    const dim = MODEL_DIMENSIONS[model];
    if (!dim) {
      throw new AutoEmbedError(
        `Unknown dimensions for voyage model "${model}".`,
        ExitCode.UserConfig,
      );
    }
    return dim;
  }
}

export function createVoyageProvider(args: Args): EmbeddingProvider {
  if (!args.apiKey) {
    throw new AutoEmbedError(
      "voyage: API key is required.",
      ExitCode.UserConfig,
      "Set VOYAGE_API_KEY or run `auto-embed init`.",
    );
  }
  return new VoyageProvider(args);
}
