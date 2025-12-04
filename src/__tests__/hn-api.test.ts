import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchMaxItemId,
  fetchItem,
  fetchItemsBatch,
  fetchTopStories,
  fetchUpdates,
} from '../hn-api';
import { RateLimiter } from '../utils';

// Prevent actual rate limiting delays
vi.spyOn(RateLimiter.prototype, 'waitForToken').mockResolvedValue(undefined);

const originalFetch = globalThis.fetch;

describe('HN API client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('fetchMaxItemId returns valid id', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('12345', { status: 200 })
    );

    const id = await fetchMaxItemId();
    expect(id).toBe(12345);
  });

  it('fetchItem returns null on 404', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(null, { status: 404 })
    );

    const item = await fetchItem(42);
    expect(item).toBeNull();
  });

  it('fetchItemsBatch filters out invalid entries', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, type: 'story', time: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ bad: true }), { status: 200 }));

    const items = await fetchItemsBatch([1, 2]);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(1);
  });

  it('fetchTopStories returns list of ids', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([1, 2, 3]), { status: 200 })
    );

    const ids = await fetchTopStories();
    expect(ids).toEqual([1, 2, 3]);
  });

  it('fetchUpdates validates payload', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [1, 2], profiles: ['a'] }), { status: 200 })
    );

    const updates = await fetchUpdates();
    expect(updates.items).toEqual([1, 2]);
  });
});
