import { describe, expect, it } from "vitest";
import { EMBED_PRICES, estimateCost, formatUsd } from "../src/util/cost.js";

describe("estimateCost", () => {
  it("returns USD for a priced openai model", () => {
    const r = estimateCost(1_000_000, "text-embedding-3-small");
    expect(r.usd).toBeCloseTo(0.02, 6);
    expect(r.note).toContain("$0.02");
  });

  it("scales linearly with token count", () => {
    const r1 = estimateCost(500_000, "text-embedding-3-small");
    const r2 = estimateCost(1_000_000, "text-embedding-3-small");
    expect(r2.usd!).toBeCloseTo(r1.usd! * 2, 6);
  });

  it("reports free for local fastembed", () => {
    const r = estimateCost(1_000_000, "BAAI/bge-small-en-v1.5");
    expect(r.usd).toBe(0);
    expect(r.note).toMatch(/free/);
  });

  it("notes free-tier for Google's embedding model", () => {
    const r = estimateCost(1_000_000, "text-embedding-004");
    expect(r.usd).toBe(0);
    expect(r.note).toMatch(/free/);
  });

  it("returns unknown for an unfamiliar model", () => {
    const r = estimateCost(1_000_000, "unknown-model-99");
    expect(r.usd).toBeNull();
    expect(r.note).toMatch(/pricing unknown/);
  });
});

describe("formatUsd", () => {
  it("formats normal amounts to four decimals", () => {
    expect(formatUsd(0.1234)).toBe("$0.1234");
    expect(formatUsd(1.5)).toBe("$1.5000");
  });

  it("returns $0.0000 for exact zero", () => {
    expect(formatUsd(0)).toBe("$0.0000");
  });

  it("returns <$0.0001 for sub-cent fractions", () => {
    expect(formatUsd(0.00001)).toBe("<$0.0001");
  });

  it("returns unknown for null", () => {
    expect(formatUsd(null)).toBe("unknown");
  });
});

describe("EMBED_PRICES coverage", () => {
  it("has entries for every M4 default model", () => {
    const required = [
      "text-embedding-3-small",
      "text-embedding-004",
      "voyage-3",
      "embed-english-v3.0",
      "BAAI/bge-small-en-v1.5",
    ];
    for (const m of required) expect(EMBED_PRICES).toHaveProperty(m);
  });
});
