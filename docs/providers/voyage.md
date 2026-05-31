# Voyage embeddings

## Quick start

```bash
export VOYAGE_API_KEY=…
npx @seifkhaled/auto-embed embed ./docs/handbook.md --provider voyage
```

## Models

| Model | Dimensions |
|---|---|
| `voyage-3` | 1024 |
| `voyage-3-lite` | 512 |

Voyage is the embedding provider Anthropic publicly recommends.

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `apiKeys.voyage` | `VOYAGE_API_KEY` | env wins over config |
| `models.voyage` | `AUTO_EMBED_MODEL` | run-level override via `--model` |

## Gotchas

- Default batch size is 128 (Voyage's published per-request cap).
- `voyage-3` and `voyage-3-lite` have different dimensions; switching after a collection is populated triggers the integrity guard.
