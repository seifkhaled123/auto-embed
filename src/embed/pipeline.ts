import { chunkDocument, CHUNKER_VERSION } from "../chunker/index.js";
import { Config } from "../config/index.js";
import { EmbeddingProviderName, VectorDbName } from "../config/schema.js";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { log, pc } from "../log.js";
import { parseFile } from "../parsers/index.js";
import { heuristicPlan } from "../plan/heuristic.js";
import { EmbedPlan, hashPlan, SplitterName } from "../plan/schema.js";
import { resolveProvider } from "../providers/index.js";
import { resolveVectorDb, VectorDB } from "../vector-dbs/index.js";
import {
  diffChunks,
  hashFile,
  Lockfile,
  lockfilePathFor,
  readLockfile,
  writeLockfile,
} from "../lockfile.js";
import { embedChunks } from "./engine.js";

export interface PipelineInput {
  file: string;
  config: Config;
  env?: NodeJS.ProcessEnv;
  resolved: {
    provider: EmbeddingProviderName;
    model: string;
    apiKey: string;
    db: VectorDbName;
  };
  local?: boolean;
  /** Pre-resolved plan from CLI; when present the pipeline skips heuristic generation. */
  plan?: EmbedPlan;
  overrides?: {
    collection?: string;
    splitter?: SplitterName;
    chunkSize?: number;
    overlap?: number;
    metadata?: Record<string, string>;
    batchSize?: number;
    concurrency?: number;
  };
  force?: boolean;
}

export type PipelineOutcome =
  | {
      kind: "upToDate";
      file: string;
      lockfilePath: string;
      chunkCount: number;
      plan: EmbedPlan;
    }
  | {
      kind: "embedded";
      file: string;
      lockfilePath: string;
      plan: EmbedPlan;
      addedCount: number;
      removedCount: number;
      keptCount: number;
      durationMs: number;
    };

export async function runPipeline(input: PipelineInput): Promise<PipelineOutcome> {
  const env = input.env ?? process.env;
  const start = Date.now();

  const document = await parseFile(input.file);
  const plan: EmbedPlan =
    input.plan ??
    heuristicPlan({
      sourcePath: input.file,
      embeddingModel: input.resolved.model,
      overrides: {
        splitter: input.overrides?.splitter,
        chunkSize: input.overrides?.chunkSize,
        overlap: input.overrides?.overlap,
        collection: input.overrides?.collection,
        metadata: input.overrides?.metadata,
      },
    });
  const planHash = hashPlan(plan);

  const chunks = await chunkDocument(document, plan);
  const sourceHash = await hashFile(input.file);

  const provider = await resolveProvider({
    provider: input.resolved.provider,
    apiKey: input.resolved.apiKey,
  });
  const dim = await provider.dimensions(plan.embeddingModel);

  const lock = await readLockfile(input.file);
  if (lock && !input.force) {
    const integrityIssue = lockfileIntegrityCheck(lock, input.resolved, plan, dim);
    if (integrityIssue) {
      throw new AutoEmbedError(integrityIssue.message, ExitCode.Integrity, integrityIssue.hint);
    }
    if (
      lock.sourceHash === sourceHash &&
      lock.planHash === planHash &&
      lock.chunks.length === chunks.length &&
      lock.chunks.every((c, i) => c.id === chunks[i]!.id)
    ) {
      return {
        kind: "upToDate",
        file: input.file,
        lockfilePath: lockfilePathFor(input.file),
        chunkCount: chunks.length,
        plan,
      };
    }
  }

  const db = await resolveVectorDb({
    db: input.resolved.db,
    config: input.config,
    env,
    local: input.local,
  });

  await assertCollectionDim(db, plan.collection, dim);

  const oldIds = lock?.chunks.map((c) => c.id) ?? [];
  const newIds = chunks.map((c) => c.id);
  const diff = diffChunks(oldIds, newIds);

  const toEmbed = input.force
    ? chunks
    : chunks.filter((c, i) => !lock || !lock.chunks[i] || lock.chunks[i]!.id !== c.id);

  if (toEmbed.length > 0) {
    log.info(pc.dim(`embedding ${toEmbed.length} new chunk${toEmbed.length === 1 ? "" : "s"} via ${provider.name}…`));
  }

  const embedded = await embedChunks(toEmbed, provider, {
    model: plan.embeddingModel,
    batchSize: input.overrides?.batchSize,
    concurrency: input.overrides?.concurrency,
  });

  await db.ensureCollection(plan.collection, dim);
  if (embedded.length > 0) await db.upsert(plan.collection, embedded);
  if (diff.removed.length > 0) await db.deleteByIds(plan.collection, diff.removed);

  const newLock: Lockfile = {
    version: 1,
    sourcePath: input.file,
    sourceHash,
    chunkerVersion: CHUNKER_VERSION,
    embeddingProvider: provider.name,
    embeddingModel: plan.embeddingModel,
    dimensions: dim,
    collection: plan.collection,
    vectorDb: db.name,
    planHash,
    chunks: chunks.map((c) => ({ id: c.id, meta: c.meta })),
    timestamp: new Date().toISOString(),
  };
  const lockfilePath = await writeLockfile(newLock);

  await db.close?.();

  return {
    kind: "embedded",
    file: input.file,
    lockfilePath,
    plan,
    addedCount: diff.added.length || toEmbed.length,
    removedCount: diff.removed.length,
    keptCount: diff.kept.length,
    durationMs: Date.now() - start,
  };
}

function lockfileIntegrityCheck(
  lock: Lockfile,
  resolved: PipelineInput["resolved"],
  plan: EmbedPlan,
  dim: number,
): { message: string; hint: string } | null {
  if (lock.embeddingModel !== plan.embeddingModel) {
    return {
      message: `Embedding model changed (${lock.embeddingModel} → ${plan.embeddingModel}). Refusing to mix dimensions in collection "${lock.collection}".`,
      hint: "Re-run with --force, or pick a fresh --collection name.",
    };
  }
  if (lock.dimensions !== dim) {
    return {
      message: `Embedding dimensions changed (${lock.dimensions} → ${dim}). Refusing to corrupt collection "${lock.collection}".`,
      hint: "Re-run with --force, or pick a fresh --collection name.",
    };
  }
  if (lock.embeddingProvider !== resolved.provider) {
    return {
      message: `Embedding provider changed (${lock.embeddingProvider} → ${resolved.provider}).`,
      hint: "Re-run with --force if you want to replace existing vectors.",
    };
  }
  return null;
}

async function assertCollectionDim(db: VectorDB, collection: string, dim: number): Promise<void> {
  const info = await db.describeCollection(collection);
  if (!info) return;
  if (info.dim !== 0 && info.dim !== dim) {
    throw new AutoEmbedError(
      `Vector DB collection "${collection}" has dim ${info.dim}, but the chosen model produces dim ${dim}.`,
      ExitCode.Integrity,
      "Pick a different --collection or use a model with matching dimensions.",
    );
  }
}
