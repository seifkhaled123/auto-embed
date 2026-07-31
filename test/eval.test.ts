import path from "node:path";
import { describe, expect, it } from "vitest";
import { rankLexicalTfidf, tokenize } from "./eval/backend.js";
import { retrievalMetrics } from "./eval/metrics.js";
import { renderEvaluationHtml } from "./eval/report.js";
import { runEvaluation } from "./eval/run.js";

const manifest = path.resolve("test/fixtures/eval/manifest.json");

describe("private retrieval-quality evaluator", () => {
  it("tokenizes deterministically and ranks the lexical match first", () => {
    expect(tokenize("What is the API-key policy?")).toEqual(["api", "key", "policy"]);
    const ranked = rankLexicalTfidf("ninety day key rotation", [
      { id: "a", source: "a.md", text: "keys rotate every ninety days", metadata: {} },
      { id: "b", source: "b.md", text: "release captain rotates weekly", metadata: {} },
    ]);
    expect(ranked[0]!.chunkId).toBe("a");
  });

  it("computes standard binary retrieval metrics", () => {
    expect(retrievalMetrics(["x", "a", "b"], new Set(["a", "b"]), 3)).toEqual({
      hitRate: 1,
      recall: 1,
      precision: 2 / 3,
      mrr: 1 / 2,
      ndcg: expect.closeTo(0.6934264036172708, 12),
    });
  });

  it("reproduces the same evaluation result from the same manifest", async () => {
    const first = await runEvaluation(manifest);
    const second = await runEvaluation(manifest);
    expect(second).toEqual(first);
    expect(first.experiments).toHaveLength(3);
    expect(first.experiments.find((entry) => entry.id === first.baselineExperiment)).toBeDefined();
    expect(first.thresholdStatus).toBe("pass");
  });

  it("renders a self-contained HTML lab report", async () => {
    const result = await runEvaluation(manifest);
    const html = renderEvaluationHtml(result);
    expect(html).toContain("<title>auto-embed — Retrieval Quality Lab</title>");
    expect(html).toContain(result.baselineExperiment);
    expect(html).not.toMatch(/<(script|img|link)[^>]+(src|href)=["']https?:/i);
  });
});
