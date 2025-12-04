import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMaxItemId, fetchTopStories, fetchItemsBatch } from '../hn-api';
import {
  getState,
  updateState,
  logError,
  recordMetrics,
  batchUpsertItems,
  batchInsertSnapshots,
  batchUpdateItemsAI,
} from '../db';
import { runDiscovery } from '../workers/discovery';
import type { WorkerEnv } from '../types';

vi.mock('../hn-api', () => ({
  fetchMaxItemId: vi.fn(),
  fetchTopStories: vi.fn(),
  fetchItemsBatch: vi.fn(),
}));

vi.mock('../db', () => ({
  getState: vi.fn(),
  updateState: vi.fn(),
  logError: vi.fn(),
  recordMetrics: vi.fn(),
  batchUpsertItems: vi.fn(),
  batchInsertSnapshots: vi.fn(),
  batchUpdateItemsAI: vi.fn(),
}));

const mockFetchMaxItemId = vi.mocked(fetchMaxItemId);
const mockFetchTopStories = vi.mocked(fetchTopStories);
const mockFetchItemsBatch = vi.mocked(fetchItemsBatch);
const mockGetState = vi.mocked(getState);
const mockUpdateState = vi.mocked(updateState);
const mockLogError = vi.mocked(logError);
const mockRecordMetrics = vi.mocked(recordMetrics);
const mockBatchUpsert = vi.mocked(batchUpsertItems);
const mockBatchInsertSnapshots = vi.mocked(batchInsertSnapshots);
const mockBatchUpdateAI = vi.mocked(batchUpdateItemsAI);

describe('runDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not advance max_item_id_seen when batch fails', async () => {
    mockFetchMaxItemId.mockResolvedValue(110);
    mockGetState.mockResolvedValue(100);
    mockFetchTopStories.mockResolvedValue([]);
    mockFetchItemsBatch.mockRejectedValue(new Error('boom'));

    mockUpdateState.mockResolvedValue();
    mockLogError.mockResolvedValue();
    mockRecordMetrics.mockResolvedValue();
    mockBatchUpsert.mockResolvedValue({ processed: 0, changed: 0, snapshots: [] });
    mockBatchInsertSnapshots.mockResolvedValue();
    mockBatchUpdateAI.mockResolvedValue(0);

    const env = {
      DB: {} as unknown as D1Database,
      AI: undefined as unknown as WorkerEnv['AI'],
      VECTORIZE: undefined as unknown as WorkerEnv['VECTORIZE'],
    } as WorkerEnv;

    const result = await runDiscovery(env);

    expect(result.success).toBe(false);

    const maxSeenCalls = mockUpdateState.mock.calls.filter(
      ([, key]) => key === 'max_item_id_seen'
    );
    expect(maxSeenCalls.length).toBe(0);

    const lastRunCalls = mockUpdateState.mock.calls.filter(
      ([, key]) => key === 'last_discovery_run'
    );
    expect(lastRunCalls.length).toBe(1);

    expect(mockLogError).toHaveBeenCalledWith(
      expect.anything(),
      'discovery',
      expect.any(Error),
      expect.objectContaining({
        failedIdRange: expect.objectContaining({ min: 101, max: 110 }),
      })
    );
  });
});
