import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { Embedded } from "../embed/engine.js";
import { log } from "../log.js";
import { CollectionInfo, VectorDB } from "./types.js";

interface ChromaArgs {
  /** Connection URL (e.g. http://localhost:8000) or a filesystem path (./chroma). */
  url: string;
  /** When true, auto-spawn a `chroma run` server if nothing is listening. */
  autoSpawn?: boolean;
}

interface ChromaCollection {
  upsert(args: {
    ids: string[];
    embeddings: number[][];
    metadatas?: Record<string, unknown>[];
    documents?: string[];
  }): Promise<unknown>;
  delete(args: { ids: string[] }): Promise<unknown>;
  count(): Promise<number>;
}

interface ChromaClientLike {
  getCollection(args: { name: string; embeddingFunction?: unknown | null }): Promise<ChromaCollection>;
  createCollection(args: { name: string; embeddingFunction?: unknown | null; metadata?: Record<string, unknown> }): Promise<ChromaCollection>;
  getOrCreateCollection(args: { name: string; embeddingFunction?: unknown | null; metadata?: Record<string, unknown> }): Promise<ChromaCollection>;
}

interface ChromaClientCtor {
  new (args: { host: string; port: number; ssl: boolean }): ChromaClientLike;
}

interface ParsedTarget {
  host: string;
  port: number;
  ssl: boolean;
  localPath: string | null;
}

function parseTarget(target: string): ParsedTarget {
  // Filesystem-style: starts with "./", "/", "~", or has no scheme and no host:port.
  if (target.startsWith("./") || target.startsWith("../") || target.startsWith("/") || target.startsWith("~")) {
    return { host: "localhost", port: 8000, ssl: false, localPath: target };
  }
  try {
    const u = new URL(target);
    return {
      host: u.hostname || "localhost",
      port: u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 8000,
      ssl: u.protocol === "https:",
      localPath: null,
    };
  } catch {
    return { host: "localhost", port: 8000, ssl: false, localPath: target };
  }
}

async function isHealthy(host: string, port: number, ssl: boolean, timeoutMs = 1000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ssl ? "https" : "http"}://${host}:${port}/api/v2/heartbeat`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitHealthy(host: string, port: number, ssl: boolean, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(host, port, ssl, 1000)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new AutoEmbedError(
    `Chroma server at ${host}:${port} did not become healthy within ${timeoutMs}ms.`,
    ExitCode.VectorDb,
  );
}

function chromaBinaryPath(): string {
  // Resolve "chroma" via the local node_modules/.bin so the user doesn't need
  // it on $PATH. Climbs from this module's location.
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "node_modules", ".bin", process.platform === "win32" ? "chroma.exe" : "chroma");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "chroma"; // fall back to PATH
}

class ChromaAdapter implements VectorDB {
  readonly name = "chroma";
  private clientPromise: Promise<ChromaClientLike> | null = null;
  private child: ChildProcess | null = null;
  private readonly target: ParsedTarget;

  constructor(private readonly args: ChromaArgs) {
    this.target = parseTarget(args.url);
  }

  private async ensureClient(): Promise<ChromaClientLike> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const { host, port, ssl, localPath } = this.target;
      if (!(await isHealthy(host, port, ssl, 500))) {
        if (this.args.autoSpawn === false) {
          throw new AutoEmbedError(
            `Chroma is not reachable at ${host}:${port}.`,
            ExitCode.VectorDb,
            `Start it in another terminal: \`chroma run${localPath ? ` --path ${localPath}` : ""}\``,
          );
        }
        await this.spawnLocal(localPath ?? "./chroma");
        await waitHealthy(host, port, ssl);
      }
      const mod = (await import("chromadb")) as unknown as { ChromaClient: ChromaClientCtor };
      return new mod.ChromaClient({ host, port, ssl });
    })();
    return this.clientPromise;
  }

  private async spawnLocal(persistPath: string): Promise<void> {
    const abs = path.resolve(persistPath);
    await fsp.mkdir(abs, { recursive: true });
    const bin = chromaBinaryPath();
    log.debug(`spawning ${bin} run --path ${abs} --host ${this.target.host} --port ${this.target.port}`);
    // stdio: "ignore" on all streams so the parent's event loop doesn't keep
    // the chroma child's pipes open after the embed finishes — otherwise the
    // process never exits even after close() kills the child.
    const child = spawn(
      bin,
      ["run", "--path", abs, "--host", this.target.host, "--port", String(this.target.port)],
      { stdio: "ignore", detached: false },
    );
    child.on("error", (err) => {
      log.debug(`[chroma] spawn error: ${err.message}`);
    });
    this.child = child;
    // unref so the parent CLI exits as soon as its own work is done — the
    // chroma server lives on as a local daemon, ready for the next run.
    // We deliberately do NOT signal it on close(): SIGTERM left the Rust
    // binding's HTTP listener in a half-alive state where the socket still
    // accepts connections but no longer answers them, breaking later runs.
    child.unref();
  }

  async ensureCollection(name: string, dim: number): Promise<void> {
    const client = await this.ensureClient();
    await client.getOrCreateCollection({
      name,
      embeddingFunction: null,
      metadata: { "auto-embed.dim": dim },
    });
  }

  async describeCollection(name: string): Promise<CollectionInfo | null> {
    const client = await this.ensureClient();
    let coll: ChromaCollection;
    try {
      coll = await client.getCollection({ name, embeddingFunction: null });
    } catch (err) {
      if (isChromaNotFound(err)) return null;
      const msg = (err as Error).message ?? "";
      throw new AutoEmbedError(
        `chroma: failed to describe collection "${name}": ${msg}`,
        ExitCode.VectorDb,
      );
    }
    // Chroma collections don't store dim explicitly; infer from first vector.
    // We only need dim for the mismatch-guard, so a zero-count collection
    // returns dim=0 (treated as "unknown — allow write").
    try {
      const count = await coll.count();
      if (count === 0) return { dim: 0 };
    } catch {
      // ignore; fall through
    }
    return { dim: 0 };
  }

  async upsert(collection: string, rows: Embedded[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.ensureClient();
    const coll = await client.getOrCreateCollection({
      name: collection,
      embeddingFunction: null,
    });
    try {
      await coll.upsert({
        ids: rows.map((r) => r.id),
        embeddings: rows.map((r) => r.vector),
        documents: rows.map((r) => r.text),
        metadatas: rows.map((r) => sanitizeMeta(r.meta)),
      });
    } catch (err) {
      throw new AutoEmbedError(
        `chroma: upsert failed: ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const client = await this.ensureClient();
    try {
      const coll = await client.getCollection({
        name: collection,
        embeddingFunction: null,
      });
      await coll.delete({ ids });
    } catch (err) {
      if (isChromaNotFound(err)) return;
      throw new AutoEmbedError(
        `chroma: delete failed: ${(err as Error).message}`,
        ExitCode.VectorDb,
      );
    }
  }

  async close(): Promise<void> {
    // Intentional no-op. The spawned chroma server stays up as a local daemon
    // so subsequent CLI invocations reuse it. See spawnLocal() for context.
    this.child = null;
  }
}

function isChromaNotFound(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  if (e.name === "ChromaNotFoundError") return true;
  const msg = e.message ?? "";
  return /not\s*found|does not exist|could not be found/i.test(msg);
}

/** Chroma rejects nested objects / arrays in metadata. Flatten to scalars. */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.join("/");
    } else if (typeof v === "object") {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

export function createChromaAdapter(args: ChromaArgs): VectorDB {
  return new ChromaAdapter(args);
}
