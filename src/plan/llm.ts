import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { isRetryable } from "../providers/openai.js";
import { EmbedPlan, EmbedPlanSchema, SplitterName } from "./schema.js";

export type PlannerProvider = "anthropic" | "openai" | "google";

export interface LlmPlanInput {
  sourcePath: string;
  embeddingModel: string;
  /** Optional pre-baked metadata from CLI; planner may add more. */
  metadata?: Record<string, string>;
  /** Provider + key chosen for the planner (NOT the embedding provider). */
  provider: PlannerProvider;
  apiKey: string;
  /** Optional model override; otherwise the provider's default. */
  model?: string;
}

const DEFAULT_MODELS: Record<PlannerProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  google: "gemini-2.0-flash",
};

const SAMPLE_BYTES = 4096;

/** What the LLM is asked to return. We add `version` + `embeddingModel` afterward. */
const PlanResponseSchema = z.object({
  splitter: z.enum(["recursive", "markdown", "pdf", "html", "code", "jsonl", "csv"]),
  chunkSize: z.number().int().min(64).max(4096),
  overlap: z.number().int().nonnegative(),
  collection: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/),
  metadata: z.record(z.string()).optional(),
});
type PlanResponse = z.infer<typeof PlanResponseSchema>;

export async function llmPlan(input: LlmPlanInput): Promise<EmbedPlan> {
  const sample = await readSample(input.sourcePath);
  const prompt = buildPrompt(input.sourcePath, sample);
  const model = input.model ?? DEFAULT_MODELS[input.provider];

  let raw = await callLlm(input.provider, input.apiKey, model, prompt);
  let parsed = tryParse(raw);
  if (!parsed.ok) {
    // Single retry with the validation error fed back in.
    raw = await callLlm(
      input.provider,
      input.apiKey,
      model,
      `${prompt}\n\nYour previous response failed validation: ${parsed.message}\nReturn JSON only. No prose, no markdown fences.`,
    );
    parsed = tryParse(raw);
    if (!parsed.ok) {
      throw new AutoEmbedError(
        `LLM planner returned invalid JSON: ${parsed.message}`,
        ExitCode.ProviderApi,
        "Retry, or fall back to the heuristic plan by omitting --plan.",
      );
    }
  }

  const fullPlan: EmbedPlan = EmbedPlanSchema.parse({
    version: 1,
    splitter: parsed.value.splitter as SplitterName,
    chunkSize: parsed.value.chunkSize,
    overlap: parsed.value.overlap,
    metadata: { ...(parsed.value.metadata ?? {}), ...(input.metadata ?? {}) },
    collection: parsed.value.collection,
    embeddingModel: input.embeddingModel,
  });
  return fullPlan;
}

async function readSample(sourcePath: string): Promise<string> {
  try {
    const handle = await fsp.open(sourcePath, "r");
    try {
      const buf = Buffer.alloc(SAMPLE_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SAMPLE_BYTES, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read ${sourcePath} for plan sampling: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }
}

function buildPrompt(sourcePath: string, sample: string): string {
  const ext = path.extname(sourcePath).toLowerCase() || "(no extension)";
  return `You are designing an embedding pipeline plan for a single source file.

File path: ${path.basename(sourcePath)}
Extension: ${ext}
First ~4KB of the file (truncated if larger):
"""
${sample}
"""

Return a JSON object that matches EXACTLY this schema. No prose. No markdown code fence. JSON only.

{
  "splitter":   one of "recursive" | "markdown" | "pdf" | "html" | "code" | "jsonl" | "csv",
  "chunkSize":  integer 64..4096 (target chunk size in tokens),
  "overlap":    integer 0..(chunkSize/4) (token overlap between chunks),
  "collection": short kebab-case slug matching ^[a-z0-9][a-z0-9_-]*$,
  "metadata":   optional object of string→string with at most 5 entries
}

Guidance:
- Pick "markdown" if the file has clear H1/H2/H3 structure.
- Pick "pdf" only when the input is actual PDF (extension is .pdf).
- Pick "csv" / "jsonl" for tabular / line-delimited data.
- Pick "code" for source code files.
- Pick "html" for HTML.
- Default to "recursive" when in doubt.
- For prose-heavy documents, chunkSize 600-1000 with overlap 80-150 works well.
- For dense reference / API docs, chunkSize 400-800 with overlap 100-200.
- For code, chunkSize 400-800 with overlap 50-100.
- For csv/jsonl, chunkSize 2048-4096 (rows are small; cap is a safety net).
- Pick a collection slug that reflects the topic, not the filename verbatim.
- Use metadata SPARINGLY: only stable, file-level facts (e.g. {"doc_type":"runbook"}). Do NOT include the date, the path, or anything that would change between runs.`;
}

interface ParseOk {
  ok: true;
  value: PlanResponse;
}
interface ParseErr {
  ok: false;
  message: string;
}

function tryParse(raw: string): ParseOk | ParseErr {
  const text = stripFences(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `not valid JSON (${(err as Error).message})` };
  }
  const result = PlanResponseSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    return {
      ok: false,
      message: `${first?.path.join(".") || "<root>"}: ${first?.message ?? "schema error"}`,
    };
  }
  return { ok: true, value: result.data };
}

function stripFences(s: string): string {
  // Models sometimes wrap JSON in ```json ... ``` despite instructions.
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1]! : s;
}

// ---------- HTTP calls ----------

async function callLlm(
  provider: PlannerProvider,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  switch (provider) {
    case "anthropic":
      return callAnthropic(apiKey, model, prompt);
    case "openai":
      return callOpenAi(apiKey, model, prompt);
    case "google":
      return callGoogle(apiKey, model, prompt);
  }
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<string> {
  const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const res = await safeFetch("anthropic", `${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
  };
  const text = (body.content ?? []).find((c) => c.type === "text")?.text;
  if (!text) {
    throw new AutoEmbedError(
      `anthropic: empty response (${body.error?.message ?? "no message"})`,
      ExitCode.ProviderApi,
    );
  }
  return text;
}

async function callOpenAi(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await safeFetch("openai", "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (!text) {
    throw new AutoEmbedError("openai: empty completion response", ExitCode.ProviderApi);
  }
  return text;
}

async function callGoogle(apiKey: string, model: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await safeFetch("google", url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AutoEmbedError("google: empty generateContent response", ExitCode.ProviderApi);
  }
  return text;
}

async function safeFetch(name: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new AutoEmbedError(
      `${name}: network failure (${(err as Error).message})`,
      ExitCode.ProviderApi,
    );
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      detail = body.error?.message ?? body.message ?? detail;
    } catch {
      // ignore
    }
    const retryHint = isRetryable(res.status) ? " (transient; retry later)" : "";
    throw new AutoEmbedError(
      `${name}: ${detail}${retryHint}`,
      ExitCode.ProviderApi,
    );
  }
  return res;
}

// ---------- Provider/key resolution ----------

export function resolvePlannerProvider(env: NodeJS.ProcessEnv = process.env): {
  provider: PlannerProvider;
  apiKey: string;
} {
  const explicit = (env.AUTO_EMBED_PLAN_PROVIDER as PlannerProvider | undefined) ?? null;
  if (explicit) {
    const key = pickKey(explicit, env);
    if (!key) {
      throw new AutoEmbedError(
        `Planner provider "${explicit}" requested but its API key is not set.`,
        ExitCode.UserConfig,
        keyHint(explicit),
      );
    }
    return { provider: explicit, apiKey: key };
  }
  // Fall through: pick the first provider whose key is set.
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY };
  if (env.OPENAI_API_KEY) return { provider: "openai", apiKey: env.OPENAI_API_KEY };
  if (env.GOOGLE_API_KEY) return { provider: "google", apiKey: env.GOOGLE_API_KEY };
  throw new AutoEmbedError(
    "No LLM provider key found for --plan.",
    ExitCode.UserConfig,
    "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY.",
  );
}

function pickKey(provider: PlannerProvider, env: NodeJS.ProcessEnv): string {
  switch (provider) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY ?? "";
    case "openai":
      return env.OPENAI_API_KEY ?? "";
    case "google":
      return env.GOOGLE_API_KEY ?? "";
  }
}

function keyHint(provider: PlannerProvider): string {
  switch (provider) {
    case "anthropic":
      return "Set ANTHROPIC_API_KEY.";
    case "openai":
      return "Set OPENAI_API_KEY.";
    case "google":
      return "Set GOOGLE_API_KEY.";
  }
}

export async function loadPlanFile(filePath: string): Promise<EmbedPlan> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`Plan file not found: ${filePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read plan ${filePath}: ${(err as Error).message}`,
      ExitCode.UserConfig,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AutoEmbedError(
      `Plan file is not valid JSON (${filePath}): ${(err as Error).message}`,
      ExitCode.UserConfig,
    );
  }
  const result = EmbedPlanSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new AutoEmbedError(
      `Plan file fails schema validation: ${first?.path.join(".") || "<root>"}: ${first?.message ?? "schema error"}`,
      ExitCode.UserConfig,
    );
  }
  return result.data;
}
