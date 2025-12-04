# HackerNews Archiver

A HackerNews archiving system built on Cloudflare Workers. Captures posts and comments in real-time, tracks how they change over time, classifies content with AI, and supports semantic similarity search using vector embeddings.

## Features

- Archives every new HN submission and comment as they appear
- Tracks score and comment count changes with periodic snapshots
- Classifies content by topic, type, and sentiment using Workers AI
- Generates vector embeddings for similarity search via Cloudflare Vectorize
- Provides a web interface for browsing the archive and viewing analytics
- Protected admin endpoints for manual triggers and expensive operations

## Architecture

Four workers run on cron schedules:

- **Discovery** (every 3 min) - fetches new items from `/v0/maxitem`
- **Updates** (every 10 min) - refreshes changed items via `/v0/updates`
- **Backfill** (every 2 hours) - revisits high-value older items and runs AI analysis
- **Embedding backfill** - generates vector embeddings for analyzed stories (runs within backfill)

All data lives in D1 (SQLite). Vector embeddings are stored in Cloudflare Vectorize for similarity search. The frontend is static HTML/JS served directly from the worker.

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

### Public (read-only)

| Path | Description |
|------|-------------|
| `/` | Health check and status |
| `/stats` | Archive statistics |
| `/api/items` | Paginated item list with filtering |
| `/api/item/:id` | Single item with snapshot history |
| `/api/analytics` | Basic type distribution and top items |
| `/api/advanced-analytics` | Authors, domains, viral posts, time patterns |
| `/api/ai-analytics` | AI classification breakdown |
| `/api/ai-analytics-extended` | Full AI stats with topic/sentiment performance |
| `/api/embedding-analytics` | Embedding coverage and topic similarity matrix |
| `/api/usage` | Budget monitoring for Vectorize queries |
| `/api/metrics` | Worker run history |

### Protected (require Authorization header)

| Path | Description |
|------|-------------|
| `/trigger/discovery` | Manual discovery run |
| `/trigger/updates` | Manual updates run |
| `/trigger/backfill` | Manual backfill run |
| `/trigger/ai-backfill` | Run AI analysis on pending stories |
| `/api/similar/:id` | Find semantically similar posts |
| `/api/compute-topic-similarity` | Recompute topic similarity matrix |

Protected endpoints require: `Authorization: Bearer <TRIGGER_SECRET>`

## Frontend

The frontend is embedded directly in the worker (no separate static files). Served from `src/frontend.ts`:

- `/` - Archive browser with filtering, pagination, comment expansion
- `/analytics` - Dashboard with posting patterns, author stats, AI breakdown, embedding coverage

## Tech Stack

- **Cloudflare Workers** - serverless compute with cron triggers
- **D1** - SQLite database for items, snapshots, and metrics
- **Workers AI** - Llama 3.2 for topic/content classification, DistilBERT for sentiment
- **Vectorize** - vector database for 768-dimensional embeddings (bge-base-en-v1.5)
- **TypeScript** - type-safe codebase

## Security

The API has a few layers of protection:

- **Rate limiting** - 100 requests per IP per minute on public endpoints. Returns 429 with Retry-After header.
- **Auth** - Protected endpoints require `Authorization: Bearer <TRIGGER_SECRET>`. Uses timing-safe comparison. Returns 503 if secret isn't configured (fail-closed).
- **CORS** - Only allows requests from the production domain and localhost. Non-GET requests from other origins get 403.
- **CSP headers** - All HTML responses include Content-Security-Policy, X-Frame-Options DENY, etc.
- **Input validation** - Parameterized SQL, allowlist-based HTML sanitization, integer validation on IDs.

## Budget Considerations

The system is designed to stay within Cloudflare's paid plan included limits:

- D1: well under 25B reads/month
- Vectorize: 1,500 queries/day limit, 10,000 stored vectors max
- Embedding generation: 50 per backfill run

Usage is tracked in the `usage_counters` table and exposed via `/api/usage`.

## License

MIT
