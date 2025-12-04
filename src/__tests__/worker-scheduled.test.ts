/**
 * Worker Scheduled Event Handler Tests
 * Tests cron dispatcher routing and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WorkerEnv, WorkerResult } from '../types';

// Mock all worker modules and db BEFORE importing worker
vi.mock('../workers/discovery', () => ({
  runDiscovery: vi.fn(),
}));
vi.mock('../workers/update-tracker', () => ({
  runUpdateTracker: vi.fn(),
}));
vi.mock('../workers/backfill', () => ({
  runBackfill: vi.fn(),
}));
vi.mock('../db', () => ({
  cleanupOldErrors: vi.fn().mockResolvedValue(0),
  cleanupOldMetrics: vi.fn().mockResolvedValue(0),
  getArchiveStats: vi.fn().mockResolvedValue({
    total_items: 100,
    stories: 50,
    comments: 50,
    jobs: 0,
    polls: 0,
    pollopts: 0,
    total_snapshots: 10,
    max_item_id: 100,
    last_discovery: Date.now(),
    last_update_check: Date.now(),
    last_backfill: Date.now(),
  }),
}));

// Import worker AFTER mocks are set up
import worker from '../worker';
import { runDiscovery } from '../workers/discovery';
import { runUpdateTracker } from '../workers/update-tracker';
import { runBackfill } from '../workers/backfill';
import { cleanupOldErrors, cleanupOldMetrics } from '../db';

function successResult(): WorkerResult {
  return {
    success: true,
    items_processed: 10,
    items_changed: 5,
    snapshots_created: 2,
    duration_ms: 100,
    errors: 0,
  };
}

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

describe('Worker Scheduled Event Handler', () => {
  let env: WorkerEnv;

  beforeEach(async () => {
    env = createMockEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // ==========================================
  // CRON DISPATCHER TESTS
  // ==========================================

  describe('Cron Dispatcher Routing', () => {
    it('routes */3 cron to discovery worker', async () => {
      vi.mocked(runDiscovery).mockResolvedValue(successResult());
      
      const event = { cron: '*/3 * * * *', scheduledTime: Date.now() } as ScheduledEvent;
      await worker.scheduled!(event, env, {} as ExecutionContext);
      
      expect(runDiscovery).toHaveBeenCalledTimes(1);
      expect(runDiscovery).toHaveBeenCalledWith(env);
      expect(runUpdateTracker).not.toHaveBeenCalled();
      expect(runBackfill).not.toHaveBeenCalled();
    });

    it('routes */10 cron to update-tracker worker', async () => {
      vi.mocked(runUpdateTracker).mockResolvedValue(successResult());
      
      const event = { cron: '*/10 * * * *', scheduledTime: Date.now() } as ScheduledEvent;
      await worker.scheduled!(event, env, {} as ExecutionContext);
      
      expect(runUpdateTracker).toHaveBeenCalledTimes(1);
      expect(runUpdateTracker).toHaveBeenCalledWith(env);
      expect(runDiscovery).not.toHaveBeenCalled();
      expect(runBackfill).not.toHaveBeenCalled();
    });

    it('routes 0 */2 cron to backfill worker', async () => {
      vi.mocked(runBackfill).mockResolvedValue(successResult());
      
      const event = { cron: '0 */2 * * *', scheduledTime: Date.now() } as ScheduledEvent;
      await worker.scheduled!(event, env, {} as ExecutionContext);
      
      expect(runBackfill).toHaveBeenCalledTimes(1);
      expect(runBackfill).toHaveBeenCalledWith(env);
      expect(runDiscovery).not.toHaveBeenCalled();
      expect(runUpdateTracker).not.toHaveBeenCalled();
      expect(cleanupOldErrors).toHaveBeenCalledWith(env.DB);
      expect(cleanupOldMetrics).toHaveBeenCalledWith(env.DB);
    });

    it('logs warning for unknown cron schedule', async () => {
      const warnSpy = vi.spyOn(console, 'warn');
      
      const event = { cron: '0 0 * * *', scheduledTime: Date.now() } as ScheduledEvent;
      await worker.scheduled!(event, env, {} as ExecutionContext);
      
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown cron schedule'));
      expect(runDiscovery).not.toHaveBeenCalled();
      expect(runUpdateTracker).not.toHaveBeenCalled();
      expect(runBackfill).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // ERROR HANDLING - STABILITY TESTS
  // ==========================================

  describe('Stability: Worker Error Handling', () => {
    it('does not throw when discovery worker fails', async () => {
      vi.mocked(runDiscovery).mockRejectedValue(new Error('Network timeout'));
      
      const event = { cron: '*/3 * * * *', scheduledTime: Date.now() } as ScheduledEvent;
      
      // Should not throw - scheduled handler must be resilient
      await expect(worker.scheduled!(event, env, {} as ExecutionContext)).resolves.not.toThrow();
    });

    it('does not throw when update-tracker worker fails', async () => {
      vi.mocked(runUpdateTracker).mockRejectedValue(new Error('Database error'));
      
      const event = { cron: '*/10 * * * *', scheduledTime: Date.now() } as ScheduledEvent;
      
      await expect(worker.scheduled!(event, env, {} as ExecutionContext)).resolves.not.toThrow();
    });

    it('does not throw when backfill worker fails', async () => {
      vi.mocked(runBackfill).mockRejectedValue(new Error('AI service unavailable'));
      
      const event = { cron: '0 */2 * * *', scheduledTime: Date.now() } as ScheduledEvent;
      
      await expect(worker.scheduled!(event, env, {} as ExecutionContext)).resolves.not.toThrow();
    });

    it('logs errors when worker fails', async () => {
      const errorSpy = vi.spyOn(console, 'error');
      vi.mocked(runDiscovery).mockRejectedValue(new Error('Test failure'));
      
      const event = { cron: '*/3 * * * *', scheduledTime: Date.now() } as ScheduledEvent;
      await worker.scheduled!(event, env, {} as ExecutionContext);
      
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Scheduled event failed'),
        expect.any(Error)
      );
    });
  });
});
