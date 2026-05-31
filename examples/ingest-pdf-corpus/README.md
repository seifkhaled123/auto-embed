# Example — ingest a PDF corpus with cost preview

Glob ingestion of several PDFs into one collection. Demonstrates `--dry-run` for cost estimation **before** committing to API spend, and `--collection` so all docs land in the same place.

## Run

```bash
cd examples/ingest-pdf-corpus

# Preview the plan + chunk count + USD cost without making any API calls
npx auto-embed embed "./pdfs/*.pdf" --provider openai --dry-run

# Run for real (OpenAI + auto-spawned local Chroma)
OPENAI_API_KEY=sk-… \
  npx auto-embed embed "./pdfs/*.pdf" \
    --provider openai \
    --db chroma \
    --collection product-docs \
    --concurrency 8

# Or fully local, no API key:
npx auto-embed embed "./pdfs/*.pdf" --local --collection product-docs
```

## Notes

- The PDF parser emits one section per page; the chunker further splits oversized pages.
- Each chunk's metadata includes `pageNumber` and `pageCount` so you can cite the source on retrieval.
- The cost line on `--dry-run` looks like:
  ```
  cost:            ~$0.0234 (1,170,000 tokens × text-embedding-3-small) — $0.02 / 1M tokens
  ```
- Add a few PDFs of your own to `./pdfs/` — this directory is intentionally empty in the repo to keep the example small.
