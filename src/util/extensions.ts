import path from "node:path";

const CONTENT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".pdf",
  ".html",
  ".htm",
  ".docx",
  ".csv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".txt",
  ".text",
  ".log",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
]);

/**
 * Return the extension that describes a file's content. Downloaders and
 * archive tools commonly resolve name collisions by appending a numeric
 * suffix (`guide.md.1`, `data.csv.2`). Recover the preceding extension only
 * when it is one the application explicitly supports, so ordinary names such
 * as `release.2026` still take the unknown-extension path.
 */
export function contentExtension(sourcePath: string): string {
  const lower = sourcePath.toLowerCase();
  const extension = path.extname(lower);
  if (!/^\.\d+$/.test(extension)) return extension;

  const preceding = path.extname(lower.slice(0, -extension.length));
  return CONTENT_EXTENSIONS.has(preceding) ? preceding : extension;
}
