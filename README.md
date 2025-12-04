# HackerNews Archiver

A real-time HackerNews archiving system built on Cloudflare Workers. Captures every post and comment as they appear, tracks score/comment changes over time with intelligent snapshots, classifies content using Workers AI, and supports semantic similarity search via vector embeddings.

## Features

- **Real-time archiving** - Discovers new items every 3 minutes via HN API `/v0/maxitem`
- **Change tracking** - Monitors score/comment count changes with snapshots on score spikes (≥20 points), front page appearances, and periodic sampling
- **AI classification** - Topic categorization (13 categories), content type detection (Show HN, Ask HN, news, tutorial, etc.), and sentiment analysis
- **Similarity search** - 768-dimensional embeddings via BGE model for finding related posts
- **Web interface** - Embedded frontend for browsing archive and analytics dashboard
- **Budget-aware** - Built-in usage tracking to stay within Cloudflare paid plan limits

## Architecture

Three cron-triggered workers handle data flow:

| Worker | Schedule | Function |
|--------|----------|----------|
| **Discovery** | `*/3 * * * *` (every 3 min) | Fetches new items from `lastSeen+1` to current `maxitem` |
| **Updates** | `*/10 * * * *` (every 10 min) | Refreshes recently changed items via `/v0/updates` |
| **Backfill** | `0 */2 * * *` (every 2 hours) | Revisits stale high-value items (score>50 OR descendants>20), runs AI analysis, generates embeddings, cleans up old logs |

**Data flow**: HN API → Discovery/Updates workers → D1 `items` table → Backfill worker → AI analysis (`ai_topic`, `ai_sentiment`, `ai_content_type` columns) → Vectorize index `hn-similar`

## Setup

```bash
npm install

# Create the D1 database
npx wrangler d1 create hn-archiver
# Copy the database_id to wrangler.toml

# Create the Vectorize index for similarity search
npx wrangler vectorize create hn-similar --dimensions=768 --metric=cosine

# Initialize the database schema
npx wrangler d1 execute hn-archiver --local --file=schema.sql

# Set the admin secret for protected endpoints
npx wrangler secret put TRIGGER_SECRET

# Run locally
npm run dev

# Deploy
npm run deploy
```

## API Endpoints

### Public (rate-limited to 100 req/IP/min)

| Path | Description |
|------|-------------|
| `/` | Archive browser frontend |
| `/analytics` | Analytics dashboard frontend |
| `/health` | Health check with last run times |
| `/stats` | Archive statistics (total items, today's counts, etc.) |
| `/api/items` | Paginated items with filtering (`?limit=50&offset=0&type=story&orderBy=time&order=desc&since=UNIX_TS`) |
| `/api/item/:id` | Single item with full snapshot history |
| `/api/analytics` | Type distribution, snapshot reasons, top items |
| `/api/advanced-analytics` | Authors, domains, viral posts, posting patterns by hour/day |
| `/api/ai-analytics` | AI classification breakdown by topic/type |
| `/api/ai-analytics-extended` | Full AI stats with performance metrics by topic/sentiment |
| `/api/embedding-analytics` | Embedding coverage, topic clusters, cached similarity matrix |
| `/api/usage` | Budget monitoring (Vectorize queries, stored vectors) |
| `/api/metrics` | Worker run history with durations and error counts |

### Protected (require `Authorization: Bearer <TRIGGER_SECRET>`)

| Path | Description |
|------|-------------|
| `/trigger/discovery` | Manual discovery run |
| `/trigger/updates` | Manual updates run |
| `/trigger/backfill` | Manual backfill run |
| `/trigger/ai-backfill` | Run AI analysis on up to 50 pending stories |
| `/api/similar/:id` | Find semantically similar posts (`?limit=5`, max 10) |
| `/api/compute-topic-similarity` | Recompute and cache topic similarity matrix |

## Frontend

The frontend is embedded directly in the worker (`src/frontend.ts`) - no separate static file hosting needed:

- `/` - Archive browser with filtering, pagination, comment thread expansion
- `/analytics` - Dashboard with posting patterns, author stats, AI classification breakdown, embedding coverage visualization

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|----------|
| **Compute** | Cloudflare Workers | Serverless with cron triggers |
| **Database** | D1 (SQLite) | Items, snapshots, metrics, usage counters |
| **AI - Topics** | `@cf/meta/llama-3.2-1b-instruct` | Topic & content type classification |
| **AI - Sentiment** | `@cf/huggingface/distilbert-sst-2-int8` | Sentiment analysis (0-1 score) |
| **AI - Embeddings** | `@cf/baai/bge-base-en-v1.5` | 768-dim vectors for similarity |
| **Vector DB** | Vectorize | Similarity search index `hn-similar` |
| **Language** | TypeScript | Type-safe with strict null checks |
| **Testing** | Vitest + Miniflare | Unit tests with D1/AI/Vectorize mocks |

## Security

- **Rate limiting** - 100 requests/IP/minute on all endpoints. Returns 429 with `Retry-After: 60` header.
- **Fail-closed auth** - Protected endpoints return 503 if `TRIGGER_SECRET` isn't configured, 401 if auth fails. Uses timing-safe comparison.
- **CORS** - Allowlist: `https://hn-archiver.philippd.workers.dev`, `http://localhost:8787`. Non-GET from other origins rejected with 403.
- **CSP headers** - HTML responses include `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
- **Input validation** - Parameterized SQL everywhere, item IDs validated (1 to 100M range), allowlist-based sanitization.

## Budget Limits

Designed to stay within Cloudflare paid plan included amounts:

| Resource | Limit | Tracking |
|----------|-------|----------|
| D1 reads | 500M/day (conservative) | `usage_counters` table |
| Vectorize queries | 1,500/day | `vectorize_queries_YYYY-MM-DD` counter |
| Stored vectors | 10,000 max | `embedding_backfill` limit check |
| Embeddings per run | 50 | `EMBEDDING_BATCH_SIZE` constant |

Monitor usage at `/api/usage`. Warnings appear when approaching 80% of limits.

## Development

```bash
npm run dev              # Local dev server at localhost:8787
npm run test             # Run Vitest test suite
npm run typecheck        # TypeScript compilation check
npx wrangler tail        # Stream production logs

# D1 queries
npx wrangler d1 execute hn-archiver --local --command "SELECT COUNT(*) FROM items"
npx wrangler d1 execute hn-archiver --remote --command "SELECT COUNT(*) FROM items"

# Manual trigger
curl -H "Authorization: Bearer $TRIGGER_SECRET" https://hn-archiver.philippd.workers.dev/trigger/backfill
```

## Database Schema

Key tables in `schema.sql`:

- `items` - All HN content with AI analysis columns (`ai_topic`, `ai_sentiment`, `ai_content_type`, `embedding_generated_at`)
- `item_snapshots` - Time-series data with `snapshot_reason` (score_spike, front_page, sample, new_item)
- `archiving_state` - Progress tracking (`max_item_id_seen`, `last_*_run` timestamps)
- `worker_metrics` - Run history with durations and error counts
- `usage_counters` - Budget tracking by day/month
- `analytics_cache` - Cached expensive computations (topic similarity matrix)

## License

MIT
