import { MetricSet } from "./types.js";

export function retrievalMetrics(
  rankedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  topK: number,
): MetricSet {
  const top = rankedIds.slice(0, topK);
  const relevance = top.map((id) => relevantIds.has(id));
  const relevantRetrieved = relevance.filter(Boolean).length;
  const firstRelevant = relevance.findIndex(Boolean);
  const dcg = relevance.reduce(
    (sum, relevant, index) => sum + (relevant ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealCount = Math.min(relevantIds.size, topK);
  let idealDcg = 0;
  for (let index = 0; index < idealCount; index++) idealDcg += 1 / Math.log2(index + 2);
  return {
    hitRate: relevantRetrieved > 0 ? 1 : 0,
    recall: relevantIds.size === 0 ? 0 : relevantRetrieved / relevantIds.size,
    precision: topK === 0 ? 0 : relevantRetrieved / topK,
    mrr: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
    ndcg: idealDcg === 0 ? 0 : dcg / idealDcg,
  };
}

export function meanMetrics(metrics: readonly MetricSet[]): MetricSet {
  if (metrics.length === 0) return zeroMetrics();
  return metrics.reduce(
    (mean, current) => ({
      hitRate: mean.hitRate + current.hitRate / metrics.length,
      recall: mean.recall + current.recall / metrics.length,
      precision: mean.precision + current.precision / metrics.length,
      mrr: mean.mrr + current.mrr / metrics.length,
      ndcg: mean.ndcg + current.ndcg / metrics.length,
    }),
    zeroMetrics(),
  );
}

function zeroMetrics(): MetricSet {
  return { hitRate: 0, recall: 0, precision: 0, mrr: 0, ndcg: 0 };
}
