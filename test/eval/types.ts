import { SplitterName } from "../../src/plan/schema.js";

export interface EvalExperiment {
  id: string;
  splitter: SplitterName;
  chunkSize: number;
  overlap: number;
}

export interface EvalThresholds {
  hitRate: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
}

export interface EvalManifest {
  version: 1;
  name: string;
  backend: "lexical-tfidf-cosine-v1";
  corpusDir: string;
  queriesFile: string;
  topK: number;
  baselineExperiment: string;
  experiments: EvalExperiment[];
  thresholds: EvalThresholds | null;
}

export interface RelevanceLabel {
  source: string;
  contains: string;
}

export interface EvalQuery {
  id: string;
  text: string;
  relevant: RelevanceLabel[];
}

export interface EvalChunk {
  id: string;
  source: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface RankedChunk {
  chunkId: string;
  source: string;
  score: number;
  relevant: boolean;
}

export interface MetricSet {
  hitRate: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
}

export interface QueryResult {
  queryId: string;
  relevantChunkIds: string[];
  ranked: RankedChunk[];
  metrics: MetricSet;
}

export interface ExperimentResult {
  id: string;
  splitter: SplitterName;
  chunkSize: number;
  overlap: number;
  chunkCount: number;
  metrics: MetricSet;
  queries: QueryResult[];
}

export interface EvaluationResult {
  evaluatorVersion: 1;
  manifestHash: string;
  name: string;
  backend: string;
  topK: number;
  baselineExperiment: string;
  thresholds: EvalThresholds | null;
  thresholdStatus: "not-configured" | "pass" | "fail";
  experiments: ExperimentResult[];
}
