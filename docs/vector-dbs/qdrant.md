# Qdrant

## Quick start

```bash
# Local Qdrant via Docker:
docker run -d -p 6333:6333 -p 6334:6334 qdrant/qdrant

export QDRANT_URL=http://localhost:6333
npx @seifkhaled/auto-embed embed ./docs/handbook.md --db qdrant --collection handbook

# Hosted Qdrant Cloud:
export QDRANT_URL=https://your-cluster.qdrant.io
export QDRANT_API_KEY=…
npx @seifkhaled/auto-embed embed ./docs/handbook.md --db qdrant --collection handbook
```

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `dbs.qdrant.url` | `QDRANT_URL` | defaults to `http://localhost:6333` |
| `apiKeys.qdrant` | `QDRANT_API_KEY` | optional; omit for unauthenticated local |

## Collection lifecycle

On the first run, if the collection doesn't exist, the adapter creates it with:

- `distance: Cosine`
- `size: <embedding-model-dim>`

If the collection already exists with a different size, the integrity guard refuses the run.

## Gotchas

- Qdrant point IDs must be unsigned integers **or** UUIDs — arbitrary strings are rejected. Auto-embed's chunk IDs are 16-character hex (sha256 prefix); the adapter maps each one to a deterministic UUID-shaped ID (`<8>-<4>-<4>-<4>-<12>`). The original chunk ID is preserved in payload as `_chunkId` for traceability.
- The chunk's text is stored in payload as `_text`.
- Upserts are batched at 200 points per request.
- For cloud Qdrant, make sure the API key is present **before** running — the connection-time auth check returns 401 rather than a helpful error.
