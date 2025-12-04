# Copilot Instructions

## Architecture

HackerNews archiver on Cloudflare Workers + D1 + Workers AI + Vectorize.

**Data flow**: HN API (`/v0/maxitem`, `/v0/updates`) → Discovery/Updates workers → D1 `items` table → Backfill worker → AI analysis (`ai_topic`, `ai_sentiment` columns) → Vectorize index `hn-similar`

**Cron schedules** (wrangler.toml `[triggers].crons`):
- `*/3 * * * *` → `runDiscovery()` - fetches items from `lastSeen+1` to current `maxitem`
- `*/10 * * * *` → `runUpdateTracker()` - refreshes items from `/v0/updates`
- `0 */2 * * *` → `runBackfill()` - refreshes stale items (score>50 OR descendants>20, not updated in 24h), then AI analysis, then embeddings

## Critical Patterns

**Timestamps**: HN API returns Unix seconds (`item.time`). Internal tracking uses milliseconds (`getCurrentTimestampMs()`). Don't mix them.

**Idempotency**: All DB writes are upserts. `batchUpsertItems()` checks existing data, computes diffs, returns `{ processed, changed, snapshots }`. Safe to re-run any worker.

**Error handling**: Workers catch all errors, log to `error_log` table via `logError()`, and continue. Never throw from `scheduled()` or `fetch()` handlers.

**Budget limits** (types.ts `BudgetLimits`):
- `VECTORIZE_QUERIES_PER_DAY: 1500` - check via `checkUsageLimits(db, 'vectorize_query')`
- `VECTORIZE_MAX_STORED_VECTORS: 10000` - check via `checkUsageLimits(db, 'embedding_backfill')`
- `EMBEDDING_BATCH_SIZE: 50` - max embeddings per backfill run
- Track usage: `incrementUsageCounter(db, 'vectorize_queries_YYYY-MM-DD', 1)`

**Batch DB operations**: Use `db.batch(statements)` for transactions. See `batchUpsertItems()` - builds array of prepared statements, executes atomically.

**Snapshots**: Created when score increases ≥20 points (`score_spike`), item on front page (`front_page`), or every 4th update (`sample`). Logic in `shouldCreateSnapshot()` utils.ts.

## File Responsibilities

```
src/worker.ts        # scheduled() routes crons by pattern, fetch() handles HTTP
src/db.ts            # ALL SQL lives here. No raw SQL elsewhere.
src/ai-analysis.ts   # analyzeStory(), batchGenerateEmbeddings(), generateEmbedding()
src/types.ts         # BudgetLimits, Config, type guards (isValidHNItem, isValidHNUpdates)
src/utils.ts         # timingSafeEqual(), shouldCreateSnapshot(), retryWithBackoff()
src/workers/*.ts     # Thin orchestration, delegate to db.ts and ai-analysis.ts
src/frontend.ts      # INDEX_HTML, ANALYTICS_HTML constants (embedded, no static files)
```

## Security

**Protected routes** (`/trigger/*`, `/api/similar/:id`, `/api/compute-topic-similarity`):
```typescript
const triggerSecret = env.TRIGGER_SECRET;
if (!triggerSecret) return new Response(..., { status: 503 }); // fail-closed
if (!validateAuth(authHeader, triggerSecret)) return new Response(..., { status: 401 });
```

**SQL**: Always `db.prepare('...?...').bind(value)`. Never string interpolation.

**Item ID validation**: `const MAX_REASONABLE_ID = 100_000_000; if (isNaN(itemId) || itemId < 1 || itemId > MAX_REASONABLE_ID)`

**CORS**: `allowedOrigins = ['https://hn-archiver.philippd.workers.dev', 'http://localhost:8787']`. Reject non-GET from unknown origins.

**Rate limiting**: 100 req/IP/min, in-memory `rateLimitMap`, returns 429 with `Retry-After: 60`.

## Commands

```bash
npm run dev                    # localhost:8787, uses local D1
npx wrangler tail              # stream production logs
npx wrangler d1 execute hn-archiver --remote --command "SELECT COUNT(*) FROM items"
npx wrangler d1 execute hn-archiver --local --file=schema.sql
npx wrangler secret put TRIGGER_SECRET
curl -H "Authorization: Bearer $SECRET" https://hn-archiver.philippd.workers.dev/trigger/backfill
```

## Adding Features

**New DB query**: Add to db.ts. Use `db.prepare().bind()`. Throw `DatabaseError` on failure. Return typed result.

**New endpoint**: Add to `fetch()` in worker.ts. Pattern: validate input → call db.ts function → return `Response` with `corsHeaders`.

**New AI model**: Add to ai-analysis.ts. Validate response structure (AI can return unexpected formats). Use `Promise.allSettled` for batches.

**New worker**: Create `src/workers/foo.ts`, export `async function runFoo(env: WorkerEnv): Promise<WorkerResult>`. Add to `scheduled()` switch in worker.ts.

## AI Models

| Model | Use | Input | Output |
|-------|-----|-------|--------|
| `@cf/meta/llama-3.2-1b-instruct` | Topic classification | `{ prompt, max_tokens: 20, temperature: 0.1 }` | `{ response: string }` |
| `@cf/huggingface/distilbert-sst-2-int8` | Sentiment | `{ text }` | `[{ label: "POSITIVE"|"NEGATIVE", score: 0-1 }]` |
| `@cf/baai/bge-base-en-v1.5` | Embeddings | `{ text }` | `{ data: [[...768 floats]] }` |
