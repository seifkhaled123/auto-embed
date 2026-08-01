import fsp from "node:fs/promises";
import path from "node:path";
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
import {
  ChunkReportEntry,
  defaultChunksReportPath,
  writeChunksReport,
} from "../commands/chunks-report.js";
import { expandInputArgs } from "../commands/inputs.js";
import { createVectorExportWriter } from "../commands/vector-export.js";

export interface EmbedWorkflowOptions {
  collection?: string;
  provider?: EmbeddingProviderName;
  model?: string;
  db?: VectorDbName;
  local?: boolean;
  splitter?: SplitterName;
  chunkSize?: number;
  overlap?: number;
  metadata?: string;
  /** Structured metadata used by the interactive adapter. CLI metadata remains string-based. */
  metadataValues?: Record<string, string>;
  /** From commander: boolean true when `--plan` alone, string when `--plan <path>`. */
  plan?: boolean | string;
  planOnly?: boolean;
  out?: string;
  batchSize?: number;
  concurrency?: number;
  force?: boolean;
  dryRun?: boolean;
  showChunks?: boolean;
  outVectors?: string;
  yes?: boolean;
}

export async function runEmbedWorkflow(
  inputArgs: readonly string[],
  opts: EmbedWorkflowOptions,
): Promise<void> {
  await withInterruptSignal(async (signal) => {
    assertPreviewMode(opts);
    const files = await expandInputArgs(inputArgs);
    if (opts.planOnly) {
      for (const file of files) await runPlanOnly(file, opts);
      return;
    }
    if (opts.showChunks) {
      await runShowChunks(files, opts);
      return;
    }
    if (opts.dryRun) {
      for (const file of files) await runDryRun(file, opts);
      return;
    }
    if (opts.outVectors) {
      await runWithVectorExport(files, opts, signal);
      return;
    }
    for (const file of files) await runReal(file, opts, undefined, signal);
  });
}

async function withInterruptSignal<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    log.warn("interrupt received; finishing active provider work before cleanup…");
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    return await run(controller.signal);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

function assertPreviewMode(opts: EmbedWorkflowOptions): void {
  const selected = [opts.planOnly, opts.dryRun, opts.showChunks].filter(Boolean);
  if (selected.length > 1) {
    throw new AutoEmbedError(
      "Choose only one of --plan-only, --dry-run, or --show-chunks.",
      ExitCode.UserConfig,
    );
  }
  if (opts.outVectors && selected.length > 0) {
    throw new AutoEmbedError(
      "--out-vectors cannot be combined with a preview-only mode.",
      ExitCode.UserConfig,
      "Remove --plan-only, --dry-run, or --show-chunks to generate vectors.",
    );
  }
}

async function runWithVectorExport(
  files: string[],
  opts: EmbedWorkflowOptions,
  signal: AbortSignal,
): Promise<void> {
  const outputPath = path.resolve(opts.outVectors!);
  if (files.includes(outputPath)) {
    throw new AutoEmbedError(
      `Vector export would overwrite an input file: ${outputPath}`,
      ExitCode.UserConfig,
      "Choose a different --out-vectors path.",
    );
  }

  const writer = await createVectorExportWriter(outputPath);
  try {
    log.info(pc.dim("vector export requested; embedding every chunk in resolved input order…"));
    for (const file of files) {
      await runReal(file, opts, (rows) => writer.append(file, rows), signal);
    }
    const committed = await writer.commit();
    log.success(`wrote vectors to ${pc.cyan(committed)}`);
  } catch (err) {
    await writer.abort();
    throw err;
  }
}

function applyLocalShortcut(opts: EmbedWorkflowOptions): EmbedWorkflowOptions {
  if (!opts.local) return opts;
  return {
    ...opts,
    provider: opts.provider ?? "local",
    db: opts.db ?? "chroma",
  };
}

async function resolvePlan(
  file: string,
  opts: EmbedWorkflowOptions,
  embeddingModel: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
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
    metadata: opts.metadataValues ?? (opts.metadata ? parseMetadata(opts.metadata) : undefined),
  };
  if (opts.plan === true) {
    const { provider, apiKey } = resolvePlannerProvider(process.env, cfg);
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
  opts: EmbedWorkflowOptions,
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

async function runReal(
  file: string,
  rawOpts: EmbedWorkflowOptions,
  captureVectors?: Parameters<typeof runPipeline>[0]["captureVectors"],
  signal?: AbortSignal,
): Promise<void> {
  let opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();
  const { provider, model } = resolveModelFromConfig(opts, cfg);
  const env = process.env;
  const db: VectorDbName =
    opts.db ?? (env.AUTO_EMBED_DB as VectorDbName | undefined) ?? cfg.defaults?.db ?? "chroma";
  opts = applyConfigDefaults(opts, cfg, db);

  let apiKey = "";
  if (provider !== "local") {
    const resolved = resolveRuntime(cfg, { provider, model, db }, env);
    apiKey = resolved.apiKey;
  }

  // If --plan with a value is set, the pipeline will see the loaded plan via
  // resolvePlan. Otherwise the pipeline runs the heuristic plan internally.
  const plan = await resolvePlan(file, opts, model, cfg);

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
    captureVectors,
    signal,
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

async function runDryRun(file: string, rawOpts: EmbedWorkflowOptions): Promise<void> {
  let opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();
  opts = applyConfigDefaults(opts, cfg);
  const { model } = resolveModelFromConfig(opts, cfg);

  const plan = await resolvePlan(file, opts, model, cfg);
  const document = await parseFile(file);
  await primeTokenizer();
  const chunks = await chunkDocument(document, plan);

  printPlan(file, plan, opts);
  printChunks(chunks);
  printCost(chunks, plan);
}

async function runShowChunks(files: string[], rawOpts: EmbedWorkflowOptions): Promise<void> {
  let opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();
  opts = applyConfigDefaults(opts, cfg);
  const { model } = resolveModelFromConfig(opts, cfg);
  const entries: ChunkReportEntry[] = [];

  await primeTokenizer();
  for (const file of files) {
    const plan = await resolvePlan(file, opts, model, cfg);
    const document = await parseFile(file);
    const chunks = await chunkDocument(document, plan);
    entries.push({ file, plan, chunks });
  }

  if (opts.out) {
    const outputPath = await writeChunksReport(entries, opts.out);
    const totalChunks = entries.reduce((sum, entry) => sum + entry.chunks.length, 0);
    log.success(
      `wrote ${totalChunks} chunk${totalChunks === 1 ? "" : "s"} to ${pc.cyan(outputPath)} (no embeddings created)`,
    );
    return;
  }

  for (const entry of entries) {
    const outputPath = await writeChunksReport(
      [entry],
      defaultChunksReportPath(entry.file),
    );
    log.success(
      `wrote ${entry.chunks.length} chunk${entry.chunks.length === 1 ? "" : "s"} from ${pc.bold(path.basename(entry.file))} to ${pc.cyan(outputPath)} (no embeddings created)`,
    );
  }
}

async function runPlanOnly(file: string, rawOpts: EmbedWorkflowOptions): Promise<void> {
  let opts = applyLocalShortcut(rawOpts);
  const cfg = await loadConfig();
  opts = applyConfigDefaults(opts, cfg);
  const { model } = resolveModelFromConfig(opts, cfg);
  const plan = await resolvePlan(file, opts, model, cfg);
  const outPath = path.resolve(opts.out ?? "plan.json");
  await fsp.writeFile(outPath, JSON.stringify(plan, null, 2) + "\n");
  log.success(`wrote plan to ${pc.cyan(outPath)}`);
}

function printPlan(file: string, plan: EmbedPlan, opts: EmbedWorkflowOptions): void {
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

function applyConfigDefaults(
  opts: EmbedWorkflowOptions,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  db?: VectorDbName,
): EmbedWorkflowOptions {
  if (opts.collection) return opts;
  const collection =
    cfg.defaults?.collection ??
    (db === "pinecone" ? cfg.dbs?.pinecone?.indexName : undefined);
  return collection ? { ...opts, collection } : opts;
}
