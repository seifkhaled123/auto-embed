import type {
  EmbeddingProviderName,
  VectorDbName,
} from "../config/index.js";
import type { SplitterName } from "../plan/schema.js";

export type WorkflowResult =
  | "embed"
  | "preview"
  | "chunks"
  | "plan"
  | "embed-export";

export type PlanMode = "heuristic" | "llm" | "file";

export interface InputSelection {
  kind: "file" | "directory" | "glob" | "path";
  label: string;
}

export interface WorkflowDraft {
  result: WorkflowResult;
  inputs: InputSelection[];
  resolvedFiles: string[];
  provider?: EmbeddingProviderName;
  model?: string;
  db?: VectorDbName;
  collection?: string;
  planMode: PlanMode;
  planPath?: string;
  splitter?: SplitterName;
  chunkSize?: number;
  overlap?: number;
  metadata: Record<string, string>;
  output?: string;
  batchSize?: number;
  concurrency?: number;
  force: boolean;
  local: boolean;
}

export type WorkflowRequirement =
  | { kind: "provider-key"; provider: Exclude<EmbeddingProviderName, "local"> }
  | { kind: "database-url"; db: "pgvector" }
  | { kind: "database-key"; db: "pinecone" }
  | { kind: "planner-key" };
