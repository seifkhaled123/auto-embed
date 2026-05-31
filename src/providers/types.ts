export interface TokenUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbedResult {
  vectors: number[][];
  usage: TokenUsage;
}

export interface EmbeddingProvider {
  /** Stable identifier, used in lockfile and errors. */
  readonly name: string;
  /** Provider's default embedding model when the user didn't pick one. */
  readonly defaultModel: string;
  /** Sensible per-request batch size (provider-specific limit). */
  readonly defaultBatchSize: number;
  /**
   * Embed an array of texts. Order of `vectors` MUST match order of `texts`.
   * Implementations MUST NOT log API keys or include them in thrown errors.
   */
  embed(texts: string[], opts?: { model?: string }): Promise<EmbedResult>;
  /** Vector dimension for the given model (after a single API call if needed). */
  dimensions(model: string): number | Promise<number>;
}
