import path from "node:path";
import { EmbedPlan, EmbedPlanSchema, SplitterName } from "./schema.js";

interface HeuristicInput {
  sourcePath: string;
  embeddingModel: string;
  /** Optional overrides from CLI flags. */
  overrides?: Partial<Pick<EmbedPlan, "splitter" | "chunkSize" | "overlap" | "collection" | "metadata">>;
}

const EXT_TO_SPLITTER: Record<string, SplitterName> = {
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".pdf": "pdf",
  ".html": "html",
  ".htm": "html",
  ".docx": "markdown", // mammoth → markdown
  ".csv": "csv",
  ".json": "recursive",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".txt": "recursive",
  ".text": "recursive",
  ".log": "recursive",
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".mjs": "code",
  ".cjs": "code",
  ".py": "code",
  ".go": "code",
  ".rs": "code",
  ".java": "code",
};

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_OVERLAP = 100;

/** Per-splitter chunk-size override. CSV/JSONL chunks are row-sized; setting a
 *  huge cap lets even chatty rows through without splitting. */
const CHUNK_SIZE_OVERRIDES: Partial<Record<SplitterName, number>> = {
  csv: 4096,
  jsonl: 4096,
};

export function heuristicPlan(input: HeuristicInput): EmbedPlan {
  const ext = path.extname(input.sourcePath).toLowerCase();
  const splitter: SplitterName =
    input.overrides?.splitter ?? EXT_TO_SPLITTER[ext] ?? "recursive";
  const chunkSize =
    input.overrides?.chunkSize ?? CHUNK_SIZE_OVERRIDES[splitter] ?? DEFAULT_CHUNK_SIZE;
  const overlap = input.overrides?.overlap ?? DEFAULT_OVERLAP;
  const collection = input.overrides?.collection ?? deriveCollectionName(input.sourcePath);

  const plan: EmbedPlan = {
    version: 1,
    splitter,
    chunkSize,
    overlap,
    metadata: input.overrides?.metadata ?? {},
    collection,
    embeddingModel: input.embeddingModel,
  };

  return EmbedPlanSchema.parse(plan);
}

/**
 * Filename → kebab-case collection. "Foo Bar.PDF" → "foo-bar".
 * Strips the extension and any leading characters that the schema regex
 * forbids.
 */
export function deriveCollectionName(sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z0-9]+/, "");
  return slug || "default";
}
