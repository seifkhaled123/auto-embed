import path from "node:path";
import { Command } from "commander";
import { chunkDocument } from "../chunker/index.js";
import { countTokensSync, primeTokenizer } from "../chunker/tokens.js";
import {
  DEFAULT_MODELS,
  EmbeddingProviderName,
  envApiKey,
  loadConfig,
  resolveRuntime,
  VectorDbName,
} from "../config/index.js";
import { runPipeline } from "../embed/pipeline.js";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { log, pc } from "../log.js";
import { parseFile } from "../parsers/index.js";
import { heuristicPlan } from "../plan/heuristic.js";
import { EmbedPlan, hashPlan, SplitterName } from "../plan/schema.js";

interface EmbedOpts {
  collection?: string;
  provider?: EmbeddingProviderName;
  model?: string;
  db?: VectorDbName;
  local?: boolean;
  splitter?: SplitterName;
  chunkSize?: number;
  overlap?: number;
  metadata?: string;
  batchSize?: number;
  concurrency?: number;
  force?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export function buildEmbedCommand(): Command {
  return new Command("embed")
    .description("Parse, chunk, embed, and upsert one or more files into a vector DB")
    .argument("<files...>", "files or globs to ingest")
    .option("--collection <name>", "vector-DB collection / index / table name")
    .option("--provider <name>", "openai | google | voyage | cohere | local")
    .option("--model <id>", "embedding model override")
    .option("--db <name>", "pgvector | pinecone | qdrant | chroma")
    .option("--local", "shortcut: provider=local + db=chroma at ./chroma")
    .option("--chunk-size <n>", "target chunk size in tokens", (v) => parseInt(v, 10))
    .option("--overlap <n>", "token overlap between chunks", (v) => parseInt(v, 10))
    .option("--splitter <type>", "recursive | markdown | pdf | html | code | jsonl | csv")
    .option("--metadata <kv>", "static metadata k=v,k=v attached to every chunk")
    .option("--plan [path]", "tune the plan with one LLM call, or reuse a saved plan")
    .option("--plan-only", "write the plan and stop")
    .option("--batch-size <n>", "embedding batch size", (v) => parseInt(v, 10))
    .option("--concurrency <n>", "parallel embedding requests", (v) => parseInt(v, 10))
    .option("--force", "ignore lockfile; re-embed and replace")
    .option("--dry-run", "show what would happen; embed nothing")
    .option("--out-vectors <path>", "also write vectors to a local .jsonl")
    .option("-y, --yes", "non-interactive mode")
    .action(async (files: string[], opts: EmbedOpts) => {
      if (opts.dryRun) {
        for (const file of files) await runDryRun(file, opts);
        return;
      }
      for (const file of files) await runReal(file, opts);
    });
}

function applyLocalShortcut(opts: EmbedOpts): EmbedOpts {
  if (!opts.local) return opts;
  return {
    ...opts,
    provider: opts.provider ?? "local",
    db: opts.db ?? "chroma",
  };
}

async function runReal(file: string, rawOpts: EmbedOpts): Promise<void> {
  const opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();

  const env = process.env;
  // Resolve provider / model / db without forcing a key when --local.
  const provider: EmbeddingProviderName =
    opts.provider ??
    (env.AUTO_EMBED_PROVIDER as EmbeddingProviderName | undefined) ??
    cfg.defaults?.provider ??
    "openai";
  const model =
    opts.model ??
    env.AUTO_EMBED_MODEL ??
    cfg.defaults?.model ??
    cfg.models?.[provider] ??
    DEFAULT_MODELS[provider];
  const db: VectorDbName =
    opts.db ?? (env.AUTO_EMBED_DB as VectorDbName | undefined) ?? cfg.defaults?.db ?? "chroma";

  let apiKey = "";
  if (provider !== "local") {
    const resolved = resolveRuntime(cfg, { provider, model, db }, env);
    apiKey = resolved.apiKey;
  }

  const outcome = await runPipeline({
    file,
    config: cfg,
    env,
    resolved: { provider, model, apiKey, db },
    local: opts.local,
    force: opts.force,
    overrides: {
      collection: opts.collection,
      splitter: opts.splitter,
      chunkSize: opts.chunkSize,
      overlap: opts.overlap,
      metadata: opts.metadata ? parseMetadata(opts.metadata) : undefined,
      batchSize: opts.batchSize,
      concurrency: opts.concurrency,
    },
  });

  printOutcome(outcome);
}

function printOutcome(outcome: Awaited<ReturnType<typeof runPipeline>>): void {
  // Final-line summary goes to stdout so it's pipeable to grep / a log
  // shipper. Progress chatter still goes to stderr via log.*.
  const base = path.basename(outcome.file);
  if (outcome.kind === "upToDate") {
    process.stdout.write(
      `${pc.green("✓")} ${pc.bold(base)} up to date (${outcome.chunkCount} chunk${outcome.chunkCount === 1 ? "" : "s"}, no API calls).\n`,
    );
    return;
  }
  const { addedCount, removedCount, plan, durationMs } = outcome;
  const seconds = (durationMs / 1000).toFixed(2);
  const removed = removedCount > 0 ? ` (removed ${removedCount})` : "";
  process.stdout.write(
    `${pc.green("✓")} embedded ${addedCount} chunk${addedCount === 1 ? "" : "s"}${removed} from ${pc.bold(base)} into ${plan.collection} in ${seconds}s\n`,
  );
}

async function runDryRun(file: string, rawOpts: EmbedOpts): Promise<void> {
  const opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();
  const provider: EmbeddingProviderName = opts.provider ?? cfg.defaults?.provider ?? "openai";
  const model =
    opts.model ?? cfg.defaults?.model ?? cfg.models?.[provider] ?? DEFAULT_MODELS[provider];

  const plan: EmbedPlan = heuristicPlan({
    sourcePath: file,
    embeddingModel: model,
    overrides: {
      splitter: opts.splitter,
      chunkSize: opts.chunkSize,
      overlap: opts.overlap,
      collection: opts.collection,
      metadata: opts.metadata ? parseMetadata(opts.metadata) : undefined,
    },
  });

  const document = await parseFile(file);
  await primeTokenizer();
  const chunks = await chunkDocument(document, plan);

  printPlan(file, plan);
  printChunks(chunks);
}

function printPlan(file: string, plan: EmbedPlan): void {
  const lines = [
    `plan for ${pc.bold(path.basename(file))} (heuristic):`,
    `  splitter:        ${plan.splitter}`,
    `  chunkSize:       ${plan.chunkSize} tokens`,
    `  overlap:         ${plan.overlap} tokens`,
    `  collection:      ${plan.collection}`,
    `  embeddingModel:  ${plan.embeddingModel}`,
    `  planHash:        ${hashPlan(plan)}`,
  ];
  for (const line of lines) process.stdout.write(line + "\n");
  process.stdout.write("\n");
}

function printChunks(chunks: { id: string; text: string; meta: Record<string, unknown> }[]): void {
  process.stdout.write(`${chunks.length} chunk${chunks.length === 1 ? "" : "s"} would be embedded:\n`);
  process.stdout.write("\n");
  const header = ["#", "ID", "TOKENS", "META"];
  const rows = chunks.map((c, i) => [
    String(i),
    c.id,
    String(countTokensSync(c.text)),
    formatMeta(c.meta),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  process.stdout.write(pc.dim(fmt(header)) + "\n");
  for (const row of rows) process.stdout.write(fmt(row) + "\n");
}

const META_PRIORITY = [
  "headerPath",
  "pageNumber",
  "pageCount",
  "row",
  "line",
  "keyPath",
  "language",
  "heading",
  "sectionIndex",
  "chunkInSection",
  "chunkIndex",
];
const META_SKIP = new Set(["sourcePath", "contentType", "columns"]);

function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of META_PRIORITY) if (key in meta) parts.push(formatPair(key, meta[key]));
  for (const key of Object.keys(meta).sort()) {
    if (META_SKIP.has(key)) continue;
    if (META_PRIORITY.includes(key)) continue;
    parts.push(formatPair(key, meta[key]));
  }
  return parts.join(" ");
}

function formatPair(key: string, value: unknown): string {
  if (Array.isArray(value)) return `${key}=[${value.join("/")}]`;
  if (value && typeof value === "object") return `${key}=${JSON.stringify(value)}`;
  return `${key}=${value}`;
}

function parseMetadata(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      throw new AutoEmbedError(
        `Invalid --metadata entry: "${pair}"`,
        ExitCode.UserConfig,
        "Use --metadata key=value,key2=value2",
      );
    }
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

// Re-export to keep envApiKey alive in this module's symbol set (used elsewhere).
void envApiKey;
