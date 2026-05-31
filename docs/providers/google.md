# Google embeddings (Generative Language API)

## Quick start

```bash
export GOOGLE_API_KEY=AIza…
npx @seifkhaled/auto-embed embed ./docs/handbook.md --provider google
```

## Models

| Model | Default dim | Notes |
|---|---|---|
| `gemini-embedding-001` | 3072 | Stable replacement for the retired `text-embedding-004` (deprecated 2026-01-14). Supports Matryoshka output dims 128–3072. |

The older `text-embedding-004` was retired on **2026-01-14** and Google's official migration target is `gemini-embedding-001`. Auto-embed defaults to the new model.

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `apiKeys.google` | `GOOGLE_API_KEY` | env wins over config |
| `models.google` | `AUTO_EMBED_MODEL` | run-level override via `--model` |

## Gotchas

- `gemini-embedding-001` is **not free** beyond the introductory rate-limited free tier. The published rate is **$0.15 / 1M input tokens** — that's what the cost estimator reports. If you only need a smoke test, the free tier still covers low-volume usage.
- The model supports flexible output dimensions via the API's `output_dimensionality` parameter (recommended: 768, 1536, 3072). Auto-embed v1 sticks with the default 3072 — picking a smaller dim is a `TODO(v2)`. If you want to switch later, use a fresh `--collection` so the dim-mismatch guard doesn't refuse.
- API key auth uses `?key=` rather than `Authorization`. The key is URL-encoded but **not** logged or printed.
- The batch endpoint (`batchEmbedContents`) requires all entries to use the same model — auto-embed enforces this per-batch.
- 3072-dim vectors are large (12 KB each). For multi-GB corpora consider whether Pinecone serverless or pgvector storage costs justify the higher recall.
