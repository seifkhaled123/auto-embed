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
  /** Commits one validated batch before it is counted as complete. */
  onBatch?: (rows: Embedded[]) => Promise<void>;
  signal?: AbortSignal;
  totalChunks?: number;
  /** Disable retaining vectors after onBatch commits them. */
  collect?: boolean;
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
  async function* source() {
    for (const chunk of chunks) yield chunk;
  }
  return embedChunkStream(source(), provider, {
    ...opts,
    totalChunks: chunks.length,
    collect: opts.collect ?? true,
  });
}

export async function embedChunkStream(
  chunks: AsyncIterable<Chunk>,
  provider: EmbeddingProvider,
  opts: EmbedEngineOpts,
): Promise<Embedded[]> {
  throwIfInterrupted(opts.signal);

  const batchSize = opts.batchSize ?? provider.defaultBatchSize;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const retries = Math.max(0, opts.retries ?? 5);
  const dim = await provider.dimensions(opts.model);

  const { default: pLimit } = await import("p-limit");
  const { default: pRetry, AbortError } = await import("p-retry");

  const out: Embedded[] = [];
  let done = 0;
  let firstFailure: unknown;
  const limit = pLimit(concurrency);
  let nextStart = 0;
  let pendingBatch: Chunk[] = [];
  let window: Array<{ start: number; chunks: Chunk[] }> = [];

  const flushWindow = async (): Promise<void> => {
    if (window.length === 0) return;
    const current = window;
    window = [];
    const tasks = current.map((batch) => limit(async () => {
      if (firstFailure !== undefined) throw firstFailure;
      try {
        const result = await pRetry(
          async () => {
            if (opts.signal?.aborted) {
              throw new AbortError(interruptedError());
            }
            try {
              return await provider.embed(
                batch.chunks.map((chunk) => chunk.text),
                { model: opts.model },
              );
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
        if (result.vectors.length !== batch.chunks.length) {
          throw new AutoEmbedError(
            `${provider.name}: expected ${batch.chunks.length} vectors, got ${result.vectors.length}`,
            ExitCode.ProviderApi,
          );
        }
        const batchRows: Embedded[] = [];
        result.vectors.forEach((vec, j) => {
          if (vec.length !== dim) {
            throw new AutoEmbedError(
              `${provider.name}: vector dim ${vec.length} != model dim ${dim} for "${opts.model}"`,
              ExitCode.Integrity,
            );
          }
          const chunk = batch.chunks[j]!;
          batchRows.push({
            ...chunk,
            vector: vec,
            model: opts.model,
            dim,
          });
        });
        throwIfInterrupted(opts.signal);
        await opts.onBatch?.(batchRows);
        if (opts.collect !== false) {
          batchRows.forEach((row, j) => {
            out[batch.start + j] = row;
          });
        }
        done += batch.chunks.length;
        opts.onProgress?.(done, opts.totalChunks ?? done);
      } catch (err) {
        if (firstFailure === undefined) firstFailure = err;
        throw err;
      }
    }));

    const settled = await Promise.allSettled(tasks);
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  };

  for await (const chunk of chunks) {
    throwIfInterrupted(opts.signal);
    pendingBatch.push(chunk);
    if (pendingBatch.length < batchSize) continue;
    window.push({ start: nextStart, chunks: pendingBatch });
    nextStart += pendingBatch.length;
    pendingBatch = [];
    if (window.length >= concurrency) await flushWindow();
  }
  if (pendingBatch.length > 0) {
    window.push({ start: nextStart, chunks: pendingBatch });
  }
  await flushWindow();

  return out;
}

function throwIfInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted) throw interruptedError();
}

function interruptedError(): AutoEmbedError {
  return new AutoEmbedError(
    "Ingestion interrupted.",
    ExitCode.UserConfig,
    "Re-run the same command to resume from the last committed batch.",
  );
}
