import path from "node:path";
import {
  Config,
  DEFAULT_MODELS,
  EmbeddingProviderName,
  loadConfig,
  saveConfig,
  VectorDbName,
} from "../config/index.js";
import { isAutoEmbedError } from "../errors.js";
import { SplitterName } from "../plan/schema.js";
import { EmbedWorkflowOptions, runEmbedWorkflow } from "../workflows/embed.js";
import { inspectWorkflowRequirements } from "../workflows/requirements.js";
import type {
  WorkflowDraft,
  WorkflowRequirement,
  WorkflowResult,
} from "../workflows/types.js";
import {
  chooseDatabase,
  chooseProvider,
  configureDatabase,
  configureProvider,
} from "./configuration.js";
import { CANCEL, PromptDriver } from "./driver.js";
import { collectInputs, CollectedInputs } from "./inputs.js";

export async function runNewWorkflow(
  prompt: PromptDriver,
  cwd: string = process.cwd(),
  result: WorkflowResult = "embed",
): Promise<void> {
  const selected = await collectInputs(prompt, cwd);
  if (!selected) return;
  if (result === "plan" && selected.resolvedFiles.length !== 1) {
    prompt.note("Keep one file to create a plan.", "One file required");
    const revised = await collectInputs(prompt, cwd, selected);
    if (!revised || revised.resolvedFiles.length !== 1) return;
    await finishWorkflow(prompt, createDraft(result, revised), cwd);
    return;
  }
  await finishWorkflow(prompt, createDraft(result, selected), cwd);
}

async function finishWorkflow(
  prompt: PromptDriver,
  draft: WorkflowDraft,
  cwd: string,
): Promise<void> {
  applyEffectiveDefaults(draft, await loadConfig());
  if (!(await choosePlanAndOutput(prompt, draft))) return;

  while (true) {
    const review = await reviewWorkflow(prompt, draft, cwd);
    if (review === "home") return;
    if (review === "back") {
      await editSettings(prompt, draft);
      continue;
    }
    if (review === "files") {
      const revised = await collectInputs(prompt, cwd, {
        inputs: draft.inputs,
        resolvedFiles: draft.resolvedFiles,
      });
      if (revised) {
        if (draft.result === "plan" && revised.resolvedFiles.length !== 1) {
          prompt.note("Plan creation requires exactly one file.", "Selection unchanged");
        } else {
          draft.inputs = revised.inputs;
          draft.resolvedFiles = revised.resolvedFiles;
        }
      }
      continue;
    }

    const requirementStatus = await resolveRequirements(prompt, draft);
    if (requirementStatus === "cancel") continue;
    if (requirementStatus === "updated") continue;

    try {
      await runEmbedWorkflow(draft.resolvedFiles, toWorkflowOptions(draft));
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = isAutoEmbedError(err) ? err.hint : undefined;
      prompt.note(`${message}${hint ? `\n\nhint: ${hint}` : ""}`, "Workflow failed");
      const recovery = await prompt.select<"retry" | "settings" | "files" | "home">({
        message: "Try again?",
        options: [
          { value: "retry", label: "Retry" },
          { value: "settings", label: "Edit settings" },
          { value: "files", label: "Change files" },
          { value: "home", label: "Cancel" },
        ],
      });
      if (recovery === "retry") continue;
      if (recovery === "settings") {
        await editSettings(prompt, draft);
        continue;
      }
      if (recovery === "files") {
        const revised = await collectInputs(prompt, cwd, {
          inputs: draft.inputs,
          resolvedFiles: draft.resolvedFiles,
        });
        if (revised) {
          draft.inputs = revised.inputs;
          draft.resolvedFiles = revised.resolvedFiles;
        }
        continue;
      }
      return;
    }
  }
}

function createDraft(result: WorkflowResult, selected: CollectedInputs): WorkflowDraft {
  return {
    result,
    inputs: selected.inputs,
    resolvedFiles: selected.resolvedFiles,
    planMode: "heuristic",
    metadata: {},
    force: false,
    local: false,
  };
}

function applyEffectiveDefaults(draft: WorkflowDraft, config: Config): void {
  const envProvider = process.env.AUTO_EMBED_PROVIDER;
  draft.provider = isProvider(envProvider)
    ? envProvider
    : config.defaults?.provider ?? "openai";
  draft.model =
    process.env.AUTO_EMBED_MODEL ??
    config.defaults?.model ??
    config.models?.[draft.provider] ??
    DEFAULT_MODELS[draft.provider];
  const envDb = process.env.AUTO_EMBED_DB;
  draft.db = isDatabase(envDb) ? envDb : config.defaults?.db ?? "chroma";
  draft.collection =
    config.defaults?.collection ??
    (draft.db === "pinecone" ? config.dbs?.pinecone?.indexName : undefined);
}

async function choosePlanAndOutput(prompt: PromptDriver, draft: WorkflowDraft): Promise<boolean> {
  if (draft.result === "plan") {
    if (!(await choosePlanMode(prompt, draft))) return false;
    return setOutputPath(prompt, draft, "plan.json", ".json");
  }
  if (draft.result === "chunks") {
    const combined = await prompt.confirm({
      message: "Write one combined report?",
      initialValue: draft.resolvedFiles.length > 1,
    });
    if (combined === CANCEL) return false;
    if (combined) return setOutputPath(prompt, draft, "chunks.txt", ".txt");
  }
  if (draft.result === "embed-export") {
    return setOutputPath(prompt, draft, "vectors.jsonl", ".jsonl");
  }
  return true;
}

async function editSettings(prompt: PromptDriver, draft: WorkflowDraft): Promise<void> {
  while (true) {
    type Choice =
      | "provider" | "model" | "database" | "collection" | "plan"
      | "chunking" | "metadata" | "performance" | "force" | "output" | "done";
    const options: Array<{ value: Choice; label: string; hint?: string }> = [];
    if (draft.result !== "chunks") {
      options.push(
        { value: "provider", label: "Embedding provider", hint: draft.provider },
        { value: "model", label: "Embedding model", hint: draft.model },
      );
    }
    if (draft.result === "embed" || draft.result === "embed-export") {
      options.push({ value: "database", label: "Vector database", hint: draft.db });
    }
    options.push(
      { value: "collection", label: "Collection", hint: draft.collection ?? "derived per file" },
      { value: "plan", label: "Plan strategy", hint: draft.planMode },
      { value: "chunking", label: "Chunking", hint: chunkingLabel(draft) },
      { value: "metadata", label: "Metadata", hint: `${Object.keys(draft.metadata).length} field(s)` },
    );
    if (draft.result === "embed" || draft.result === "embed-export") {
      options.push(
        { value: "performance", label: "Batch size and concurrency" },
        { value: "force", label: "Force re-embedding", hint: draft.force ? "on" : "off" },
      );
    }
    if (["plan", "chunks", "embed-export"].includes(draft.result)) {
      options.push({ value: "output", label: "Output path", hint: draft.output ?? "automatic" });
    }
    options.push({ value: "done", label: "Done" });

    const choice = await prompt.select<Choice>({ message: "Settings", options });
    if (choice === CANCEL || choice === "done") return;
    if (choice === "provider") {
      const provider = await chooseProvider(prompt, draft.provider);
      if (provider) {
        draft.provider = provider;
        const cfg = await loadConfig();
        draft.model = cfg.models?.[provider] ?? DEFAULT_MODELS[provider];
        draft.local = false;
      }
    } else if (choice === "model") {
      const model = await prompt.text({
        message: "Embedding model",
        initialValue: draft.model,
        validate: required("Enter a model ID."),
      });
      if (model !== CANCEL) draft.model = model.trim();
    } else if (choice === "database") {
      const db = await chooseDatabase(prompt, draft.db);
      if (db) {
        draft.db = db;
        draft.local = false;
      }
    } else if (choice === "collection") {
      const collection = await prompt.text({
        message: "Collection",
        initialValue: draft.collection,
        placeholder: "leave blank to derive from each file",
        validate: validateOptionalCollection,
      });
      if (collection !== CANCEL) draft.collection = collection.trim() || undefined;
    } else if (choice === "plan") {
      await choosePlanMode(prompt, draft);
    } else if (choice === "chunking") {
      await editChunking(prompt, draft);
    } else if (choice === "metadata") {
      await editMetadata(prompt, draft);
    } else if (choice === "performance") {
      await editPerformance(prompt, draft);
    } else if (choice === "force") {
      const force = await prompt.confirm({
        message: "Ignore lockfiles and replace existing vectors?",
        initialValue: draft.force,
      });
      if (force !== CANCEL) draft.force = force;
    } else if (choice === "output") {
      const [fallback, extension] = draft.result === "plan"
        ? ["plan.json", ".json"]
        : draft.result === "chunks"
        ? ["chunks.txt", ".txt"]
        : ["vectors.jsonl", ".jsonl"];
      await setOutputPath(prompt, draft, fallback, extension);
    }
  }
}

async function choosePlanMode(prompt: PromptDriver, draft: WorkflowDraft): Promise<boolean> {
  const choice = await prompt.select<"heuristic" | "llm" | "file" | "back">({
    message: "Plan",
    options: [
      { value: "heuristic", label: "Automatic", hint: "local and reproducible" },
      { value: "llm", label: "Tune with an LLM", hint: "one API call" },
      { value: "file", label: "Load a plan file" },
      { value: "back", label: "Back" },
    ],
    initialValue: draft.planMode,
  });
  if (choice === CANCEL || choice === "back") return false;
  draft.planMode = choice;
  draft.planPath = undefined;
  if (choice === "file") {
    const planPath = await prompt.text({
      message: "Path to saved plan JSON",
      placeholder: "./plan.json",
      validate: required("Enter a plan path."),
    });
    if (planPath === CANCEL) {
      draft.planMode = "heuristic";
      return false;
    }
    draft.planPath = planPath.trim();
  }
  return true;
}

async function editChunking(prompt: PromptDriver, draft: WorkflowDraft): Promise<void> {
  const splitter = await prompt.select<SplitterName | "auto">({
    message: "Splitter",
    options: [
      { value: "auto", label: "Automatic from file type" },
      ...SplitterName.options.map((value) => ({ value, label: value })),
    ],
    initialValue: draft.splitter ?? "auto",
  });
  if (splitter === CANCEL) return;
  draft.splitter = splitter === "auto" ? undefined : splitter;

  const size = await prompt.text({
    message: "Target chunk size in tokens (blank for automatic)",
    initialValue: draft.chunkSize?.toString(),
    placeholder: "800",
    validate: validateOptionalPositiveInteger,
  });
  if (size === CANCEL) return;
  draft.chunkSize = parseOptionalInteger(size);

  const overlap = await prompt.text({
    message: "Token overlap (blank for automatic)",
    initialValue: draft.overlap?.toString(),
    placeholder: "100",
    validate: (value) => {
      const parsed = parseOptionalInteger(value ?? "");
      if (parsed === undefined) return undefined;
      if (parsed < 0) return "Use zero or a positive integer.";
      if (draft.chunkSize !== undefined && parsed >= draft.chunkSize) {
        return "Overlap must be smaller than chunk size.";
      }
      return undefined;
    },
  });
  if (overlap !== CANCEL) draft.overlap = parseOptionalInteger(overlap);
}

async function editMetadata(prompt: PromptDriver, draft: WorkflowDraft): Promise<void> {
  while (true) {
    const entries = Object.entries(draft.metadata);
    if (entries.length) {
      prompt.note(entries.map(([key, value]) => `${key} = ${value}`).join("\n"), "Metadata");
    }
    const choice = await prompt.select<"add" | "remove" | "clear" | "done">({
      message: "Edit static metadata",
      options: [
        { value: "add", label: "Add or update a field" },
        ...(entries.length ? [
          { value: "remove" as const, label: "Remove a field" },
          { value: "clear" as const, label: "Clear all fields" },
        ] : []),
        { value: "done", label: "Done" },
      ],
    });
    if (choice === CANCEL || choice === "done") return;
    if (choice === "clear") {
      draft.metadata = {};
      continue;
    }
    if (choice === "remove") {
      const key = await prompt.select<string>({
        message: "Remove which field?",
        options: entries.map(([value]) => ({ value, label: value })),
      });
      if (key !== CANCEL) delete draft.metadata[key];
      continue;
    }
    const key = await prompt.text({
      message: "Metadata key",
      validate: (value) => {
        const text = (value ?? "").trim();
        if (!text) return "Enter a key.";
        return /[=,]/.test(text) ? "Keys cannot contain commas or equals signs." : undefined;
      },
    });
    if (key === CANCEL) continue;
    const value = await prompt.text({ message: `Value for ${key.trim()}` });
    if (value !== CANCEL) draft.metadata[key.trim()] = value;
  }
}

async function editPerformance(prompt: PromptDriver, draft: WorkflowDraft): Promise<void> {
  const batchSize = await prompt.text({
    message: "Embedding batch size (blank for provider default)",
    initialValue: draft.batchSize?.toString(),
    validate: validateOptionalPositiveInteger,
  });
  if (batchSize === CANCEL) return;
  draft.batchSize = parseOptionalInteger(batchSize);
  const concurrency = await prompt.text({
    message: "Parallel embedding requests (blank for default: 4)",
    initialValue: draft.concurrency?.toString(),
    validate: validateOptionalPositiveInteger,
  });
  if (concurrency !== CANCEL) draft.concurrency = parseOptionalInteger(concurrency);
}

async function setOutputPath(
  prompt: PromptDriver,
  draft: WorkflowDraft,
  fallback: string,
  extension: string,
): Promise<boolean> {
  const output = await prompt.text({
    message: `Output path (${extension})`,
    initialValue: draft.output ?? fallback,
    placeholder: fallback,
    validate: (value) => {
      const text = (value ?? "").trim();
      if (!text) return "Enter an output path.";
      return path.extname(text).toLowerCase() === extension
        ? undefined
        : `Output must end in ${extension}.`;
    },
  });
  if (output === CANCEL) return false;
  draft.output = output.trim();
  return true;
}

async function resolveRequirements(
  prompt: PromptDriver,
  draft: WorkflowDraft,
): Promise<"ready" | "updated" | "cancel"> {
  let updated = false;
  while (true) {
    const cfg = await loadConfig();
    const requirement = inspectWorkflowRequirements(
      {
        result: draft.result,
        planMode: draft.planMode,
        provider: draft.provider!,
        db: draft.db!,
      },
      cfg,
    )[0];
    if (!requirement) return updated ? "updated" : "ready";
    if (!(await resolveRequirement(prompt, draft, cfg, requirement))) return "cancel";
    updated = true;
  }
}

async function resolveRequirement(
  prompt: PromptDriver,
  draft: WorkflowDraft,
  cfg: Config,
  requirement: WorkflowRequirement,
): Promise<boolean> {
  if (requirement.kind === "provider-key") {
    const provider = requirement.provider;
    const choice = await prompt.select<"configure" | "change" | "local" | "back">({
      message: `${provider} isn't configured`,
      options: [
        { value: "configure", label: "Add API key" },
        { value: "change", label: "Use another provider" },
        { value: "local", label: "Use local embedding", hint: "FastEmbed + Chroma" },
        { value: "back", label: "Back" },
      ],
    });
    if (choice === CANCEL || choice === "back") return false;
    if (choice === "local") {
      draft.provider = "local";
      draft.model = DEFAULT_MODELS.local;
      draft.db = "chroma";
      draft.local = true;
      return true;
    }
    if (choice === "change") {
      const selected = await chooseProvider(prompt, draft.provider);
      if (!selected) return false;
      draft.provider = selected;
      draft.model = cfg.models?.[selected] ?? DEFAULT_MODELS[selected];
      draft.local = false;
      return true;
    }
    const next = await configureProvider(prompt, cfg, provider);
    if (!next) return false;
    await saveConfig(next);
    draft.model = next.models?.[provider] ?? draft.model;
    return true;
  }

  if (requirement.kind === "planner-key") {
    const choice = await prompt.select<"openai" | "google" | "heuristic" | "back">({
      message: "LLM tuning needs an API key",
      options: [
        { value: "openai", label: "Add an OpenAI key" },
        { value: "google", label: "Add a Google key" },
        { value: "heuristic", label: "Use automatic planning" },
        { value: "back", label: "Back" },
      ],
    });
    if (choice === CANCEL || choice === "back") return false;
    if (choice === "heuristic") {
      draft.planMode = "heuristic";
      return true;
    }
    const next = await configureProvider(prompt, cfg, choice);
    if (!next) return false;
    await saveConfig(next);
    return true;
  }

  const db = requirement.db;
  const choice = await prompt.select<"configure" | "change" | "local" | "back">({
    message: `${db} isn't configured`,
    options: [
      { value: "configure", label: requirement.kind === "database-key" ? "Add API key" : "Add connection URL" },
      { value: "change", label: "Use another database" },
      { value: "local", label: "Use local Chroma" },
      { value: "back", label: "Back" },
    ],
  });
  if (choice === CANCEL || choice === "back") return false;
  if (choice === "local") {
    draft.db = "chroma";
    draft.local = draft.provider === "local";
    return true;
  }
  if (choice === "change") {
    const selected = await chooseDatabase(prompt, draft.db);
    if (!selected) return false;
    draft.db = selected;
    draft.local = false;
    return true;
  }
  const next = await configureDatabase(prompt, cfg, db);
  if (!next) return false;
  await saveConfig(next);
  return true;
}

type ReviewAction = "run" | "back" | "files" | "home";

async function reviewWorkflow(
  prompt: PromptDriver,
  draft: WorkflowDraft,
  cwd: string,
): Promise<ReviewAction> {
  while (true) {
    prompt.note(renderReview(draft, cwd), reviewTitle(draft));
    const choice = await prompt.select<"run" | "settings" | "files" | "more" | "home">({
      message: "Continue?",
      options: [
        { value: "run", label: runLabel(draft.result) },
        { value: "settings", label: "Edit settings" },
        { value: "files", label: "Change files" },
        { value: "more", label: "More options" },
        { value: "home", label: "Cancel" },
      ],
    });
    if (choice === CANCEL || choice === "home") return "home";
    if (choice === "run") return "run";
    if (choice === "settings") return "back";
    if (choice === "files") return "files";
    const secondary = await prompt.select<"command" | "save" | "back">({
      message: "More options",
      options: [
        { value: "command", label: "Show CLI command" },
        { value: "save", label: "Save as defaults" },
        { value: "back", label: "Back" },
      ],
    });
    if (secondary === CANCEL || secondary === "back") continue;
    if (secondary === "command") {
      prompt.note(equivalentCommand(draft), "CLI command · secrets omitted");
      continue;
    }
    await saveRunDefaults(draft);
    prompt.note("Provider, model, database, and collection saved.", "Defaults updated");
  }
}

function renderReview(draft: WorkflowDraft, cwd: string): string {
  const filePreview = draft.resolvedFiles.slice(0, 5).map((file) => `  ${displayPath(file, cwd)}`);
  if (draft.resolvedFiles.length > 5) filePreview.push(`  …and ${draft.resolvedFiles.length - 5} more`);
  return [
    `Files      ${draft.resolvedFiles.length}`,
    ...filePreview,
    `Model      ${draft.provider} · ${draft.model}`,
    `Target     ${needsDatabase(draft.result) ? `${draft.db} · ${draft.collection ?? "one collection per file"}` : "none"}`,
    `Plan       ${draft.planMode}${draft.planPath ? ` · ${draft.planPath}` : ""}`,
    `Chunking   ${chunkingLabel(draft)}`,
    ...(Object.keys(draft.metadata).length ? [`Metadata   ${JSON.stringify(draft.metadata)}`] : []),
    `Output     ${draft.output ?? outputDescription(draft.result)}`,
    `Writes     ${sideEffects(draft.result)}`,
  ].join("\n");
}

function toWorkflowOptions(draft: WorkflowDraft): EmbedWorkflowOptions {
  return {
    provider: draft.provider,
    model: draft.model,
    db: draft.db,
    collection: draft.collection,
    local: draft.local || undefined,
    splitter: draft.splitter,
    chunkSize: draft.chunkSize,
    overlap: draft.overlap,
    metadataValues: Object.keys(draft.metadata).length ? draft.metadata : undefined,
    plan: draft.planMode === "llm" ? true : draft.planMode === "file" ? draft.planPath : undefined,
    planOnly: draft.result === "plan",
    dryRun: draft.result === "preview",
    showChunks: draft.result === "chunks",
    outVectors: draft.result === "embed-export" ? draft.output : undefined,
    out: draft.result === "plan" || draft.result === "chunks" ? draft.output : undefined,
    batchSize: draft.batchSize,
    concurrency: draft.concurrency,
    force: draft.force,
    yes: true,
  };
}

export function equivalentCommand(draft: WorkflowDraft): string {
  const args = ["auto-embed", "embed"];
  args.push(...draft.resolvedFiles);
  if (draft.local) args.push("--local");
  else {
    if (draft.provider) args.push("--provider", draft.provider);
    if (draft.db && needsDatabase(draft.result)) args.push("--db", draft.db);
  }
  if (draft.model) args.push("--model", draft.model);
  if (draft.collection) args.push("--collection", draft.collection);
  if (draft.splitter) args.push("--splitter", draft.splitter);
  if (draft.chunkSize !== undefined) args.push("--chunk-size", String(draft.chunkSize));
  if (draft.overlap !== undefined) args.push("--overlap", String(draft.overlap));
  if (Object.keys(draft.metadata).length) {
    args.push("--metadata", Object.entries(draft.metadata).map(([key, value]) => `${key}=${value}`).join(","));
  }
  if (draft.planMode === "llm") args.push("--plan");
  if (draft.planMode === "file" && draft.planPath) args.push("--plan", draft.planPath);
  if (draft.result === "preview") args.push("--dry-run");
  if (draft.result === "chunks") args.push("--show-chunks");
  if (draft.result === "plan") args.push("--plan-only");
  if (draft.result === "embed-export" && draft.output) args.push("--out-vectors", draft.output);
  if ((draft.result === "chunks" || draft.result === "plan") && draft.output) args.push("--out", draft.output);
  if (draft.batchSize !== undefined) args.push("--batch-size", String(draft.batchSize));
  if (draft.concurrency !== undefined) args.push("--concurrency", String(draft.concurrency));
  if (draft.force) args.push("--force");
  args.push("--yes");
  return args.map(shellQuote).join(" ");
}

async function saveRunDefaults(draft: WorkflowDraft): Promise<void> {
  const cfg = await loadConfig();
  const next: Config = {
    ...cfg,
    defaults: {
      ...(cfg.defaults ?? {}),
      provider: draft.provider,
      db: draft.db,
      model: draft.model,
      ...(draft.collection ? { collection: draft.collection } : {}),
    },
    models: draft.provider && draft.model
      ? { ...(cfg.models ?? {}), [draft.provider]: draft.model }
      : cfg.models,
  };
  if (!draft.collection && next.defaults) delete next.defaults.collection;
  await saveConfig(next);
}

function runLabel(result: WorkflowResult): string {
  switch (result) {
    case "embed": return "Embed";
    case "preview": return "Preview";
    case "chunks": return "Write chunk report";
    case "plan": return "Save plan";
    case "embed-export": return "Export vectors";
  }
}

function reviewTitle(draft: WorkflowDraft): string {
  const count = `${draft.resolvedFiles.length} file${draft.resolvedFiles.length === 1 ? "" : "s"}`;
  switch (draft.result) {
    case "embed": return `Embed ${count}`;
    case "preview": return `Preview ${count}`;
    case "chunks": return `Inspect ${count}`;
    case "plan": return "Create plan";
    case "embed-export": return `Export ${count}`;
  }
}

function needsDatabase(result: WorkflowResult): boolean {
  return result === "embed" || result === "embed-export";
}

function outputDescription(result: WorkflowResult): string {
  if (result === "embed") return "vector database + lockfiles";
  if (result === "preview") return "terminal only";
  if (result === "chunks") return "one report per source file";
  return "not selected";
}

function sideEffects(result: WorkflowResult): string {
  if (result === "embed" || result === "embed-export") {
    return "vectors and local job state";
  }
  if (result === "chunks" || result === "plan") return "output file";
  return "nothing";
}

function chunkingLabel(draft: WorkflowDraft): string {
  return [
    draft.splitter ?? "automatic",
    draft.chunkSize === undefined ? "automatic size" : `${draft.chunkSize} tokens`,
    draft.overlap === undefined ? "automatic overlap" : `${draft.overlap} overlap`,
  ].join(" · ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function displayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith("..") ? relative : file;
}

function required(message: string): (value: string | undefined) => string | undefined {
  return (value) => (value ?? "").trim() ? undefined : message;
}

function validateOptionalCollection(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  if (!text) return undefined;
  return /^[a-z0-9][a-z0-9_-]*$/.test(text)
    ? undefined
    : "Use lowercase letters, numbers, hyphens, or underscores.";
}

function validateOptionalPositiveInteger(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  if (!text) return undefined;
  return /^\d+$/.test(text) && Number(text) > 0 ? undefined : "Use a positive integer.";
}

function parseOptionalInteger(value: string): number | undefined {
  const text = value.trim();
  return text ? Number(text) : undefined;
}

function isProvider(value: string | undefined): value is EmbeddingProviderName {
  return Boolean(value && EmbeddingProviderName.options.includes(value as EmbeddingProviderName));
}

function isDatabase(value: string | undefined): value is VectorDbName {
  return Boolean(value && VectorDbName.options.includes(value as VectorDbName));
}

export const _internal = {
  applyEffectiveDefaults,
  renderReview,
  shellQuote,
  toWorkflowOptions,
};
