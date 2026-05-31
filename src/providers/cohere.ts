import { AutoEmbedError, ExitCode } from "../errors.js";
import { MODEL_DIMENSIONS } from "../config/schema.js";
import { httpError, isRetryable, safeJson } from "./openai.js";
import { EmbedResult, EmbeddingProvider } from "./types.js";

interface Args {
  apiKey: string;
}

interface CohereResponse {
  embeddings: { float?: number[][] } | number[][];
  meta?: { billed_units?: { input_tokens?: number } };
}

class CohereProvider implements EmbeddingProvider {
  readonly name = "cohere";
  readonly defaultModel = "embed-english-v3.0";
  readonly defaultBatchSize = 96;

  constructor(private readonly args: Args) {}

  async embed(texts: string[], opts: { model?: string } = {}): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
    }
    const model = opts.model ?? this.defaultModel;
    let res: Response;
    try {
      res = await fetch("https://api.cohere.com/v2/embed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.args.apiKey}`,
        },
        body: JSON.stringify({
          model,
          texts,
          input_type: "search_document",
          embedding_types: ["float"],
        }),
      });
    } catch (err) {
      throw httpError(`cohere: network failure (${(err as Error).message})`, true);
    }
    if (!res.ok) {
      const errBody = await safeJson<{ message?: string }>(res);
      const msg = errBody?.message ?? `${res.status} ${res.statusText}`;
      throw httpError(`cohere: ${msg}`, isRetryable(res.status), res.status);
    }
    const body = (await res.json()) as CohereResponse;
    const vectors = Array.isArray(body.embeddings)
      ? body.embeddings
      : body.embeddings.float ?? [];
    if (vectors.length !== texts.length) {
      throw httpError(
        `cohere: expected ${texts.length} embeddings, got ${vectors.length}`,
        false,
      );
    }
    return {
      vectors,
      usage: {
        promptTokens: body.meta?.billed_units?.input_tokens ?? 0,
        totalTokens: body.meta?.billed_units?.input_tokens ?? 0,
      },
    };
  }

  dimensions(model: string): number {
    const dim = MODEL_DIMENSIONS[model];
    if (!dim) {
      throw new AutoEmbedError(
        `Unknown dimensions for cohere model "${model}".`,
        ExitCode.UserConfig,
      );
    }
    return dim;
  }
}

export function createCohereProvider(args: Args): EmbeddingProvider {
  if (!args.apiKey) {
    throw new AutoEmbedError(
      "cohere: API key is required.",
      ExitCode.UserConfig,
      "Set COHERE_API_KEY or run `auto-embed init`.",
    );
  }
  return new CohereProvider(args);
}
