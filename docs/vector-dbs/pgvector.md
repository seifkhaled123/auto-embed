# pgvector

## Quick start

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/mydb
npx @seifkhaled/auto-embed embed ./docs/handbook.md --db pgvector --collection handbook
```

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `dbs.pgvector.url` | `DATABASE_URL` | standard libpq URL |

## Schema

The first run creates the table:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "<collection>" (
  id        TEXT PRIMARY KEY,
  embedding vector(<dim>) NOT NULL,
  content   TEXT NOT NULL,
  metadata  JSONB NOT NULL DEFAULT '{}'::jsonb
);
```

Re-runs use `INSERT … ON CONFLICT (id) DO UPDATE` so the upsert is idempotent.

## Gotchas

- The Postgres server must have the `pgvector` extension installed (`CREATE EXTENSION IF NOT EXISTS vector` runs on every connection). Hosted Postgres providers expose this as a checkbox; for self-hosted, follow the [pgvector installation guide](https://github.com/pgvector/pgvector#installation).
- Collection names must match `^[a-z_][a-z0-9_]*$`. The adapter rejects anything else to keep the embedded identifier safe.
- The integrity guard reads the column's `vector(N)` dimension via `pg_attribute.atttypmod`. If a non-superuser can't read `pg_attribute`, the guard falls back to "unknown" rather than crashing — so the lockfile-side check remains the canonical safety net.
- Index recommendations (HNSW or IVFFlat) are not added automatically; create the index that fits your query workload separately:
  ```sql
  CREATE INDEX ON "handbook" USING hnsw (embedding vector_cosine_ops);
  ```
