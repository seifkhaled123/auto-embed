import type { Tiktoken } from "js-tiktoken/lite";

let encoder: Tiktoken | null = null;

async function ensureEncoder(): Promise<Tiktoken> {
  if (encoder) return encoder;
  const { Tiktoken } = await import("js-tiktoken/lite");
  const cl100k = (await import("js-tiktoken/ranks/cl100k_base")).default;
  encoder = new Tiktoken(cl100k);
  return encoder;
}

export async function countTokens(text: string): Promise<number> {
  if (!text) return 0;
  const enc = await ensureEncoder();
  return enc.encode(text).length;
}

/**
 * Sync variant for use *inside* the recursive splitter. The encoder is
 * primed via `primeTokenizer()` before the splitter runs so we never pay
 * an async hop per separator iteration.
 */
export function countTokensSync(text: string): number {
  if (!text) return 0;
  if (!encoder) throw new Error("Tokenizer not primed; call primeTokenizer() first.");
  return encoder.encode(text).length;
}

export async function primeTokenizer(): Promise<void> {
  await ensureEncoder();
}
