import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AutoEmbedError, ExitCode } from "./errors.js";
import { LOCKFILE_DIR } from "./lockfile.js";

export const JOBS_DIR = "jobs";

const ChunkIdSchema = z.string().length(16);

export const JobManifestSchema = z.object({
  version: z.literal(1),
  jobKey: z.string().length(64),
  sourcePath: z.string(),
  sourceHash: z.string().length(64),
  planHash: z.string().length(64),
  embeddingProvider: z.string(),
  embeddingModel: z.string(),
  dimensions: z.number().int().positive(),
  collection: z.string(),
  vectorDb: z.string(),
  targetChunkIds: z.array(ChunkIdSchema),
  removedChunkIds: z.array(ChunkIdSchema),
  completedChunkIds: z.array(ChunkIdSchema),
  timestamp: z.string().datetime(),
});
export type JobManifest = z.infer<typeof JobManifestSchema>;

export interface JobSpec {
  sourcePath: string;
  sourceHash: string;
  planHash: string;
  embeddingProvider: string;
  embeddingModel: string;
  dimensions: number;
  collection: string;
  vectorDb: string;
  targetChunkIds: readonly string[];
  removedChunkIds: readonly string[];
}

export interface JobStateOptions {
  baseDir?: string;
  reset?: boolean;
}

export function jobKeyFor(spec: JobSpec): string {
  const canonical = JSON.stringify({
    sourcePath: path.resolve(spec.sourcePath),
    sourceHash: spec.sourceHash,
    planHash: spec.planHash,
    embeddingProvider: spec.embeddingProvider,
    embeddingModel: spec.embeddingModel,
    dimensions: spec.dimensions,
    collection: spec.collection,
    vectorDb: spec.vectorDb,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function jobManifestPathFor(
  spec: JobSpec,
  baseDir: string = process.cwd(),
): string {
  return path.join(baseDir, LOCKFILE_DIR, JOBS_DIR, `${jobKeyFor(spec)}.job.json`);
}

export async function loadOrCreateJob(
  spec: JobSpec,
  options: JobStateOptions = {},
): Promise<JobManifest> {
  const manifestPath = jobManifestPathFor(spec, options.baseDir);
  if (options.reset) await fsp.rm(manifestPath, { force: true });

  const existing = await readManifest(manifestPath);
  if (existing) {
    assertMatchesSpec(existing, spec);
    return existing;
  }

  const manifest: JobManifest = {
    version: 1,
    jobKey: jobKeyFor(spec),
    sourcePath: path.resolve(spec.sourcePath),
    sourceHash: spec.sourceHash,
    planHash: spec.planHash,
    embeddingProvider: spec.embeddingProvider,
    embeddingModel: spec.embeddingModel,
    dimensions: spec.dimensions,
    collection: spec.collection,
    vectorDb: spec.vectorDb,
    targetChunkIds: [...spec.targetChunkIds],
    removedChunkIds: [...spec.removedChunkIds],
    completedChunkIds: [],
    timestamp: new Date().toISOString(),
  };
  await writeManifest(manifest, options.baseDir);
  return manifest;
}

export async function checkpointJob(
  manifest: JobManifest,
  completedIds: readonly string[],
  options: JobStateOptions = {},
): Promise<JobManifest> {
  const allowed = new Set(manifest.targetChunkIds);
  for (const id of completedIds) {
    if (!allowed.has(id)) {
      throw new AutoEmbedError(
        `Chunk ${id} is not part of job ${manifest.jobKey}.`,
        ExitCode.Integrity,
      );
    }
  }

  const completed = new Set([...manifest.completedChunkIds, ...completedIds]);
  const updated: JobManifest = {
    ...manifest,
    completedChunkIds: manifest.targetChunkIds.filter((id) => completed.has(id)),
    timestamp: new Date().toISOString(),
  };
  await writeManifest(updated, options.baseDir);
  return updated;
}

export async function removeJob(
  manifest: JobManifest | JobSpec,
  options: JobStateOptions = {},
): Promise<void> {
  await fsp.rm(jobManifestPathFor(manifest, options.baseDir), { force: true });
}

async function readManifest(manifestPath: string): Promise<JobManifest | null> {
  try {
    const raw = await fsp.readFile(manifestPath, "utf8");
    return JobManifestSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof z.ZodError || err instanceof SyntaxError) {
      throw new AutoEmbedError(
        `Job manifest at ${manifestPath} is invalid.`,
        ExitCode.Integrity,
        "Remove the invalid job file to restart this ingestion safely.",
      );
    }
    throw new AutoEmbedError(
      `Failed to read job manifest ${manifestPath}: ${(err as Error).message}`,
      ExitCode.Integrity,
    );
  }
}

async function writeManifest(manifest: JobManifest, baseDir?: string): Promise<void> {
  const manifestPath = jobManifestPathFor(manifest, baseDir);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tempPath, JSON.stringify(manifest, null, 2) + "\n");
    await fsp.rename(tempPath, manifestPath);
  } catch (err) {
    await fsp.rm(tempPath, { force: true });
    throw new AutoEmbedError(
      `Failed to write job manifest ${manifestPath}: ${(err as Error).message}`,
      ExitCode.Integrity,
    );
  }
}

function assertMatchesSpec(manifest: JobManifest, spec: JobSpec): void {
  if (manifest.jobKey !== jobKeyFor(spec)) {
    throw new AutoEmbedError(
      `Job manifest key mismatch for ${spec.sourcePath}.`,
      ExitCode.Integrity,
      "Remove the invalid job file to restart this ingestion safely.",
    );
  }
  const expectedTarget = JSON.stringify(spec.targetChunkIds);
  const expectedRemoved = JSON.stringify(spec.removedChunkIds);
  if (
    JSON.stringify(manifest.targetChunkIds) !== expectedTarget ||
    JSON.stringify(manifest.removedChunkIds) !== expectedRemoved
  ) {
    throw new AutoEmbedError(
      `Job manifest chunk set changed for ${spec.sourcePath}.`,
      ExitCode.Integrity,
      "Remove the invalid job file to restart this ingestion safely.",
    );
  }
}
