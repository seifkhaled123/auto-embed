import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AutoEmbedError, ExitCode } from "./errors.js";

export const LOCKFILE_DIR = ".auto-embed";

export const LockfileSchema = z.object({
  version: z.literal(1),
  sourcePath: z.string(),
  sourceHash: z.string().length(64),
  chunkerVersion: z.string(),
  embeddingProvider: z.string(),
  embeddingModel: z.string(),
  dimensions: z.number().int().positive(),
  collection: z.string(),
  vectorDb: z.string(),
  planHash: z.string().length(64),
  chunks: z.array(
    z.object({
      id: z.string().length(16),
      meta: z.record(z.unknown()),
    }),
  ),
  timestamp: z.string().datetime(),
});
export type Lockfile = z.infer<typeof LockfileSchema>;

/** Lockfile path: ./.auto-embed/<sha256(absPath)[:16]>.lock.json. */
export function lockfilePathFor(sourcePath: string, baseDir: string = process.cwd()): string {
  const abs = path.resolve(sourcePath);
  const id = crypto.createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return path.join(baseDir, LOCKFILE_DIR, `${id}.lock.json`);
}

export async function hashFile(sourcePath: string): Promise<string> {
  try {
    const buf = await fsp.readFile(sourcePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to hash ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Integrity,
    );
  }
}

export async function readLockfile(sourcePath: string, baseDir?: string): Promise<Lockfile | null> {
  const lockPath = lockfilePathFor(sourcePath, baseDir);
  try {
    const raw = await fsp.readFile(lockPath, "utf8");
    return LockfileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? ` (at ${first.path.join(".")})` : "";
      throw new AutoEmbedError(
        `Lockfile at ${lockPath} is invalid: ${first?.message ?? "unknown"}${where}`,
        ExitCode.Integrity,
        "Delete the lockfile to re-embed from scratch.",
      );
    }
    if (err instanceof SyntaxError) {
      throw new AutoEmbedError(
        `Lockfile at ${lockPath} is not valid JSON.`,
        ExitCode.Integrity,
        "Delete the lockfile to re-embed from scratch.",
      );
    }
    throw err;
  }
}

export async function writeLockfile(lock: Lockfile, baseDir?: string): Promise<string> {
  const lockPath = lockfilePathFor(lock.sourcePath, baseDir);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const tmp = `${lockPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(lock, null, 2) + "\n");
  await fsp.rename(tmp, lockPath);
  return lockPath;
}

export function lockfileExists(sourcePath: string, baseDir?: string): boolean {
  return fs.existsSync(lockfilePathFor(sourcePath, baseDir));
}

export interface ChunkDiff {
  added: string[];
  removed: string[];
  kept: string[];
}

export function diffChunks(oldIds: string[], newIds: string[]): ChunkDiff {
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const id of newIds) {
    if (oldSet.has(id)) kept.push(id);
    else added.push(id);
  }
  for (const id of oldIds) {
    if (!newSet.has(id)) removed.push(id);
  }
  return { added, removed, kept };
}
