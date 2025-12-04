/**
 * Backfill Worker Tests
 * Tests stale item refresh, AI analysis, and embedding backfill
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { WorkerEnv } from '../types';

// Mock external dependencies BEFORE importing the module under test
vi.mock('../hn-api', () => ({
  fetchItemsBatch: vi.fn(),
}));
vi.mock('../db', () => ({
  getStaleItems: vi.fn(),
  batchUpsertItems: vi.fn(),
  batchInsertSnapshots: vi.fn(),
  updateState: vi.fn(),
  logError: vi.fn(),
  recordMetrics: vi.fn(),
  getItemsNeedingAIAnalysis: vi.fn(),
  batchUpdateItemsAI: vi.fn(),
}));
vi.mock('../ai-analysis', () => ({
  batchAnalyzeStories: vi.fn(),
}));
vi.mock('../workers/embedding-backfill', () => ({
  runEmbeddingBackfill: vi.fn(),
}));

// Import after mocks
import { runBackfill } from '../workers/backfill';
import * as hnApi from '../hn-api';
import * as db from '../db';
import * as aiAnalysis from '../ai-analysis';
import * as embeddingBackfill from '../workers/embedding-backfill';

const activeMfs: Miniflare[] = [];

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
    AI: { run: vi.fn() },
    VECTORIZE: { 
      upsert: vi.fn(),
      query: vi.fn(),
      getByIds: vi.fn(),
      describe: vi.fn(),
      deleteByIds: vi.fn(),
      insert: vi.fn(),
    } as unknown as WorkerEnv['VECTORIZE'],
    TRIGGER_SECRET: 'test-secret',
  };
}

describe('Backfill Worker', () => {
  let env: WorkerEnv;

  beforeEach(async () => {
    env = await createEnv();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(activeMfs.splice(0).map(mf => mf.dispose()));
    vi.restoreAllMocks();
  });

  describe('Stability: Component Isolation', () => {
    it('continues with AI analysis even when stale item fetch fails', async () => {
      // Stale items fetch fails
      vi.mocked(db.getStaleItems).mockResolvedValue([1, 2, 3]);
      vi.mocked(hnApi.fetchItemsBatch).mockRejectedValue(new Error('API timeout'));
      vi.mocked(db.logError).mockResolvedValue();
      vi.mocked(db.updateState).mockResolvedValue();
      
      // AI analysis should still run
      vi.mocked(db.getItemsNeedingAIAnalysis).mockResolvedValue([
        { id: 10, type: 'story', title: 'Test Story', url: null },
      ]);
      vi.mocked(aiAnalysis.batchAnalyzeStories).mockResolvedValue(new Map([
        [10, { topic: 'tech', contentType: 'article', sentiment: 0.8, analyzedAt: Date.now() }],
      ]));
      vi.mocked(db.batchUpdateItemsAI).mockResolvedValue(1);
      
      // Embedding backfill
      vi.mocked(embeddingBackfill.runEmbeddingBackfill).mockResolvedValue({
        success: true,
        items_processed: 1,
        items_changed: 1,
        snapshots_created: 0,
        duration_ms: 50,
        errors: 0,
      });
      
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runBackfill(env);
      
      // Should have errors from stale item fetch
      expect(result.errors).toBeGreaterThan(0);
      // But AI analysis should have been attempted
      expect(db.getItemsNeedingAIAnalysis).toHaveBeenCalled();
      expect(aiAnalysis.batchAnalyzeStories).toHaveBeenCalled();
    });

    it('continues with embedding backfill even when AI analysis fails', async () => {
      // No stale items
      vi.mocked(db.getStaleItems).mockResolvedValue([]);
      vi.mocked(db.updateState).mockResolvedValue();
      
      // AI analysis fails
      vi.mocked(db.getItemsNeedingAIAnalysis).mockResolvedValue([
        { id: 10, type: 'story', title: 'Test Story', url: null },
      ]);
      vi.mocked(aiAnalysis.batchAnalyzeStories).mockRejectedValue(
        new Error('AI service unavailable')
      );
      vi.mocked(db.logError).mockResolvedValue();
      
      // Embedding backfill should still run
      vi.mocked(embeddingBackfill.runEmbeddingBackfill).mockResolvedValue({
        success: true,
        items_processed: 5,
        items_changed: 5,
        snapshots_created: 0,
        duration_ms: 100,
        errors: 0,
      });
      
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runBackfill(env);
      
      // Should have errors from AI analysis
      expect(result.errors).toBeGreaterThan(0);
      // But embedding backfill should have been attempted
      expect(embeddingBackfill.runEmbeddingBackfill).toHaveBeenCalled();
    });

    it('handles all components failing gracefully', async () => {
      // All components fail
      vi.mocked(db.getStaleItems).mockResolvedValue([1]);
      vi.mocked(hnApi.fetchItemsBatch).mockRejectedValue(new Error('Network error'));
      vi.mocked(db.updateState).mockResolvedValue();
      vi.mocked(db.logError).mockResolvedValue();
      
      vi.mocked(db.getItemsNeedingAIAnalysis).mockResolvedValue([{ id: 1, type: 'story', title: 'Test', url: null }]);
      vi.mocked(aiAnalysis.batchAnalyzeStories).mockRejectedValue(new Error('AI error'));
      
      vi.mocked(embeddingBackfill.runEmbeddingBackfill).mockRejectedValue(
        new Error('Vectorize error')
      );
      
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runBackfill(env);
      
      // Should not throw, but report failures
      expect(result.success).toBe(false);
      expect(result.errors).toBeGreaterThanOrEqual(3); // Three components failed
    });
  });

  describe('Performance: Snapshot Filtering', () => {
    it('only creates score_spike snapshots during backfill (not sample)', async () => {
      vi.mocked(db.getStaleItems).mockResolvedValue([1, 2]);
      vi.mocked(hnApi.fetchItemsBatch).mockResolvedValue([
        { id: 1, type: 'story', title: 'Story 1', time: 1700000000, score: 100 },
        { id: 2, type: 'story', title: 'Story 2', time: 1700000000, score: 50 },
      ]);
      
      // Return mixed snapshot reasons
      vi.mocked(db.batchUpsertItems).mockResolvedValue({ 
        processed: 2, 
        changed: 2, 
        snapshots: [
          { id: 1, score: 100, descendants: 5, reason: 'score_spike' as const },
          { id: 2, score: 50, descendants: 2, reason: 'sample' as const },
        ]
      });
      vi.mocked(db.batchInsertSnapshots).mockResolvedValue();
      vi.mocked(db.updateState).mockResolvedValue();
      vi.mocked(db.getItemsNeedingAIAnalysis).mockResolvedValue([]);
      vi.mocked(embeddingBackfill.runEmbeddingBackfill).mockResolvedValue({
        success: true, items_processed: 0, items_changed: 0, snapshots_created: 0, duration_ms: 10, errors: 0
      });
      vi.mocked(db.recordMetrics).mockResolvedValue();

      await runBackfill(env);
      
      // Should have called batchInsertSnapshots
      expect(db.batchInsertSnapshots).toHaveBeenCalled();
      
      // Check the snapshots passed to batchInsertSnapshots only include score_spike
      const insertCall = vi.mocked(db.batchInsertSnapshots).mock.calls[0];
      const insertedSnapshots = insertCall[1];
      expect(insertedSnapshots).toHaveLength(1);
      expect(insertedSnapshots[0].reason).toBe('score_spike');
    });
  });
});
