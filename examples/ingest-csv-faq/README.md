# Example — CSV FAQ with stamped metadata

CSV ingestion: one chunk per row, with the header preserved as structured metadata and a static `category` tag stamped onto every chunk.

## Run

```bash
cd examples/ingest-csv-faq

# Preview the plan and the per-row chunks
npx @seifkhaled/auto-embed embed ./faq.csv --local --dry-run

# Embed locally
npx @seifkhaled/auto-embed embed ./faq.csv \
  --local \
  --collection support-faq \
  --metadata "category=support,product=auto-embed"
```

## What you get

Each row of `faq.csv` becomes one chunk. The chunk's metadata includes:

- the full column map from the CSV row (e.g. `columns.question`, `columns.tags`),
- the row number,
- the static metadata you stamped on with `--metadata` (e.g. `category=support`).

That's enough to filter on retrieval (e.g. "search only the FAQ category") without a separate metadata store.
