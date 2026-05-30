import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffChunks,
  hashFile,
  Lockfile,
  lockfileExists,
  lockfilePathFor,
  readLockfile,
  writeLockfile,
} from "../src/lockfile.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-lock-"));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function fakeLock(overrides: Partial<Lockfile> = {}): Lockfile {
  return {
    version: 1,
    sourcePath: path.join(tmp, "input.txt"),
    sourceHash: "a".repeat(64),
    chunkerVersion: "1",
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    dimensions: 1536,
    collection: "test",
    vectorDb: "chroma",
    planHash: "b".repeat(64),
    chunks: [
      { id: "0123456789abcdef", meta: {} },
      { id: "fedcba9876543210", meta: { page: 2 } },
    ],
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("lockfilePathFor", () => {
  it("lives in <baseDir>/.auto-embed/<16-hex>.lock.json", () => {
    const p = lockfilePathFor("/abs/path/to/file.md", tmp);
    expect(p.startsWith(path.join(tmp, ".auto-embed"))).toBe(true);
    expect(p.endsWith(".lock.json")).toBe(true);
    const base = path.basename(p, ".lock.json");
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for the same absolute path", () => {
    expect(lockfilePathFor("/abs/x.md", tmp)).toBe(lockfilePathFor("/abs/x.md", tmp));
  });

  it("differs across distinct paths", () => {
    expect(lockfilePathFor("/abs/x.md", tmp)).not.toBe(lockfilePathFor("/abs/y.md", tmp));
  });
});

describe("hashFile", () => {
  it("is the same for two reads of the same file", async () => {
    const file = path.join(tmp, "x.txt");
    await fsp.writeFile(file, "hello world");
    expect(await hashFile(file)).toBe(await hashFile(file));
  });

  it("changes when the file content changes", async () => {
    const file = path.join(tmp, "x.txt");
    await fsp.writeFile(file, "hello");
    const a = await hashFile(file);
    await fsp.writeFile(file, "world");
    const b = await hashFile(file);
    expect(a).not.toBe(b);
  });

  it("throws AutoEmbedError when the file is missing", async () => {
    await expect(hashFile(path.join(tmp, "ghost.txt"))).rejects.toThrow(/not found/i);
  });
});

describe("read/write lockfile", () => {
  it("round-trips through disk", async () => {
    const lock = fakeLock();
    const written = await writeLockfile(lock, tmp);
    expect(lockfileExists(lock.sourcePath, tmp)).toBe(true);
    const back = await readLockfile(lock.sourcePath, tmp);
    expect(back).toEqual(lock);
    expect(written).toBe(lockfilePathFor(lock.sourcePath, tmp));
  });

  it("returns null when no lockfile exists", async () => {
    expect(await readLockfile("/no/such/file.md", tmp)).toBeNull();
  });

  it("rejects a malformed lockfile JSON", async () => {
    const lock = fakeLock();
    const lockPath = lockfilePathFor(lock.sourcePath, tmp);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, "{ not json");
    await expect(readLockfile(lock.sourcePath, tmp)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a lockfile that fails the schema", async () => {
    const lock = fakeLock();
    const lockPath = lockfilePathFor(lock.sourcePath, tmp);
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, JSON.stringify({ ...lock, dimensions: -1 }));
    await expect(readLockfile(lock.sourcePath, tmp)).rejects.toThrow(/invalid/);
  });
});

describe("diffChunks", () => {
  it("identifies added, removed, and kept by ID", () => {
    const diff = diffChunks(["a", "b", "c"], ["b", "c", "d"]);
    expect(diff.added).toEqual(["d"]);
    expect(diff.removed).toEqual(["a"]);
    expect(diff.kept).toEqual(["b", "c"]);
  });

  it("returns empty diff when ids are identical", () => {
    expect(diffChunks(["x", "y"], ["x", "y"])).toEqual({
      added: [],
      removed: [],
      kept: ["x", "y"],
    });
  });

  it("handles a totally new set", () => {
    expect(diffChunks([], ["a"])).toEqual({ added: ["a"], removed: [], kept: [] });
    expect(diffChunks(["a"], [])).toEqual({ added: [], removed: ["a"], kept: [] });
  });
});
