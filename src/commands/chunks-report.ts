import fsp from "node:fs/promises";
import path from "node:path";
import { Chunk } from "../chunker/index.js";
import { countTokensSync } from "../chunker/tokens.js";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { EmbedPlan } from "../plan/schema.js";

export interface ChunkReportEntry {
  file: string;
  plan: EmbedPlan;
  chunks: Chunk[];
}

export function defaultChunksReportPath(file: string): string {
  const { name } = path.parse(file);
  return path.resolve(`${name}-chunks.txt`);
}

export function renderChunksReport(entries: ChunkReportEntry[]): string {
  const totalChunks = entries.reduce((sum, entry) => sum + entry.chunks.length, 0);
  const lines = [
    "auto-embed chunk preview",
    `Files: ${entries.length}`,
    `Chunks: ${totalChunks}`,
    "",
  ];

  for (const [fileIndex, entry] of entries.entries()) {
    lines.push(
      "=".repeat(80),
      `FILE ${fileIndex + 1} OF ${entries.length}`,
      `Source: ${entry.file}`,
      `Splitter: ${entry.plan.splitter}`,
      `Chunk size: ${entry.plan.chunkSize} tokens`,
      `Overlap: ${entry.plan.overlap} tokens`,
      `Chunks: ${entry.chunks.length}`,
      "=".repeat(80),
      "",
    );

    for (const [chunkIndex, chunk] of entry.chunks.entries()) {
      lines.push(
        "-".repeat(80),
        `CHUNK ${chunkIndex + 1} OF ${entry.chunks.length}`,
        `ID: ${chunk.id}`,
        `Tokens: ${countTokensSync(chunk.text)}`,
        `Metadata: ${JSON.stringify(chunk.meta)}`,
        "-".repeat(80),
        chunk.text,
        "",
      );
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

export async function writeChunksReport(
  entries: ChunkReportEntry[],
  outputPath: string,
): Promise<string> {
  if (path.extname(outputPath).toLowerCase() !== ".txt") {
    throw new AutoEmbedError(
      `Chunk preview output must be a .txt file: "${outputPath}"`,
      ExitCode.UserConfig,
      "Use --out chunks.txt",
    );
  }

  const resolvedPath = path.resolve(outputPath);
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fsp.writeFile(resolvedPath, renderChunksReport(entries), "utf8");
  return resolvedPath;
}
