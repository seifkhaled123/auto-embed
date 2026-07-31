import fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { glob, isDynamicPattern } from "tinyglobby";
import { AutoEmbedError, ExitCode } from "../errors.js";

const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.auto-embed/**",
  "**/dist/**",
  "**/chroma/**",
];
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".auto-embed",
  "dist",
  "chroma",
]);

export async function expandInputArgs(
  inputs: readonly string[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const resolved = new Set<string>();

  for (const input of inputs) {
    const direct = path.resolve(cwd, input);
    const directStat = await lstatIfExists(direct);
    let matches: string[] = [];

    if (directStat?.isFile()) {
      matches = [direct];
    } else if (directStat?.isDirectory()) {
      matches = await expandDirectory(direct);
    } else if (directStat?.isSymbolicLink()) {
      const target = await statSymlinkTarget(direct);
      if (target.isDirectory()) {
        throw new AutoEmbedError(
          `Refusing to recurse through symlinked directory: ${input}`,
          ExitCode.UserConfig,
          "Pass files inside the real directory, or use a glob that does not traverse the symlink.",
        );
      }
      if (target.isFile()) matches = [direct];
    } else if (isDynamicPattern(input)) {
      matches = (await glob(input, globOptions(cwd))).filter((match) => !isIgnoredMatch(match));
    }

    if (matches.length === 0) {
      throw new AutoEmbedError(
        `Input matched no files: ${input}`,
        ExitCode.UserConfig,
        "Check the path or glob pattern. Quote globs so auto-embed expands them consistently.",
      );
    }

    for (const match of matches) resolved.add(path.resolve(match));
  }

  return [...resolved].sort(comparePaths);
}

async function expandDirectory(directory: string): Promise<string[]> {
  return (await glob("**/*", globOptions(directory))).filter(
    (match) => !isIgnoredMatch(path.relative(directory, match)),
  );
}

function globOptions(cwd: string) {
  return {
    absolute: true,
    cwd,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    ignore: DEFAULT_IGNORES,
  } as const;
}

async function lstatIfExists(target: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AutoEmbedError(
      `Failed to inspect input ${target}: ${(err as Error).message}`,
      ExitCode.UserConfig,
    );
  }
}

async function statSymlinkTarget(target: string): Promise<Stats> {
  try {
    return await fsp.stat(target);
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to resolve symlink ${target}: ${(err as Error).message}`,
      ExitCode.UserConfig,
    );
  }
}

function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isIgnoredMatch(match: string): boolean {
  return path.normalize(match).split(path.sep).some((part) => IGNORED_DIRECTORY_NAMES.has(part));
}
