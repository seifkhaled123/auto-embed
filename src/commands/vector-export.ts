import fsp, { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Embedded } from "../embed/engine.js";
import { AutoEmbedError, ExitCode } from "../errors.js";

export interface VectorExportWriter {
  append(sourcePath: string, rows: readonly Embedded[]): Promise<void>;
  commit(): Promise<string>;
  abort(): Promise<void>;
}

export async function createVectorExportWriter(outputPath: string): Promise<VectorExportWriter> {
  const finalPath = path.resolve(outputPath);
  if (path.extname(finalPath).toLowerCase() !== ".jsonl") {
    throw new AutoEmbedError(
      `Vector export path must be a .jsonl file: ${outputPath}`,
      ExitCode.UserConfig,
    );
  }

  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${process.pid}.tmp`,
  );
  const handle = await fsp.open(tempPath, "w");
  let state: "open" | "committed" | "aborted" = "open";

  return {
    async append(sourcePath, rows) {
      assertOpen(state);
      for (const row of rows) {
        await handle.write(
          JSON.stringify({
            sourcePath,
            id: row.id,
            text: row.text,
            metadata: row.meta,
            model: row.model,
            dimensions: row.dim,
            vector: row.vector,
          }) + "\n",
        );
      }
    },

    async commit() {
      assertOpen(state);
      try {
        await handle.sync();
        await handle.close();
        await fsp.rename(tempPath, finalPath);
        state = "committed";
        return finalPath;
      } catch (err) {
        state = "aborted";
        await closeQuietly(handle);
        await fsp.rm(tempPath, { force: true });
        throw new AutoEmbedError(
          `Failed to write vector export ${finalPath}: ${(err as Error).message}`,
          ExitCode.UserConfig,
        );
      }
    },

    async abort() {
      if (state !== "open") return;
      state = "aborted";
      await closeQuietly(handle);
      await fsp.rm(tempPath, { force: true });
    },
  };
}

function assertOpen(state: "open" | "committed" | "aborted"): void {
  if (state !== "open") {
    throw new AutoEmbedError(
      `Vector export is already ${state}.`,
      ExitCode.Integrity,
    );
  }
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The original write or rename failure is more actionable.
  }
}
