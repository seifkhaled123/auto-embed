import fsp from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { Chunk, chunkDocument } from "../chunker/index.js";
import { countTokensSync, primeTokenizer } from "../chunker/tokens.js";
import {
  DEFAULT_MODELS,
  EmbeddingProviderName,
  loadConfig,
  resolveRuntime,
  VectorDbName,
} from "../config/index.js";
import { runPipeline } from "../embed/pipeline.js";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { log, pc } from "../log.js";
import { parseFile } from "../parsers/index.js";
import { heuristicPlan } from "../plan/heuristic.js";
import { llmPlan, loadPlanFile, resolvePlannerProvider } from "../plan/llm.js";
import { EmbedPlan, hashPlan, SplitterName } from "../plan/schema.js";
import { estimateCost, formatUsd } from "../util/cost.js";

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
  /** From commander: boolean true when `--plan` alone, string when `--plan <path>`. */
  plan?: boolean | string;
  planOnly?: boolean;
  out?: string;
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
    .option("--out <path>", "where to write the plan when --plan-only is set", "plan.json")
    .option("--batch-size <n>", "embedding batch size", (v) => parseInt(v, 10))
    .option("--concurrency <n>", "parallel embedding requests", (v) => parseInt(v, 10))
    .option("--force", "ignore lockfile; re-embed and replace")
    .option("--dry-run", "show what would happen; embed nothing")
    .option("--out-vectors <path>", "also write vectors to a local .jsonl")
    .option("-y, --yes", "non-interactive mode")
    .action(async (files: string[], opts: EmbedOpts) => {
      if (opts.planOnly) {
        for (const file of files) await runPlanOnly(file, opts);
        return;
      }
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

async function resolvePlan(
  file: string,
  opts: EmbedOpts,
  embeddingModel: string,
): Promise<EmbedPlan> {
  if (typeof opts.plan === "string") {
    const loaded = await loadPlanFile(opts.plan);
    // The plan describes the chunking strategy; the embedding model is
    // chosen by the runtime (--provider/--local/env/config). Override so
    // `--plan plan.json --local` works even when the plan was originally
    // written against a different provider.
    return { ...loaded, embeddingModel };
  }
  const baseOverrides = {
    splitter: opts.splitter,
    chunkSize: opts.chunkSize,
    overlap: opts.overlap,
    collection: opts.collection,
    metadata: opts.metadata ? parseMetadata(opts.metadata) : undefined,
  };
  if (opts.plan === true) {
    const { provider, apiKey } = resolvePlannerProvider();
    log.info(pc.dim(`tuning plan via ${provider}…`));
    const tuned = await llmPlan({
      sourcePath: file,
      embeddingModel,
      metadata: baseOverrides.metadata,
      provider,
      apiKey,
    });
    return mergeOverrides(tuned, baseOverrides);
  }
  return heuristicPlan({
    sourcePath: file,
    embeddingModel,
    overrides: baseOverrides,
  });
}

function mergeOverrides(
  plan: EmbedPlan,
  overrides: { splitter?: SplitterName; chunkSize?: number; overlap?: number; collection?: string; metadata?: Record<string, string> },
): EmbedPlan {
  return {
    ...plan,
    splitter: overrides.splitter ?? plan.splitter,
    chunkSize: overrides.chunkSize ?? plan.chunkSize,
    overlap: overrides.overlap ?? plan.overlap,
    collection: overrides.collection ?? plan.collection,
    metadata: { ...plan.metadata, ...(overrides.metadata ?? {}) },
  };
}

function resolveModelFromConfig(
  opts: EmbedOpts,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): { provider: EmbeddingProviderName; model: string } {
  const provider: EmbeddingProviderName =
    opts.provider ??
    (process.env.AUTO_EMBED_PROVIDER as EmbeddingProviderName | undefined) ??
    cfg.defaults?.provider ??
    "openai";
  const model =
    opts.model ??
    process.env.AUTO_EMBED_MODEL ??
    cfg.defaults?.model ??
    cfg.models?.[provider] ??
    DEFAULT_MODELS[provider];
  return { provider, model };
}

async function runReal(file: string, rawOpts: EmbedOpts): Promise<void> {
  const opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();
  const { provider, model } = resolveModelFromConfig(opts, cfg);
  const env = process.env;
  const db: VectorDbName =
    opts.db ?? (env.AUTO_EMBED_DB as VectorDbName | undefined) ?? cfg.defaults?.db ?? "chroma";

  let apiKey = "";
  if (provider !== "local") {
    const resolved = resolveRuntime(cfg, { provider, model, db }, env);
    apiKey = resolved.apiKey;
  }

  // If --plan with a value is set, the pipeline will see the loaded plan via
  // resolvePlan. Otherwise the pipeline runs the heuristic plan internally.
  const plan = await resolvePlan(file, opts, model);

  const outcome = await runPipeline({
    file,
    config: cfg,
    env,
    resolved: { provider, model, apiKey, db },
    local: opts.local,
    force: opts.force,
    plan,
    overrides: {
      batchSize: opts.batchSize,
      concurrency: opts.concurrency,
    },
  });

  printOutcome(outcome);
}

function printOutcome(outcome: Awaited<ReturnType<typeof runPipeline>>): void {
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
  const { model } = resolveModelFromConfig(opts, cfg);

  const plan = await resolvePlan(file, opts, model);
  const document = await parseFile(file);
  await primeTokenizer();
  const chunks = await chunkDocument(document, plan);

  printPlan(file, plan, opts);
  printChunks(chunks);
  printCost(chunks, plan);
}

async function runPlanOnly(file: string, rawOpts: EmbedOpts): Promise<void> {
  const opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();
  const { model } = resolveModelFromConfig(opts, cfg);
  const plan = await resolvePlan(file, opts, model);
  const outPath = path.resolve(opts.out ?? "plan.json");
  await fsp.writeFile(outPath, JSON.stringify(plan, null, 2) + "\n");
  log.success(`wrote plan to ${pc.cyan(outPath)}`);
}

function printPlan(file: string, plan: EmbedPlan, opts: EmbedOpts): void {
  const source = typeof opts.plan === "string"
    ? `loaded from ${opts.plan}`
    : opts.plan === true
    ? "LLM-tuned"
    : "heuristic";
  const lines = [
    `plan for ${pc.bold(path.basename(file))} (${source}):`,
    `  splitter:        ${plan.splitter}`,
    `  chunkSize:       ${plan.chunkSize} tokens`,
    `  overlap:         ${plan.overlap} tokens`,
    `  collection:      ${plan.collection}`,
    `  embeddingModel:  ${plan.embeddingModel}`,
    `  planHash:        ${hashPlan(plan)}`,
  ];
  for (const line of lines) process.stdout.write(line + "\n");
  if (Object.keys(plan.metadata).length > 0) {
    process.stdout.write(`  metadata:        ${JSON.stringify(plan.metadata)}\n`);
  }
  process.stdout.write("\n");
}

function printChunks(chunks: Chunk[]): void {
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

function printCost(chunks: Chunk[], plan: EmbedPlan): void {
  const total = chunks.reduce((sum, c) => sum + countTokensSync(c.text), 0);
  const est = estimateCost(total, plan.embeddingModel);
  process.stdout.write(`\n`);
  process.stdout.write(
    `${pc.dim("cost:")}            ~${formatUsd(est.usd)} (${total.toLocaleString()} tokens × ${plan.embeddingModel}) — ${est.note}\n`,
  );
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
