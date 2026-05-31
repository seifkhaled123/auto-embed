/**
 * Per-model embedding pricing in USD per **1M input tokens**, last verified
 * 2026-05-01. Update when providers change pricing. We intentionally bake the
 * table rather than fetching live prices — no provider exposes an API for it.
 *
 * Numbers reflect public list prices for the standard tier. Volume / enterprise
 * deals are not reflected. When uncertain about a model, we mark it `null` and
 * report "unknown" rather than guess.
 */
export interface ModelPrice {
  /** USD per 1,000,000 input tokens. `0` means free. `null` means unknown. */
  inputPerM: number | null;
  /** Free up to some cap and pay-as-you-go after (e.g. Google's free tier). */
  freeTierNote?: string;
}

export const EMBED_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "text-embedding-3-small": { inputPerM: 0.02 },
  "text-embedding-3-large": { inputPerM: 0.13 },
  "text-embedding-ada-002": { inputPerM: 0.1 },

  // Google. `text-embedding-004` was retired 2026-01-14 and replaced by
  // `gemini-embedding-001`. There is still a free tier for low-volume
  // testing, but the published per-token rate is $0.15 / 1M tokens — that's
  // what we estimate against so users aren't surprised at scale.
  "gemini-embedding-001": { inputPerM: 0.15 },

  // Voyage
  "voyage-3": { inputPerM: 0.06 },
  "voyage-3-lite": { inputPerM: 0.02 },

  // Cohere
  "embed-english-v3.0": { inputPerM: 0.1 },
  "embed-multilingual-v3.0": { inputPerM: 0.1 },

  // Local
  "BAAI/bge-small-en-v1.5": { inputPerM: 0 },
  "BAAI/bge-base-en-v1.5": { inputPerM: 0 },
  "BAAI/bge-small-en": { inputPerM: 0 },
  "BAAI/bge-base-en": { inputPerM: 0 },
  "sentence-transformers/all-MiniLM-L6-v2": { inputPerM: 0 },
  "intfloat/multilingual-e5-large": { inputPerM: 0 },
};

export const PRICES_LAST_VERIFIED = "2026-05-31";

export interface CostEstimate {
  /** Total tokens across all chunks. */
  tokens: number;
  /** USD cost. `null` when the model isn't in our price table. */
  usd: number | null;
  /** Human-readable note shown to the user. */
  note: string;
}

export function estimateCost(tokens: number, model: string): CostEstimate {
  const price = EMBED_PRICES[model];
  if (!price) {
    return {
      tokens,
      usd: null,
      note: `pricing unknown for ${model} (see provider docs)`,
    };
  }
  if (price.inputPerM === null) {
    return { tokens, usd: null, note: `pricing unknown for ${model}` };
  }
  const usd = (tokens / 1_000_000) * price.inputPerM;
  if (price.inputPerM === 0) {
    const suffix = price.freeTierNote ? ` (${price.freeTierNote})` : "";
    return { tokens, usd: 0, note: `free${suffix}` };
  }
  return {
    tokens,
    usd,
    note: `$${price.inputPerM.toFixed(2)} / 1M tokens (verified ${PRICES_LAST_VERIFIED})`,
  };
}

export function formatUsd(usd: number | null): string {
  if (usd === null) return "unknown";
  if (usd === 0) return "$0.0000";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}
