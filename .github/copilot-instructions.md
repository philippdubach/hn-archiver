# Copilot Instructions

## Project

HackerNews archiver using Cloudflare Workers, D1, Workers AI, and Vectorize. Running on the paid plan but designed to stay within included limits.

## Stack

- **Workers**: Serverless functions with cron triggers
- **D1**: SQLite database (parameterized queries, upserts for idempotency)
- **Workers AI**: Llama 3.2-1B for topic/content classification, DistilBERT for sentiment
- **Vectorize**: Vector database for similarity search (768 dimensions, cosine metric, bge-base-en-v1.5 embeddings)
- **HN API**: `https://hacker-news.firebaseio.com/v0/` (no auth, no rate limits)

## File structure

```
src/
  worker.ts           # HTTP routes and cron dispatcher
  db.ts               # Database queries and usage tracking
  hn-api.ts           # HN API client with rate limiting
  ai-analysis.ts      # AI classification + embedding generation
  types.ts            # TypeScript types, config, and budget limits
  utils.ts            # Helpers
  workers/
    discovery.ts      # New item discovery
    update-tracker.ts # Track item changes
    backfill.ts       # Refresh stale items + AI + embedding backfill
    embedding-backfill.ts  # Vector embedding generation
frontend/
  index.html          # Archive viewer
  analytics.html      # Stats dashboard with embedding analytics
schema.sql            # Database schema including analytics cache
wrangler.toml         # Worker config with D1, AI, and Vectorize bindings
.dev.vars             # Local secrets (gitignored)
```

## Security

- `TRIGGER_SECRET` stored via `wrangler secret put` (never in code)
- Protected endpoints: `/trigger/*`, `/api/similar/:id`, `/api/compute-topic-similarity`
- Public endpoints are read-only

## Conventions

- All timestamps are Unix epoch (seconds for HN data, milliseconds for internal)
- Upsert everything (safe to re-run)
- Log errors but don't throw (graceful degradation)
- Batch API requests (100 concurrent max)
- AI analysis only on stories with titles
- Track usage in `usage_counters` table for budget compliance

## Budget limits (paid plan included amounts)

- D1: 25B reads/month (we use a fraction of this)
- Vectorize: 50M queried dimensions/month (~65k queries at 768d), 10M stored dimensions (~13k vectors)
- Conservative daily limits: 1,500 Vectorize queries, 10,000 max stored vectors
- Embedding batch size: 50 per backfill run

## Common commands

```bash
npm run dev              # Local dev server
npm run deploy           # Deploy to Cloudflare
npx wrangler tail        # Live logs
npx wrangler d1 execute hn-archiver --remote --command "SELECT ..."
npx wrangler secret put TRIGGER_SECRET  # Set admin secret
```

## HN API quick reference

- `/v0/maxitem.json` - Latest item ID
- `/v0/item/{id}.json` - Single item
- `/v0/updates.json` - Recently changed items/profiles
- `/v0/topstories.json` - Front page IDs (up to 500)

## Key API endpoints

- `/api/embedding-analytics` - Coverage stats, topic clusters, cached similarity matrix
- `/api/similar/:id` - Find semantically similar posts (protected)
- `/api/compute-topic-similarity` - Recompute and cache topic similarity matrix (protected)
- `/api/usage` - Budget monitoring
