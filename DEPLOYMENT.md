# Deployment Guide

## Pre-Deployment Checklist

- [ ] Node.js 18+ installed
- [ ] Wrangler CLI installed (`npm install -g wrangler`)
- [ ] Cloudflare account created
- [ ] Authenticated with Wrangler (`wrangler login`)

## Step-by-Step Deployment

### 1. Install Dependencies

```bash
npm install
```

### 2. Create D1 Database

```bash
npx wrangler d1 create hn-archiver
```

**Important**: Copy the `database_id` from the output. It looks like:
```
✅ Successfully created DB 'hn-archiver' in region WEUR
Created your database using D1's new storage backend.

[[d1_databases]]
binding = "DB"
database_name = "hn-archiver"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 3. Update wrangler.toml

Edit `wrangler.toml` and replace `REPLACE_WITH_YOUR_DATABASE_ID` with your actual database ID:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hn-archiver"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # Your actual ID here
```

### 4. Initialize Database Schema

For production:
```bash
npm run db:init:remote
```

This will create all tables, indexes, and initial state.

### 5. Test Locally (Optional but Recommended)

```bash
# Initialize local database for testing
npm run db:init

# Start local dev server
npm run dev

# In another terminal, test the workers
curl http://localhost:8787/health
curl http://localhost:8787/trigger/discovery
curl http://localhost:8787/stats
```

### 6. Deploy to Production

```bash
npm run deploy
```

Wrangler will output your Worker URL, something like:
```
Published hn-archiver (X.XX sec)
  https://hn-archiver.your-subdomain.workers.dev
```

### 7. Verify Deployment

```bash
# Check health
curl https://hn-archiver.your-subdomain.workers.dev/health

# View stats
curl https://hn-archiver.your-subdomain.workers.dev/stats

# Manually trigger discovery (optional)
curl https://hn-archiver.your-subdomain.workers.dev/trigger/discovery
```

### 8. Monitor Logs

```bash
# Tail live logs
npm run tail

# Or with wrangler directly
npx wrangler tail --format pretty
```

## Cron Schedule Verification

After deployment, cron triggers should start automatically:
- Discovery: Every 5 minutes (`*/5 * * * *`)
- Updates: Every 10 minutes (`*/10 * * * *`)
- Backfill: Every 6 hours (`0 */6 * * *`)

Check the Cloudflare dashboard to verify cron executions:
1. Go to Workers & Pages
2. Click on `hn-archiver`
3. Go to "Logs" tab
4. Filter by "Cron Triggers"

## First Run Notes

**Initial Discovery**: The first discovery run will process the last 1000 items (takes ~2-5 minutes). Subsequent runs will be much faster.

**Storage Growth**: Expect ~2GB per year of data. Monitor with:
```bash
npx wrangler d1 execute hn-archiver --remote --command \
  "SELECT COUNT(*) as items, 
          (SELECT COUNT(*) FROM item_snapshots) as snapshots 
   FROM items"
```

## Troubleshooting

### Issue: Database not found

```bash
# List all databases
npx wrangler d1 list

# Recreate if needed
npx wrangler d1 create hn-archiver
npm run db:init:remote
```

### Issue: Permission denied

```bash
# Re-authenticate
wrangler logout
wrangler login
```

### Issue: Worker times out

This is normal for large initial runs. The worker will resume on the next cron trigger. Check progress:
```bash
curl https://hn-archiver.your-subdomain.workers.dev/stats
```

## Post-Deployment

### Set Up Monitoring

1. **Enable Analytics**: Go to Workers dashboard → Analytics
2. **Set Up Alerts**: Configure email alerts for errors in Cloudflare dashboard
3. **External Monitoring**: Use a service like UptimeRobot to ping `/health` every 5 minutes

### Optional: Custom Domain

1. Go to Workers & Pages → hn-archiver → Settings → Domains & Routes
2. Add custom domain (e.g., `hn-archive.yourdomain.com`)
3. Update DNS as instructed

### Query Examples

```bash
# Get total items
npx wrangler d1 execute hn-archiver --remote --command \
  "SELECT COUNT(*) FROM items"

# Get today's stats
npx wrangler d1 execute hn-archiver --remote --command \
  "SELECT 
     COUNT(*) as total,
     SUM(CASE WHEN type='story' THEN 1 ELSE 0 END) as stories,
     SUM(CASE WHEN type='comment' THEN 1 ELSE 0 END) as comments
   FROM items 
   WHERE first_seen_at > strftime('%s', 'now', '-1 day') * 1000"

# Get top stories by score
npx wrangler d1 execute hn-archiver --remote --command \
  "SELECT id, title, score, descendants 
   FROM items 
   WHERE type='story' 
   ORDER BY score DESC 
   LIMIT 10"
```

## Costs

**Free Tier Limits (should never exceed):**
- Workers: 100,000 requests/day (using ~11,200)
- D1 Reads: 5,000,000/day (using ~16,800)
- D1 Writes: 100,000/day (using ~5,600)
- D1 Storage: 5GB (using ~2GB/year)

**Estimated Costs**: $0/month on free tier for at least 2 years.

## Backup Strategy

D1 includes automatic backups via Time Travel (30-day retention).

To manually backup:
```bash
# Export all items
npx wrangler d1 export hn-archiver --output backup.sql

# Or export as JSON
npx wrangler d1 execute hn-archiver --remote --command \
  "SELECT * FROM items" --json > items_backup.json
```

## Updating the Worker

```bash
# Pull latest changes
git pull

# Install dependencies
npm install

# Deploy
npm run deploy
```

No database migrations needed unless schema changes.

## Need Help?

- Check logs: `npm run tail`
- View errors: `curl https://your-worker.workers.dev/stats`
- GitHub Issues: https://github.com/philippdubach/hn-archiver/issues
- Cloudflare Discord: https://discord.cloudflare.com/
