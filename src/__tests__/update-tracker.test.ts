/**
 * Update Tracker Worker Tests
 * Tests batch processing resilience and error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { WorkerEnv } from '../types';

// Mock external dependencies BEFORE importing the module under test
vi.mock('../hn-api', () => ({
  fetchUpdates: vi.fn(),
  fetchTopStories: vi.fn(),
  fetchItemsBatch: vi.fn(),
}));
vi.mock('../db', () => ({
  getRecentlyUpdatedItems: vi.fn(),
  updateState: vi.fn(),
  logError: vi.fn(),
  recordMetrics: vi.fn(),
  batchUpsertItems: vi.fn(),
  batchInsertSnapshots: vi.fn(),
}));

// Import after mocks
import { runUpdateTracker } from '../workers/update-tracker';
import * as hnApi from '../hn-api';
import * as db from '../db';

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
    VECTORIZE: undefined as unknown as WorkerEnv['VECTORIZE'],
    TRIGGER_SECRET: 'test-secret',
  };
}

describe('Update Tracker Worker', () => {
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

  describe('Stability: Batch Failure Handling', () => {
    it('logs errors and continues when batch fails', async () => {
      // Setup: Items to update
      const changedIds = [1, 2, 3];
      
      vi.mocked(hnApi.fetchUpdates).mockResolvedValue({ items: changedIds, profiles: [] });
      vi.mocked(hnApi.fetchTopStories).mockResolvedValue([1]);
      vi.mocked(db.getRecentlyUpdatedItems).mockResolvedValue(new Set());
      
      // Batch fails
      vi.mocked(hnApi.fetchItemsBatch).mockRejectedValue(new Error('Network timeout'));
      
      vi.mocked(db.updateState).mockResolvedValue();
      vi.mocked(db.recordMetrics).mockResolvedValue();
      vi.mocked(db.logError).mockResolvedValue();

      const result = await runUpdateTracker(env);
      
      // Should have logged the error
      expect(db.logError).toHaveBeenCalled();
      // Should complete without throwing
      expect(result).toHaveProperty('errors');
    });

    it('handles empty updates gracefully', async () => {
      vi.mocked(hnApi.fetchUpdates).mockResolvedValue({ items: [], profiles: [] });
      vi.mocked(db.updateState).mockResolvedValue();
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runUpdateTracker(env);
      
      expect(result.success).toBe(true);
      expect(result.items_processed).toBe(0);
    });

    it('filters recently updated items to avoid duplicate work', async () => {
      const changedIds = [1, 2, 3, 4, 5];
      vi.mocked(hnApi.fetchUpdates).mockResolvedValue({ items: changedIds, profiles: [] });
      vi.mocked(hnApi.fetchTopStories).mockResolvedValue([]);
      
      // Mark items 1, 2, 3 as recently updated - should be skipped
      vi.mocked(db.getRecentlyUpdatedItems).mockResolvedValue(new Set([1, 2, 3]));
      
      vi.mocked(hnApi.fetchItemsBatch).mockResolvedValue([
        { id: 4, type: 'story', title: 'Story 4', time: 1700000000 },
        { id: 5, type: 'story', title: 'Story 5', time: 1700000000 },
      ]);
      
      vi.mocked(db.batchUpsertItems).mockResolvedValue({ 
        processed: 2, 
        changed: 0, 
        snapshots: [] 
      });
      vi.mocked(db.updateState).mockResolvedValue();
      vi.mocked(db.recordMetrics).mockResolvedValue();

      const result = await runUpdateTracker(env);
      
      // Should only fetch items 4 and 5
      expect(hnApi.fetchItemsBatch).toHaveBeenCalledWith([4, 5]);
      expect(result.items_processed).toBe(2);
    });
  });

  describe('Front Page Detection', () => {
    it('enriches items with front page flag', async () => {
      vi.mocked(hnApi.fetchUpdates).mockResolvedValue({ items: [1, 2], profiles: [] });
      vi.mocked(hnApi.fetchTopStories).mockResolvedValue([1]); // Only item 1 is on front page
      vi.mocked(db.getRecentlyUpdatedItems).mockResolvedValue(new Set());
      
      vi.mocked(hnApi.fetchItemsBatch).mockResolvedValue([
        { id: 1, type: 'story', title: 'Front Page Story', time: 1700000000 },
        { id: 2, type: 'story', title: 'Regular Story', time: 1700000000 },
      ]);
      
      vi.mocked(db.batchUpsertItems).mockResolvedValue({ 
        processed: 2, 
        changed: 2, 
        snapshots: [] 
      });
      vi.mocked(db.updateState).mockResolvedValue();
      vi.mocked(db.recordMetrics).mockResolvedValue();

      await runUpdateTracker(env);
      
      // Verify batchUpsertItems was called with enriched items
      expect(db.batchUpsertItems).toHaveBeenCalled();
      const upsertCall = vi.mocked(db.batchUpsertItems).mock.calls[0];
      const enrichedItems = upsertCall[1];
      
      expect(enrichedItems).toContainEqual(expect.objectContaining({ id: 1, isFrontPage: true }));
      expect(enrichedItems).toContainEqual(expect.objectContaining({ id: 2, isFrontPage: false }));
    });
  });
});
