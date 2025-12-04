# Copilot Instructions

## Project

HackerNews archiver using Cloudflare Workers, D1, and Workers AI. Free tier only.

## Stack

- **Workers**: Serverless functions with cron triggers
- **D1**: SQLite database (use parameterized queries, upserts for idempotency)
- **Workers AI**: Llama 3.2-1B for classification, DistilBERT for sentiment
- **HN API**: `https://hacker-news.firebaseio.com/v0/` (no auth, no rate limits)

## File structure

```
src/
  worker.ts           # HTTP routes and cron dispatcher
  db.ts               # Database queries
  hn-api.ts           # HN API client with rate limiting
  ai-analysis.ts      # AI classification functions
  types.ts            # TypeScript types and config
  utils.ts            # Helpers
  workers/
    discovery.ts      # New item discovery
    update-tracker.ts # Track item changes
    backfill.ts       # Refresh stale items + AI backfill
frontend/
  index.html          # Archive viewer
  analytics.html      # Stats dashboard
schema.sql            # Database schema
wrangler.toml         # Worker config
```

## Conventions

- All timestamps are Unix epoch (seconds for HN data, milliseconds for internal)
- Upsert everything (safe to re-run)
- Log errors but don't throw (graceful degradation)
- Batch API requests (100 concurrent max)
- AI analysis only on stories with titles

## Common commands

```bash
npm run dev              # Local dev server
npm run deploy           # Deploy to Cloudflare
npx wrangler tail        # Live logs
npx wrangler d1 execute hn-archiver --remote --command "SELECT ..."
```

## HN API quick reference

- `/v0/maxitem.json` - Latest item ID
- `/v0/item/{id}.json` - Single item
- `/v0/updates.json` - Recently changed items/profiles
- `/v0/topstories.json` - Front page IDs (up to 500)
