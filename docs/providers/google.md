# Google embeddings (Generative Language API)

## Quick start

```bash
export GOOGLE_API_KEY=AIza…
npx auto-embed embed ./docs/handbook.md --provider google
```

## Models

| Model | Dimensions |
|---|---|
| `text-embedding-004` | 768 |

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `apiKeys.google` | `GOOGLE_API_KEY` | env wins over config |
| `models.google` | `AUTO_EMBED_MODEL` | run-level override via `--model` |

## Gotchas

- The Generative Language API has a generous free tier. Pricing in the cost estimator reflects this and reports `free` for `text-embedding-004`.
- API key auth uses `?key=` rather than `Authorization`. The key is URL-encoded but **not** logged or printed.
- The batch endpoint (`batchEmbedContents`) requires all entries to use the same model — auto-embed enforces this per-batch.
