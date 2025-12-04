import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import worker from '../worker';
import type { WorkerEnv, WorkerResult } from '../types';
import * as db from '../db';

vi.mock('../workers/discovery', () => ({
  runDiscovery: vi.fn(async () => successResult('discovery')),
}));
vi.mock('../workers/update-tracker', () => ({
  runUpdateTracker: vi.fn(async () => successResult('updates')),
}));
vi.mock('../workers/backfill', () => ({
  runBackfill: vi.fn(async () => successResult('backfill')),
}));

function successResult(workerType: string): WorkerResult {
  return {
    success: true,
    items_processed: 0,
    items_changed: 0,
    snapshots_created: 0,
    duration_ms: 1,
    errors: 0,
    error_messages: [`${workerType} ok`],
  };
}

const activeMfs: Miniflare[] = [];

function createVectorEnv(baseEnv: WorkerEnv, overrides: Partial<WorkerEnv['VECTORIZE']> = {}): WorkerEnv {
  const vectorStub = {
    query: vi.fn(),
    getByIds: vi.fn().mockResolvedValue([]),
    describe: vi.fn().mockResolvedValue({ dimensions: 768, vectorCount: 0 }),
    insert: vi.fn(),
    upsert: vi.fn(),
    deleteByIds: vi.fn(),
    ...overrides,
  } as unknown as WorkerEnv['VECTORIZE'];

  return {
    ...baseEnv,
    VECTORIZE: vectorStub,
  };
}

async function createEnv(): Promise<WorkerEnv> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const schema = await readFile(resolve(__dirname, '../../schema.sql'), 'utf8');

  const mf = new Miniflare({
    script: 'export default { fetch() { return new Response("ok"); } };',
    modules: true,
    d1Databases: ['DB'],
  });
  activeMfs.push(mf);
  const DB = await mf.getD1Database('DB');
  const statements = schema
    .split(/;\s*\n/)
    .map((stmt: string) => stmt.trim())
    .filter((stmt: string) => stmt.length > 0);
  for (const statement of statements) {
    const sql = statement.endsWith(';') ? statement : `${statement};`;
    await DB.prepare(sql).run();
  }

  return {
    DB,
    AI: {
      run: vi.fn(),
    },
    VECTORIZE: undefined as unknown as WorkerEnv['VECTORIZE'],
    TRIGGER_SECRET: 'top-secret',
  };
}

describe('worker fetch handler', () => {
  let env: WorkerEnv;

  beforeEach(async () => {
    env = await createEnv();
  });

  afterEach(async () => {
    await Promise.all(activeMfs.splice(0).map(mf => mf.dispose()));
  });

  it('returns health status', async () => {
    const response = await worker.fetch!(new Request('https://example.com/health'), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body).toHaveProperty('status');
  });

  it('rejects protected routes without auth', async () => {
    const response = await worker.fetch!(
      new Request('https://example.com/trigger/discovery'),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(401);
  });

  it('allows protected routes with valid secret', async () => {
    const request = new Request('https://example.com/trigger/discovery', {
      headers: { Authorization: 'Bearer top-secret' },
    });
    const response = await worker.fetch!(request, env, {} as ExecutionContext);
    expect(response.status).toBe(200);
  });

  it('serves items API with seeded data', async () => {
    await env.DB.prepare(
      `INSERT INTO items (id, type, deleted, dead, title, by, time, score, descendants, first_seen_at, last_updated_at, last_changed_at, update_count)
       VALUES (1, 'story', 0, 0, 'Hello', 'alice', 1700000000, 10, 0, 1, 1, 1, 0)`
    ).run();

    const response = await worker.fetch!(
      new Request('https://example.com/api/items'),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
  });

  // ==========================================
  // SECURITY TESTS - Fail-Closed, CORS, Rate Limiting
  // ==========================================

  describe('Security: Fail-Closed Authentication', () => {
    it('returns 503 when TRIGGER_SECRET is undefined (fail-closed)', async () => {
      // Create env without TRIGGER_SECRET - simulates misconfigured server
      const envNoSecret: WorkerEnv = {
        ...env,
        TRIGGER_SECRET: undefined as unknown as string,
      };

      const response = await worker.fetch!(
        new Request('https://example.com/trigger/discovery'),
        envNoSecret,
        {} as ExecutionContext
      );
      
      expect(response.status).toBe(503);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('Server configuration error');
      expect(body.message).toContain('Authentication not configured');
    });

    it('returns 503 for /api/similar when TRIGGER_SECRET is undefined', async () => {
      const envNoSecret: WorkerEnv = {
        ...env,
        TRIGGER_SECRET: undefined as unknown as string,
      };

      const response = await worker.fetch!(
        new Request('https://example.com/api/similar/123'),
        envNoSecret,
        {} as ExecutionContext
      );
      
      expect(response.status).toBe(503);
    });

    it('returns 503 for /api/compute-topic-similarity when TRIGGER_SECRET is undefined', async () => {
      const envNoSecret: WorkerEnv = {
        ...env,
        TRIGGER_SECRET: undefined as unknown as string,
      };

      const response = await worker.fetch!(
        new Request('https://example.com/api/compute-topic-similarity'),
        envNoSecret,
        {} as ExecutionContext
      );
      
      expect(response.status).toBe(503);
    });
  });

  describe('Security: CORS Policy', () => {
    it('rejects non-GET requests from unknown origins', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/api/items', {
          method: 'POST',
          headers: { 
            'Origin': 'https://malicious-site.com',
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
        env,
        {} as ExecutionContext
      );
      
      expect(response.status).toBe(403);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('CORS not allowed');
    });

    it('allows GET requests from unknown origins', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/health', {
          method: 'GET',
          headers: { 'Origin': 'https://any-site.com' },
        }),
        env,
        {} as ExecutionContext
      );
      
      expect(response.status).toBe(200);
    });

    it('allows POST requests from allowed origins', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/trigger/discovery', {
          method: 'POST',
          headers: { 
            'Origin': 'http://localhost:8787',
            'Authorization': 'Bearer top-secret',
          },
        }),
        env,
        {} as ExecutionContext
      );
      
      // Should pass CORS check, then fail/succeed based on other logic
      expect(response.status).not.toBe(403);
    });
  });

  describe('Security: Rate Limiting', () => {
    it('returns 429 after exceeding rate limit (100 requests)', async () => {
      // Make 100 requests (should all succeed)
      for (let i = 0; i < 100; i++) {
        const response = await worker.fetch!(
          new Request('https://example.com/health', {
            headers: { 'CF-Connecting-IP': '192.168.1.100' },
          }),
          env,
          {} as ExecutionContext
        );
        expect(response.status).toBe(200);
      }
      
      // 101st request should be rate limited
      const response = await worker.fetch!(
        new Request('https://example.com/health', {
          headers: { 'CF-Connecting-IP': '192.168.1.100' },
        }),
        env,
        {} as ExecutionContext
      );
      
      expect(response.status).toBe(429);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Rate limit exceeded');
      expect(response.headers.get('Retry-After')).toBe('60');
    });

    it('tracks rate limits per IP address', async () => {
      // Exhaust limit for IP1
      for (let i = 0; i < 100; i++) {
        await worker.fetch!(
          new Request('https://example.com/health', {
            headers: { 'CF-Connecting-IP': '10.0.0.1' },
          }),
          env,
          {} as ExecutionContext
        );
      }
      
      // IP1 should be rate limited
      const ip1Response = await worker.fetch!(
        new Request('https://example.com/health', {
          headers: { 'CF-Connecting-IP': '10.0.0.1' },
        }),
        env,
        {} as ExecutionContext
      );
      expect(ip1Response.status).toBe(429);
      
      // IP2 should still work
      const ip2Response = await worker.fetch!(
        new Request('https://example.com/health', {
          headers: { 'CF-Connecting-IP': '10.0.0.2' },
        }),
        env,
        {} as ExecutionContext
      );
      expect(ip2Response.status).toBe(200);
    });

    it('allows requests after rate limit window resets', async () => {
      vi.useFakeTimers();

      const ip = '172.16.0.1';
      for (let i = 0; i < 100; i++) {
        const response = await worker.fetch!(
          new Request('https://example.com/health', {
            headers: { 'CF-Connecting-IP': ip },
          }),
          env,
          {} as ExecutionContext
        );
        expect(response.status).toBe(200);
      }

      const limited = await worker.fetch!(
        new Request('https://example.com/health', {
          headers: { 'CF-Connecting-IP': ip },
        }),
        env,
        {} as ExecutionContext
      );
      expect(limited.status).toBe(429);

      // Advance time past the reset window (60s)
      vi.advanceTimersByTime(60_001);

      const afterWindow = await worker.fetch!(
        new Request('https://example.com/health', {
          headers: { 'CF-Connecting-IP': ip },
        }),
        env,
        {} as ExecutionContext
      );
      expect(afterWindow.status).toBe(200);

      vi.useRealTimers();
    });

    it('allows requests when IP header is missing', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/health'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(200);
    });
  });

  // ==========================================
  // INPUT VALIDATION TESTS
  // ==========================================

  describe('Input Validation: Item IDs', () => {
    it('rejects negative item IDs', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/api/item/-5'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Invalid item ID');
    });

    it('rejects item IDs exceeding MAX_REASONABLE_ID', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/api/item/999999999999'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Invalid item ID');
    });

    it('rejects non-numeric item IDs', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/api/item/abc'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(400);
    });
  });

  // ==========================================
  // PROTECTED VECTORIZE & AI ENDPOINTS
  // ==========================================

  describe('Security: Protected Similarity & Topic Endpoints', () => {
    it('requires auth for /api/similar when secret configured', async () => {
      const vectorEnv = createVectorEnv(env);
      const response = await worker.fetch!(
        new Request('https://example.com/api/similar/123'),
        vectorEnv,
        {} as ExecutionContext
      );
      expect(response.status).toBe(401);
    });

    it('returns 503 when Vectorize binding is missing', async () => {
      const request = new Request('https://example.com/api/similar/123', {
        headers: { Authorization: 'Bearer top-secret' },
      });
      const response = await worker.fetch!(request, env, {} as ExecutionContext);
      expect(response.status).toBe(503);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Similarity search not available');
    });

    it('returns 429 when vectorize budget limit is exceeded', async () => {
      const limitSpy = vi.spyOn(db, 'checkUsageLimits').mockResolvedValue({
        allowed: false,
        reason: 'Vectorize daily limit reached',
      });

      const vectorEnv = createVectorEnv(env);
      const request = new Request('https://example.com/api/similar/123', {
        headers: { Authorization: 'Bearer top-secret' },
      });
      const response = await worker.fetch!(request, vectorEnv, {} as ExecutionContext);

      expect(response.status).toBe(429);
      const payload = await response.json() as { message: string };
      expect(payload.message).toContain('Vectorize');

      limitSpy.mockRestore();
    });

    it('requires auth for /api/compute-topic-similarity', async () => {
      const vectorEnv = createVectorEnv(env);
      const response = await worker.fetch!(
        new Request('https://example.com/api/compute-topic-similarity'),
        vectorEnv,
        {} as ExecutionContext
      );
      expect(response.status).toBe(401);
    });

    it('returns 429 when topic similarity hits vectorize limit', async () => {
      const vectorEnv = createVectorEnv(env, {
        getByIds: vi.fn().mockResolvedValue([]),
      });

      const limitSpy = vi.spyOn(db, 'checkUsageLimits').mockResolvedValue({
        allowed: false,
        reason: 'Daily vectorize limit reached',
      });

      const request = new Request('https://example.com/api/compute-topic-similarity', {
        headers: { Authorization: 'Bearer top-secret' },
      });
      const response = await worker.fetch!(request, vectorEnv, {} as ExecutionContext);

      expect(response.status).toBe(429);
      const payload = await response.json() as { message: string };
      expect(payload.message).toContain('Daily vectorize limit');

      limitSpy.mockRestore();
    });
  });

  // ==========================================
  // ANALYTICS & USAGE ENDPOINTS
  // ==========================================

  describe('Analytics endpoints', () => {
    it('serves /api/analytics with cached stats', async () => {
      const spies = [
        vi.spyOn(db, 'getTypeDistribution').mockResolvedValue([{ type: 'story', count: 10 }]),
        vi.spyOn(db, 'getSnapshotReasons').mockResolvedValue([{ reason: 'score_spike', count: 3 }]),
        vi.spyOn(db, 'getTopItems').mockResolvedValue([{ id: 1 } as any]),
      ];

      const response = await worker.fetch!(
        new Request('https://example.com/api/analytics'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(200);

      spies.forEach((spy) => spy.mockRestore());
    });

    it('serves /api/advanced-analytics with extended data', async () => {
      const spies = [
        vi.spyOn(db, 'getDetailedStats').mockResolvedValue({ total_items: 1 } as any),
        vi.spyOn(db, 'getTopAuthors').mockResolvedValue([]),
        vi.spyOn(db, 'getSuccessfulAuthors').mockResolvedValue([]),
        vi.spyOn(db, 'getPostsByHour').mockResolvedValue([]),
        vi.spyOn(db, 'getPostsByDayOfWeek').mockResolvedValue([]),
        vi.spyOn(db, 'getPostsByDate').mockResolvedValue([]),
        vi.spyOn(db, 'getViralPosts').mockResolvedValue([]),
        vi.spyOn(db, 'getTopDomains').mockResolvedValue([]),
      ];

      const response = await worker.fetch!(
        new Request('https://example.com/api/advanced-analytics'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(200);

      spies.forEach((spy) => spy.mockRestore());
    });

    it('serves /api/ai-analytics', async () => {
      const spy = vi.spyOn(db, 'getAIAnalysisStats').mockResolvedValue({ analyzed: 0 } as any);

      const response = await worker.fetch!(
        new Request('https://example.com/api/ai-analytics'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(200);

      spy.mockRestore();
    });

    it('serves /api/ai-analytics-extended with sentiment and topic data', async () => {
      const spies = [
        vi.spyOn(db, 'getAIAnalysisStats').mockResolvedValue({ analyzed: 0 } as any),
        vi.spyOn(db, 'getTopicPerformance').mockResolvedValue([]),
        vi.spyOn(db, 'getContentTypePerformance').mockResolvedValue([]),
        vi.spyOn(db, 'getSentimentDistribution').mockResolvedValue([]),
        vi.spyOn(db, 'getSentimentByTopic').mockResolvedValue([]),
        vi.spyOn(db, 'getTopPostsBySentiment').mockResolvedValue({ most_positive: [], most_negative: [] }),
      ];

      const response = await worker.fetch!(
        new Request('https://example.com/api/ai-analytics-extended'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(200);

      spies.forEach((spy) => spy.mockRestore());
    });

    it('serves /api/embedding-analytics and returns vectorize info when available', async () => {
      const vectorEnv = createVectorEnv(env, {
        describe: vi.fn().mockResolvedValue({ dimensions: 768, vectorCount: 10 }),
      });

      const spies = [
        vi.spyOn(db, 'getEmbeddingCoverage').mockResolvedValue({ total: 0 } as any),
        vi.spyOn(db, 'getTopicClusterStats').mockResolvedValue([]),
        vi.spyOn(db, 'getCachedAnalytics').mockResolvedValue(null),
      ];

      const response = await worker.fetch!(
        new Request('https://example.com/api/embedding-analytics'),
        vectorEnv,
        {} as ExecutionContext
      );
      expect(response.status).toBe(200);

      spies.forEach((spy) => spy.mockRestore());
    });

    it('serves /api/usage with usage stats and vectorize description', async () => {
      const vectorEnv = createVectorEnv(env, {
        describe: vi.fn().mockResolvedValue({ dimensions: 768, vectorCount: 20 }),
      });

      const spy = vi.spyOn(db, 'getUsageStats').mockResolvedValue({
        vectorize_queries_today: 0,
        vectorize_queries_month: 0,
        embeddings_stored: 0,
        d1_reads_today: 0,
      } as any);

      const response = await worker.fetch!(
        new Request('https://example.com/api/usage'),
        vectorEnv,
        {} as ExecutionContext
      );
      expect(response.status).toBe(200);

      spy.mockRestore();
    });
  });

  // ==========================================
  // TRIGGER ENDPOINTS
  // ==========================================

  describe('Trigger endpoints', () => {
    it('requires authorization for /trigger/backfill', async () => {
      const response = await worker.fetch!(
        new Request('https://example.com/trigger/backfill'),
        env,
        {} as ExecutionContext
      );
      expect(response.status).toBe(401);
    });

    it('invokes backfill worker when authorized', async () => {
      const request = new Request('https://example.com/trigger/backfill', {
        headers: { Authorization: 'Bearer top-secret' },
      });
      const response = await worker.fetch!(request, env, {} as ExecutionContext);
      expect(response.status).toBe(200);
    });

    it('returns 500 when AI binding is missing for /trigger/ai-backfill', async () => {
      const envNoAI: WorkerEnv = {
        ...env,
        AI: undefined as unknown as WorkerEnv['AI'],
      };

      const request = new Request('https://example.com/trigger/ai-backfill', {
        headers: { Authorization: 'Bearer top-secret' },
      });
      const response = await worker.fetch!(request, envNoAI, {} as ExecutionContext);
      expect(response.status).toBe(500);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('AI binding not configured');
    });
  });
});
