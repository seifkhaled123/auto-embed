# Examples

Three small, copy-and-run patterns showing what `auto-embed` does in practice. Each example has its own README. None require a real cloud account — they all work with `--local` (fastembed + Chroma).

| Example | What it shows |
|---|---|
| [`ingest-readme/`](./ingest-readme/) | Smallest possible flow: embed a single markdown file locally, watch idempotent re-runs. |
| [`ingest-pdf-corpus/`](./ingest-pdf-corpus/) | Glob ingestion of a small PDF corpus into one collection, with `--dry-run` cost preview. |
| [`ingest-csv-faq/`](./ingest-csv-faq/) | Row-per-chunk CSV ingestion with static metadata stamped onto every row. |
