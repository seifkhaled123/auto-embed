# Cohere embeddings

## Quick start

```bash
export COHERE_API_KEY=…
npx @seifkhaled/auto-embed embed ./docs/handbook.md --provider cohere
```

## Models

| Model | Dimensions |
|---|---|
| `embed-english-v3.0` | 1024 |
| `embed-multilingual-v3.0` | 1024 |

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `apiKeys.cohere` | `COHERE_API_KEY` | env wins over config |
| `models.cohere` | `AUTO_EMBED_MODEL` | run-level override via `--model` |

## Gotchas

- Auto-embed sends `input_type: "search_document"` — appropriate for ingestion. For query-time embeddings (not in scope for v1), the caller would use `search_query`.
- Cohere's response shape uses `embeddings.float` rather than the OpenAI-style `data[].embedding`. The adapter normalises this for you.
- Default batch size is 96 (Cohere's published cap).
