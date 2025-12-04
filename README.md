# HackerNews Archiver

A HackerNews archiving system that captures posts and comments in real-time, tracks how they change over time, and provides AI-powered content analysis. Runs entirely on Cloudflare's free tier.

## What it does

- Archives every new HN submission and comment as they appear
- Tracks score and comment count changes with periodic snapshots
- Classifies content by topic, type, and sentiment using Workers AI
- Provides a web interface for browsing the archive and viewing analytics

## How it works

Three workers run on schedules:

- **Discovery** (every 3 min) - fetches new items from `/v0/maxitem`
- **Updates** (every 10 min) - refreshes changed items via `/v0/updates`
- **Backfill** (every 2 hours) - revisits high-value older items, runs AI analysis on unprocessed stories

All data lives in a D1 SQLite database. The frontend is plain HTML/JS served from the worker.

## Setup

```bash
npm install

# Create the database
npx wrangler d1 create hn-archiver
# Copy the database_id to wrangler.toml

# Initialize schema
npx wrangler d1 execute hn-archiver --local --file=schema.sql

# Run locally
npm run dev

# Deploy
npm run deploy
```

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Health check |
| `/stats` | Archive statistics |
| `/api/items` | Paginated item list |
| `/api/item/:id` | Single item with snapshots |
| `/api/analytics` | Basic analytics |
| `/api/advanced-analytics` | Detailed stats (authors, domains, viral posts) |
| `/api/ai-analytics` | AI classification breakdown |
| `/trigger/*` | Manual worker triggers (protected) |

## Frontend

- `index.html` - Archive browser with filtering and comment expansion
- `analytics.html` - Charts and statistics dashboard

## Tech stack

- Cloudflare Workers (compute)
- D1 (SQLite database)
- Workers AI (content classification)
- TypeScript

## License

MIT
