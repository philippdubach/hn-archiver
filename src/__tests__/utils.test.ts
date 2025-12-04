import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  timingSafeEqual,
  shouldCreateSnapshot,
  retryWithBackoff,
  chunk,
  RateLimiter,
} from '../utils';
import type { DBItem, EnrichedHNItem } from '../types';

const baseItem: EnrichedHNItem = {
  id: 1,
  type: 'story',
  by: 'alice',
  time: 1_700_000_000,
  isFrontPage: false,
};

const existing: DBItem = {
  id: 1,
  type: 'story',
  by: 'alice',
  time: 1_700_000_000,
  score: 10,
  descendants: 5,
  deleted: false,
  dead: false,
  title: 'Example',
  url: 'https://example.com',
  text: undefined,
  parent: undefined,
  kids: null,
  first_seen_at: 1,
  last_updated_at: 1,
  last_changed_at: 1,
  update_count: 0,
};

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('secret', 'secret')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeEqual('secret', 'secRet')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(timingSafeEqual('secret', 'secret123')).toBe(false);
  });
});

describe('shouldCreateSnapshot', () => {
  it('snapshots new front-page items', () => {
    expect(
      shouldCreateSnapshot(null, { ...baseItem, isFrontPage: true }, 0, true)
    ).toBe(true);
  });

  it('snapshots on score spike', () => {
    expect(
      shouldCreateSnapshot(existing, { ...baseItem, score: 40 }, 2, true)
    ).toBe(true);
  });

  it('samples every fourth update when data changed', () => {
    expect(
      shouldCreateSnapshot(existing, { ...baseItem, score: 11 }, 4, true)
    ).toBe(true);
  });

  it('does not snapshot if nothing changed', () => {
    expect(
      shouldCreateSnapshot(existing, { ...baseItem, score: 10 }, 4, false)
    ).toBe(false);
  });
});

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries until success and honours backoff', async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve('ok');
    });

    const promise = retryWithBackoff(fn, 5, 10);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('chunk', () => {
  it('splits arrays into equal parts', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  it('throws on non-positive size', () => {
    expect(() => chunk([1, 2], 0)).toThrow('Chunk size must be positive');
  });
});

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for token refill when depleted', async () => {
    const limiter = new RateLimiter(1, 1); // 1 token per second

    await limiter.waitForToken();

    let resolved = false;
    const second = limiter.waitForToken().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(resolved).toBe(true);
  });
});
