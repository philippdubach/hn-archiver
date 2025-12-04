/**
 * Embedding Backfill Worker Tests
 * Tests budget enforcement and batch processing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { WorkerEnv } from '../types';
import { BudgetLimits } from '../types';

// Mock external dependencies BEFORE importing the module under test
vi.mock('../db', () => ({
  checkUsageLimits: vi.fn(),
  getStoriesNeedingEmbeddings: vi.fn(),
  markEmbeddingsGenerated: vi.fn(),
  incrementUsageCounter: vi.fn(),
  recordMetrics: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../ai-analysis', () => ({
  batchGenerateEmbeddings: vi.fn(),
}));

// Import after mocks
import { runEmbeddingBackfill } from '../workers/embedding-backfill';
import * as db from '../db';
import * as aiAnalysis from '../ai-analysis';

function createMockEnv(): WorkerEnv {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
      batch: vi.fn().mockResolvedValue([]),
      dump: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database,
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

describe('Embedding Backfill Worker', () => {
  let env: WorkerEnv;

  beforeEach(async () => {
    env = createMockEnv();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // ==========================================
  // PERFORMANCE: BUDGET ENFORCEMENT TESTS
  // ==========================================

  describe('Performance: Budget Limits', () => {
    it('skips embedding generation when budget limit is reached', async () => {
      // Budget check returns not allowed
      vi.mocked(db.checkUsageLimits).mockResolvedValue({
        allowed: false,
        reason: 'Embedding storage limit reached (10000/10000)',
      });
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runEmbeddingBackfill(env);
      
      expect(result.success).toBe(true);
      expect(result.items_processed).toBe(0);
      expect(result.items_changed).toBe(0);
      expect(result.error_messages).toContain('Embedding storage limit reached (10000/10000)');
      
      // Should NOT call any embedding generation functions
      expect(db.getStoriesNeedingEmbeddings).not.toHaveBeenCalled();
      expect(aiAnalysis.batchGenerateEmbeddings).not.toHaveBeenCalled();
    });

    it('respects EMBEDDING_BATCH_SIZE limit when fetching stories', async () => {
      vi.mocked(db.checkUsageLimits).mockResolvedValue({ allowed: true, reason: undefined });
      vi.mocked(db.getStoriesNeedingEmbeddings).mockResolvedValue([]);
      vi.mocked(db.recordMetrics).mockResolvedValue();

      await runEmbeddingBackfill(env);
      
      // Should request stories with the correct batch size limit
      expect(db.getStoriesNeedingEmbeddings).toHaveBeenCalledWith(
        env.DB,
        BudgetLimits.EMBEDDING_BATCH_SIZE
      );
    });

    it('tracks usage counters after successful embedding generation', async () => {
      vi.mocked(db.checkUsageLimits).mockResolvedValue({ allowed: true, reason: undefined });
      vi.mocked(db.getStoriesNeedingEmbeddings).mockResolvedValue([
        { id: 1, title: 'Test Story', ai_topic: 'tech', score: 10 },
        { id: 2, title: 'Another Story', ai_topic: 'science', score: 20 },
      ]);
      vi.mocked(aiAnalysis.batchGenerateEmbeddings).mockResolvedValue({
        success: 2,
        failed: 0,
      });
      vi.mocked(db.markEmbeddingsGenerated).mockResolvedValue();
      vi.mocked(db.incrementUsageCounter).mockResolvedValue(1);
      vi.mocked(db.recordMetrics).mockResolvedValue();

      await runEmbeddingBackfill(env);
      
      // Should increment usage counter with the number of successful embeddings
      expect(db.incrementUsageCounter).toHaveBeenCalledWith(
        env.DB,
        'embeddings_stored_total',
        2
      );
    });
  });

  // ==========================================
  // STABILITY: ERROR HANDLING TESTS
  // ==========================================

  describe('Stability: Error Handling', () => {
    it('handles embedding generation errors gracefully', async () => {
      vi.mocked(db.checkUsageLimits).mockResolvedValue({ allowed: true, reason: undefined });
      vi.mocked(db.getStoriesNeedingEmbeddings).mockResolvedValue([
        { id: 1, title: 'Test Story', ai_topic: 'tech', score: 10 },
      ]);
      vi.mocked(aiAnalysis.batchGenerateEmbeddings).mockRejectedValue(
        new Error('AI model timeout')
      );
      vi.mocked(db.logError).mockResolvedValue();
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runEmbeddingBackfill(env);
      
      expect(result.success).toBe(false);
      expect(result.errors).toBeGreaterThan(0);
      expect(db.logError).toHaveBeenCalled();
    });

    it('returns early when no stories need embeddings', async () => {
      vi.mocked(db.checkUsageLimits).mockResolvedValue({ allowed: true, reason: undefined });
      vi.mocked(db.getStoriesNeedingEmbeddings).mockResolvedValue([]);
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runEmbeddingBackfill(env);
      
      expect(result.success).toBe(true);
      expect(result.items_processed).toBe(0);
      // Should not try to generate embeddings
      expect(aiAnalysis.batchGenerateEmbeddings).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // BUDGET CONSTANTS VALIDATION
  // ==========================================

  describe('Budget Constants', () => {
    it('has expected budget limit values', () => {
      // Validate the budget constants match documented values
      expect(BudgetLimits.VECTORIZE_QUERIES_PER_DAY).toBe(1500);
      expect(BudgetLimits.VECTORIZE_MAX_STORED_VECTORS).toBe(10000);
      expect(BudgetLimits.EMBEDDING_BATCH_SIZE).toBe(50);
    });
  });
});
