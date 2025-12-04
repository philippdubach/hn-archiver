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
  worker.ts           # HTTP routes, cron dispatcher, auth, rate limiting
  db.ts               # Database queries and usage tracking
  hn-api.ts           # HN API client with rate limiting
  ai-analysis.ts      # AI classification + embedding generation
  frontend.ts         # Embedded HTML for index and analytics pages
  types.ts            # TypeScript types, config, and budget limits
  utils.ts            # Helpers, timing-safe compare, CSP headers
  workers/
    discovery.ts      # New item discovery
    update-tracker.ts # Track item changes
    backfill.ts       # Refresh stale items + AI + embedding backfill
    embedding-backfill.ts  # Vector embedding generation
schema.sql            # Database schema including analytics cache
wrangler.toml         # Worker config with D1, AI, and Vectorize bindings
.dev.vars             # Local secrets (gitignored)
```

## Security

Auth:
- `TRIGGER_SECRET` via `wrangler secret put` (never in code)
- Timing-safe comparison for auth tokens (no timing attacks)
- Returns 503 when secret not configured (fail-closed)
- Protected: `/trigger/*`, `/api/similar/:id`, `/api/compute-topic-similarity`

Rate limiting:
- 100 requests per IP per minute on public endpoints
- Returns 429 with Retry-After header when exceeded
- In-memory, resets on cold start

CORS and headers:
- Only allows production domain and localhost
- Non-GET from unknown origins rejected (403)
- CSP headers on HTML (script-src self unsafe-inline, frame-ancestors none)
- X-Frame-Options DENY, X-Content-Type-Options nosniff

Input handling:
- Parameterized SQL queries everywhere
- HTML sanitization uses allowlist (p, a, code, pre, i, b, em, strong, etc)
- Item IDs validated as integers
- AI responses validated before use
- Error responses don't leak internals

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

## API endpoints

Public:
- `/`, `/analytics` - Embedded frontend pages
- `/health` - Health check
- `/stats` - Archive statistics
- `/api/items` - Paginated items with filtering
- `/api/item/:id` - Single item with snapshot history
- `/api/metrics` - Worker run history
- `/api/analytics` - Type distribution, top items
- `/api/advanced-analytics` - Authors, domains, viral posts, time patterns
- `/api/ai-analytics` - AI classification breakdown
- `/api/ai-analytics-extended` - Full AI stats with topic/sentiment
- `/api/embedding-analytics` - Coverage, topic clusters, similarity matrix
- `/api/usage` - Budget monitoring

Protected (need `Authorization: Bearer <secret>`):
- `/trigger/discovery` - Manual discovery run
- `/trigger/updates` - Manual updates run  
- `/trigger/backfill` - Manual backfill run
- `/trigger/ai-backfill` - Run AI analysis on pending stories
- `/api/similar/:id` - Semantic similarity search
- `/api/compute-topic-similarity` - Recompute similarity matrix
