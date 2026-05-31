# Pinecone

## Quick start

```bash
export PINECONE_API_KEY=pcsk-…
npx auto-embed embed ./docs/handbook.md --db pinecone --collection handbook
```

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `apiKeys.pinecone` | `PINECONE_API_KEY` | required |
| `dbs.pinecone.indexName` | — | optional default; `--collection` overrides per-run |

## Index lifecycle

On the first run, if the index doesn't exist, the adapter creates a **serverless index** with:

- `metric: cosine`
- `cloud: aws`, `region: us-east-1` (default; change in `src/vector-dbs/pinecone.ts` if you need a different region for v1)
- `dimension` matching the embedding model

If the index already exists with a different dimension, the integrity guard refuses the run before any upsert.

## Gotchas

- Pinecone metadata accepts strings, numbers, booleans, and string arrays only. Auto-embed serialises nested objects to JSON, and converts mixed arrays to string arrays via `String()`.
- The chunk's text is stored in metadata as `_text` so you can retrieve it on query without a second lookup. Pinecone's metadata budget is generous (~40 KB/record).
- Upserts are batched at 100 records per request — Pinecone's published cap.
- `--db pinecone` does not auto-create namespaces; the default namespace is used.
