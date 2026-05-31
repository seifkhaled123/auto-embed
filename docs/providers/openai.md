# OpenAI embeddings

## Quick start

```bash
export OPENAI_API_KEY=sk-…
npx @seifkhaled/auto-embed embed ./docs/handbook.md --provider openai
```

## Models

| Model | Dimensions | Default? |
|---|---|---|
| `text-embedding-3-small` | 1536 | ✓ |
| `text-embedding-3-large` | 3072 | |
| `text-embedding-ada-002` | 1536 | |

Pick a model with `--model <id>`.

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `apiKeys.openai` | `OPENAI_API_KEY` | env wins over config |
| `models.openai` | `AUTO_EMBED_MODEL` | run-level override via `--model` |

## Gotchas

- The base URL is fixed to `https://api.openai.com/v1`. Use a proxy gateway and override your DNS if you need a different endpoint.
- Default batch size is 64. Bump it (`--batch-size 128`) on faster tiers, dial back to 32 if you see 429s.
- `text-embedding-3-large` is 2× the dim of `-small`. Switching after a collection is populated triggers the integrity guard — pick a fresh `--collection`.
- Trailing whitespace and empty inputs are rejected by the API; auto-embed trims each chunk before sending.
