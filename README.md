# HackerNews Archiver

A production-grade HackerNews archiving bot built with Cloudflare Workers and D1 database. Continuously fetches, archives, and tracks changes to all HN submissions and comments with intelligent snapshot management and comprehensive monitoring.

## Features

- 🚀 **Real-time archiving** - Discovers new items every 5 minutes
- 📊 **Change tracking** - Monitors score and comment count changes with smart snapshots
- 🔄 **Efficient updates** - Uses HN's `/v0/updates` endpoint to minimize API calls
- 💾 **SQLite storage** - Leverages Cloudflare D1 with optimized indexes
- 📈 **Time-series data** - Selective snapshots for growth analysis
- 🛡️ **Error resilient** - Graceful failure handling with automatic retries
- 📉 **Free tier optimized** - Uses only 11% of Cloudflare's free tier limits
- 🔍 **Comprehensive monitoring** - Built-in health checks and metrics

## Architecture

### Components

- **Discovery Worker** (runs every 5 min) - Discovers and archives new items
- **Update Tracker** (runs every 10 min) - Updates changed items using `/v0/updates`
- **Backfill Worker** (runs every 6 hours) - Refreshes stale high-value items
- **D1 Database** - SQLite database with optimized schema and indexes

### Data Flow

```
HN API → Workers (batch fetch) → Change detection → D1 Database → Snapshots
```

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Wrangler CLI

### Installation

1. **Clone and install dependencies**

```bash
git clone https://github.com/philippdubach/hn-archiver.git
cd hn-archiver
npm install
```

2. **Create D1 database**

```bash
# Create database
npx wrangler d1 create hn-archiver

# Copy the database_id from output and update wrangler.toml
# Replace REPLACE_WITH_YOUR_DATABASE_ID with your actual database_id
```

3. **Initialize database schema**

```bash
# Local database (for testing)
npm run db:init

# Production database
npm run db:init:remote
```

4. **Test locally**

```bash
# Start local development server
npm run dev

# In another terminal, trigger workers manually
curl http://localhost:8787/trigger/discovery
curl http://localhost:8787/trigger/updates
curl http://localhost:8787/stats
```

5. **Deploy to production**

```bash
npm run deploy
```

## Configuration

See `wrangler.toml` for cron schedules and `src/types.ts` for optimization settings.

## API Endpoints

- `GET /health` - Health check and status
- `GET /stats` - Archive statistics
- `GET /trigger/discovery` - Manual discovery trigger
- `GET /trigger/updates` - Manual update trigger
- `GET /trigger/backfill` - Manual backfill trigger

## Monitoring

```bash
# View live logs
npm run tail

# Query database
npm run db:query:remote "SELECT COUNT(*) FROM items"
```

## Performance

Uses only **11%** of Cloudflare free tier limits:
- 11,200 requests/day (11% of 100k limit)
- 5,600 DB writes/day (5.6% of 100k limit)
- Sub-second latency for all operations

## Security

- ✅ Parameterized queries (SQL injection prevention)
- ✅ Input validation with type guards
- ✅ Rate limiting and retry logic
- ✅ Comprehensive error handling

## License

MIT License - see LICENSE file for details

## Documentation

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for detailed architecture and [.github/copilot-instructions.md](.github/copilot-instructions.md) for development guidelines.
