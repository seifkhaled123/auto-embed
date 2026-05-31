import { AutoEmbedError, ExitCode } from "../errors.js";
import { EmbeddingProvider } from "../providers/index.js";
import { Chunk } from "../chunker/index.js";

export interface Embedded extends Chunk {
  vector: number[];
  model: string;
  dim: number;
}

export interface EmbedEngineOpts {
  model: string;
  batchSize?: number;
  concurrency?: number;
  retries?: number;
  /** Called once per completed batch with (done, total) chunk counts. */
  onProgress?: (done: number, total: number) => void;
}

interface RetryableError extends Error {
  retryable?: boolean;
  status?: number;
}

/**
 * Embed `chunks` through `provider`, preserving input order. Splits into
 * batches of `batchSize`, runs up to `concurrency` batches in parallel, and
 * retries each batch on transient errors (HTTP 429 / 5xx / network).
 */
export async function embedChunks(
  chunks: Chunk[],
  provider: EmbeddingProvider,
  opts: EmbedEngineOpts,
): Promise<Embedded[]> {
  if (chunks.length === 0) return [];

  const batchSize = opts.batchSize ?? provider.defaultBatchSize;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const retries = Math.max(0, opts.retries ?? 5);
  const dim = await provider.dimensions(opts.model);

  const batches: Array<{ start: number; texts: string[] }> = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    batches.push({
      start: i,
      texts: chunks.slice(i, i + batchSize).map((c) => c.text),
    });
  }

  const { default: pLimit } = await import("p-limit");
  const { default: pRetry, AbortError } = await import("p-retry");

  const out: Embedded[] = new Array(chunks.length);
  let done = 0;
  const limit = pLimit(concurrency);

  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        const result = await pRetry(
          async () => {
            try {
              return await provider.embed(batch.texts, { model: opts.model });
            } catch (err) {
              const e = err as RetryableError;
              if (e.retryable === false) throw new AbortError(e);
              throw e;
            }
          },
          {
            retries,
            minTimeout: 500,
            factor: 2,
            randomize: false,
          },
        );
        if (result.vectors.length !== batch.texts.length) {
          throw new AutoEmbedError(
            `${provider.name}: expected ${batch.texts.length} vectors, got ${result.vectors.length}`,
            ExitCode.ProviderApi,
          );
        }
        result.vectors.forEach((vec, j) => {
          if (vec.length !== dim) {
            throw new AutoEmbedError(
              `${provider.name}: vector dim ${vec.length} != model dim ${dim} for "${opts.model}"`,
              ExitCode.Integrity,
            );
          }
          const chunk = chunks[batch.start + j]!;
          out[batch.start + j] = {
            ...chunk,
            vector: vec,
            model: opts.model,
            dim,
          };
        });
        done += batch.texts.length;
        opts.onProgress?.(done, chunks.length);
      }),
    ),
  );

  return out;
}
