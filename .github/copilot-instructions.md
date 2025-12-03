# Copilot Instructions for hn-archiver

## Project Overview
**hn-archiver** is a HackerNews archiving bot built on Cloudflare Workers and D1 database. It continuously fetches, archives, and updates submissions and comments from the HackerNews API.

## Architecture

### Core Components
- **Cloudflare Worker**: Serverless compute layer running on Cloudflare's global network with cron scheduling. Doc: https://developers.cloudflare.com/workers/. We are in the free tier.
- **D1 Database**: Cloudflare's managed SQLite serverless database with built-in disaster recovery and Time Travel (point-in-time recovery within 30 days). Doc: https://developers.cloudflare.com/d1/. We are in the free tier.
- **HN API Integration**: Firebase-hosted REST API at `https://hacker-news.firebaseio.com/v0/` with no rate limits

### Data Flow
1. Scheduled Worker cron trigger -> HN API calls (stories, items, comments)
2. Parse and transform HN JSON responses
3. Upsert into D1 database (idempotent)
4. Track changes via `updated_at` timestamps to avoid re-processing

## Key Patterns & Conventions

### HN API Endpoints & Data Model
All items (stories, comments, jobs, polls, pollopts) are accessed via `/v0/item/{id}.json`:
- **Stories/Jobs**: `type` ("story", "job"), `title`, `url`, `score`, `descendants` (comment count), `by` (author), `time`, `kids` (child comment IDs)
- **Comments/Pollopts**: `type` ("comment", "pollopt"), `text` (HTML), `parent` (parent ID), `score`, `by`, `time`, `kids`
- **Special endpoints**: `/v0/maxitem` (latest item ID), `/v0/topstories`, `/v0/newstories`, `/v0/beststories`, `/v0/askstories`, `/v0/showstories`, `/v0/jobstories` (up to 500 items), `/v0/updates` (changed items/profiles)
- **User endpoint**: `/v0/user/{username}.json` (only public accounts, case-sensitive)
- All timestamps are Unix epoch, items may be `deleted` or `dead`

### Database Schema
- **submissions** table: `id` (PK), `type`, `title`, `url`, `score`, `descendants`, `by`, `time`, `updated_at`
- **comments** table: `id` (PK), `parent_id`, `text`, `score`, `by`, `time`, `updated_at`
- Index on `updated_at` for efficient change tracking
- Store all times as Unix timestamps (UTC)

### Worker Scheduling & Cron
- Use `.cron` directive in `wrangler.toml` (cron syntax format: minute hour DOM month DOW)
- Example: `0 */4 * * *` runs every 4 hours
- Workers execute in parallel across Cloudflare's global network for low latency
- Use Worker bindings to access D1 environment variable in `wrangler.toml`

### D1 Database Patterns
- Create tables with `wrangler d1 execute hn-archiver --local --file=schema.sql`
- Query via Worker binding: `await env.DB.prepare("SELECT ...").all()`
- Use parameterized queries to prevent SQL injection: `prepare("... WHERE id = ?").bind(id)`
- Upsert pattern for idempotency: `INSERT INTO table (...) VALUES (...) ON CONFLICT(id) DO UPDATE SET ...`
- D1 is SQLite-compatible; leverage Time Travel for recovery (30-day window)

### Error Handling & Observability
- Log metrics with `console.log()` (visible via `wrangler tail`)
- Implement graceful failure: log errors but continue processing remaining items
- Track: items fetched, items updated, update count, error count per run
- Use Worker's built-in observability: real-time logs via `wrangler tail`, metrics in dashboard

## Development Setup

### Prerequisites
- Node.js 18+
- Wrangler CLI (latest version, includes D1 support)
- Cloudflare account with Workers + D1 enabled
- Local SQLite support for testing

### Project Setup
```bash
npm init -y
npm install --save-dev wrangler @cloudflare/workers-types typescript
npm install node-fetch  # if not using built-in fetch
wrangler init  # generates wrangler.toml
```

### Local Development
```bash
# Initialize local D1 database from schema
wrangler d1 create hn-archiver --local

# Create tables
wrangler d1 execute hn-archiver --local --file=schema.sql

# Start local Worker with D1 binding
wrangler dev

# View live logs from deployed Worker
wrangler tail
```

### Configuration (wrangler.toml)
```toml
name = "hn-archiver"
type = "service"
main = "src/worker.ts"

[[triggers.crons]]
cron = "0 */4 * * *"  # Run every 4 hours

[[d1_databases]]
binding = "DB"
database_name = "hn-archiver"
database_id = "..."  # Set after wrangler d1 create
```

### Testing Strategy
- Unit tests for HN API parsing (test with sample JSON fixtures)
- D1 integration tests using local database (no real DB queries in CI)
- Mock HN API responses in tests to avoid external dependencies
- Test upsert logic ensures idempotency (run twice, verify same result)

## Critical Conventions

1. **Error Handling**: Log failures but continue processing remaining items (fail gracefully)
2. **Idempotency**: All operations must be safe to repeat; use upserts not inserts
3. **Timestamps**: Store all dates as UTC Unix timestamps; use `updated_at` to track changes
4. **Rate Limiting**: Batch HN API requests; add reasonable delays between calls
5. **Monitoring**: Log processing metrics (items fetched, items updated, errors) for debugging

## File Structure (Expected)
```
src/
  worker.ts          # Main Worker entry point
  db.ts              # D1 database queries
  hn-api.ts          # HackerNews API client
  types.ts           # TypeScript interfaces (HN Item, etc.)
  utils.ts           # Helpers (parsing, timestamps, etc.)
schema.sql           # D1 database schema
wrangler.toml        # Cloudflare Worker config
```

## External Dependencies
- `wrangler` (v3+): Cloudflare Worker CLI and SDK
- `@cloudflare/workers-types`: TypeScript types for Workers/D1 runtime APIs
- `typescript`: For type checking
- `node-fetch` (optional): Polyfill if targeting older runtimes (Workers has built-in fetch)
- Test framework: `vitest` or `jest`

## Testing & Debugging

### Local Testing
- Mock HN API responses in fixtures to avoid real API calls in CI
- Use `wrangler d1 execute` to inspect local database: `SELECT * FROM submissions LIMIT 10`
- Test individual functions with sample data before integration testing

### Live Debugging
- Use `wrangler tail` to view real-time logs from deployed Worker
- Workers logs show: console.log output, errors, timing metrics
- Check Cloudflare dashboard for Worker status, cron execution history

### Common Issues
- **D1 query errors**: Use parameterized queries to prevent SQL injection; verify schema exists with `PRAGMA table_info(submissions)`
- **HN API timeouts**: Add retry logic with exponential backoff; cache responses when possible
- **Rate limiting**: HN returns 429 on excessive requests; implement request throttling (e.g., 1 req/100ms)
- **Time Travel recovery**: If data corrupted, use `wrangler d1 time-travel restore` to restore to previous minute within 30 days

## Deployment

### Production Deployment
- Push to main branch - automatically deploy via GitHub Actions (if configured)
- Or use `wrangler publish` manually
- Verify Worker is running: Check Cloudflare Workers dashboard, verify cron jobs executed
- Monitor with `wrangler tail` immediately after deploy to catch errors

### Database Backups
- D1 Time Travel is automatic (30-day retention)
- Export data for long-term archival: `wrangler d1 execute hn-archiver --command "SELECT * FROM submissions" > backup.json`
- Use `wrangler d1 time-travel restore` to restore to a specific minute
