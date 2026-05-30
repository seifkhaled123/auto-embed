import crypto from "node:crypto";
import { z } from "zod";

export const SplitterName = z.enum([
  "recursive",
  "markdown",
  "pdf",
  "html",
  "code",
  "jsonl",
  "csv",
]);
export type SplitterName = z.infer<typeof SplitterName>;

export const EmbedPlanSchema = z.object({
  version: z.literal(1),
  splitter: SplitterName,
  chunkSize: z.number().int().positive(),
  overlap: z.number().int().nonnegative(),
  metadata: z.record(z.string()),
  collection: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lowercase alphanumeric with - or _"),
  embeddingModel: z.string().min(1),
});
export type EmbedPlan = z.infer<typeof EmbedPlanSchema>;

/**
 * Canonical JSON serialization: object keys sorted, no extra whitespace. This
 * is what we hash to derive `planHash` — must be stable across runs and
 * machines, so it cannot depend on key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

export function hashPlan(plan: EmbedPlan): string {
  return crypto.createHash("sha256").update(canonicalJson(plan)).digest("hex");
}
