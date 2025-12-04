import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { EnrichedHNItem } from '../types';
import {
  batchUpsertItems,
  batchInsertSnapshots,
  getItems,
  incrementUsageCounter,
  checkUsageLimits,
  logError,
} from '../db';
import { BudgetLimits } from '../types';

let mf: Miniflare;
let db: D1Database;

async function loadSchema() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const schemaPath = resolve(__dirname, '../../schema.sql');
  return readFile(schemaPath, 'utf8');
}

async function applySchema(database: D1Database, schema: string) {
  const statements = schema
    .split(/;\s*\n/)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);

  for (const statement of statements) {
    const sql = statement.endsWith(';') ? statement : `${statement};`;
    await database.prepare(sql).run();
  }
}

describe('db layer', () => {
  beforeAll(async () => {
    mf = new Miniflare({
      script: 'export default { fetch() { return new Response("ok"); } };',
      modules: true,
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    const schema = await loadSchema();
    await applySchema(db, schema);
  });

  afterAll(async () => {
    await mf.dispose();
  });

  it('batchUpsertItems inserts and updates records', async () => {
    const now = Date.now();
    const items: EnrichedHNItem[] = [
      {
        id: 1,
        type: 'story',
        by: 'alice',
        time: Math.floor(now / 1000),
        score: 10,
        descendants: 0,
        title: 'First story',
        url: 'https://example.com',
        text: undefined,
        parent: undefined,
        kids: undefined,
        isFrontPage: true,
      },
    ];

    const result = await batchUpsertItems(db, items);
    expect(result.processed).toBe(1);
    expect(result.changed).toBe(1);

    const updatedResult = await batchUpsertItems(db, [
      {
        ...items[0],
        score: 40,
        isFrontPage: false,
      },
    ]);

    expect(updatedResult.snapshots.length).toBeGreaterThan(0);
    await batchInsertSnapshots(db, updatedResult.snapshots);

    const { items: stored } = await getItems(db, { limit: 10, offset: 0 });
    expect(stored[0]?.score).toBe(40);
  });

  it('enforces usage limits for Vectorize queries', async () => {
    const todayKey = `vectorize_queries_${new Date().toISOString().split('T')[0]}`;
    await incrementUsageCounter(db, todayKey, BudgetLimits.VECTORIZE_QUERIES_PER_DAY);

    const limit = await checkUsageLimits(db, 'vectorize_query');
    expect(limit.allowed).toBe(false);
  });

  it('logs errors into error_log', async () => {
    await logError(db, 'discovery', new Error('boom'), { context: 'test' });
    const row = await db
      .prepare('SELECT COUNT(*) as count FROM error_log')
      .first<{ count: number }>();
    expect(row?.count ?? 0).toBeGreaterThan(0);
  });
});
