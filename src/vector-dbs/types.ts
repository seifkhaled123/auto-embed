import { Embedded } from "../embed/engine.js";

export interface CollectionInfo {
  dim: number;
}

export interface VectorDB {
  readonly name: string;
  ensureCollection(name: string, dim: number): Promise<void>;
  describeCollection(name: string): Promise<CollectionInfo | null>;
  upsert(collection: string, rows: Embedded[]): Promise<void>;
  deleteByIds(collection: string, ids: string[]): Promise<void>;
  /** Optional lifecycle hook for adapters that spawn a subprocess (chroma local). */
  close?(): Promise<void>;
}
