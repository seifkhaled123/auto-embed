import { AutoEmbedError, ExitCode } from "../errors.js";
import { MODEL_DIMENSIONS } from "../config/schema.js";
import { EmbedResult, EmbeddingProvider } from "./types.js";

interface Args {
  apiKey: string;
  baseUrl?: string;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

interface OpenAIErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

const DEFAULT_BASE = "https://api.openai.com/v1";

class OpenAIProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly defaultModel = "text-embedding-3-small";
  readonly defaultBatchSize = 64;

  constructor(private readonly args: Args) {}

  async embed(texts: string[], opts: { model?: string } = {}): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
    }
    const model = opts.model ?? this.defaultModel;
    const url = `${this.args.baseUrl ?? DEFAULT_BASE}/embeddings`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.args.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err) {
      throw httpError(`openai: network failure (${(err as Error).message})`, true);
    }
    if (!res.ok) {
      const body = await safeJson<OpenAIErrorBody>(res);
      const msg = body?.error?.message ?? `${res.status} ${res.statusText}`;
      throw httpError(`openai: ${msg}`, isRetryable(res.status), res.status);
    }
    const body = (await res.json()) as OpenAIEmbeddingResponse;
    const sorted = body.data.slice().sort((a, b) => a.index - b.index);
    return {
      vectors: sorted.map((d) => d.embedding),
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
      },
    };
  }

  dimensions(model: string): number {
    const dim = MODEL_DIMENSIONS[model];
    if (!dim) {
      throw new AutoEmbedError(
        `Unknown dimensions for openai model "${model}".`,
        ExitCode.UserConfig,
        "Add the model to MODEL_DIMENSIONS in src/config/schema.ts.",
      );
    }
    return dim;
  }
}

export function createOpenAIProvider(args: Args): EmbeddingProvider {
  if (!args.apiKey) {
    throw new AutoEmbedError(
      "openai: API key is required.",
      ExitCode.UserConfig,
      "Set OPENAI_API_KEY or run `auto-embed init`.",
    );
  }
  return new OpenAIProvider(args);
}

// ---------- shared helpers (also used by other cloud providers) ----------

export function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function httpError(message: string, retryable: boolean, status?: number): Error {
  const err = new Error(message) as Error & { retryable?: boolean; status?: number };
  err.retryable = retryable;
  if (status !== undefined) err.status = status;
  return err;
}
