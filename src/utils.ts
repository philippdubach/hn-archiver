/**
 * Utility functions for HackerNews Archiver
 * Reusable helpers for batching, comparison, validation, and timing
 */

import type { DBItem, EnrichedHNItem } from './types';
import { Config } from './types';

/**
 * Split an array into chunks of specified size
 * Used for batch processing to stay within Worker limits
 */
export function chunk<T>(array: T[], size: number): T[][] {
  if (size <= 0) throw new Error('Chunk size must be positive');
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Sleep for specified milliseconds
 * Useful for rate limiting and retry backoff
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if a snapshot should be created based on multiple strategies:
 * 1. Significant score increase (>20 points)
 * 2. Sampling every 4th update
 * 3. Front page items always get snapshots
 */
export function shouldCreateSnapshot(
  oldItem: DBItem | null,
  newItem: EnrichedHNItem,
  updateCount: number,
  changed: boolean
): boolean {
  // Always snapshot new items on front page
  if (!oldItem && newItem.isFrontPage) {
    return true;
  }
  
  // No snapshot if data didn't change
  if (!changed) {
    return false;
  }
  
  // Strategy 1: Significant score spike
  if (oldItem && newItem.score && oldItem.score) {
    const scoreIncrease = newItem.score - oldItem.score;
    if (scoreIncrease >= Config.SNAPSHOT_SCORE_THRESHOLD) {
      return true;
    }
  }
  
  // Strategy 2: Sample every Nth update
  if (updateCount > 0 && updateCount % Config.SNAPSHOT_SAMPLE_FREQUENCY === 0) {
    return true;
  }
  
  // Strategy 3: Front page items
  if (newItem.isFrontPage) {
    return true;
  }
  
  return false;
}

/**
 * Determine the reason for creating a snapshot
 * Used for analytics and optimization
 */
export function getSnapshotReason(
  oldItem: DBItem | null,
  newItem: EnrichedHNItem,
  _updateCount: number
): 'score_spike' | 'front_page' | 'sample' | 'new_item' {
  if (!oldItem) {
    return 'new_item';
  }
  
  if (newItem.isFrontPage) {
    return 'front_page';
  }
  
  if (oldItem && newItem.score && oldItem.score) {
    const scoreIncrease = newItem.score - oldItem.score;
    if (scoreIncrease >= Config.SNAPSHOT_SCORE_THRESHOLD) {
      return 'score_spike';
    }
  }
  
  return 'sample';
}

/**
 * Retry an async operation with exponential backoff
 * Critical for handling transient API failures
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = Config.RETRY_ATTEMPTS,
  initialDelay: number = Config.RETRY_DELAY_MS
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on last attempt
      if (attempt === maxAttempts - 1) {
        break;
      }
      
      // Exponential backoff: 1s, 2s, 4s, ...
      const delayMs = initialDelay * Math.pow(2, attempt);
      await delay(delayMs);
    }
  }
  
  throw lastError;
}

/**
 * Get current Unix timestamp in milliseconds (for internal use)
 */
export function getCurrentTimestampMs(): number {
  return Date.now();
}

/**
 * Rate limiter with token bucket algorithm
 * Prevents API rate limit violations
 * Note: State resets on cold starts (Workers are stateless)
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  
  constructor(
    private maxTokens: number,
    private refillRate: number // tokens per second
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }
  
  async waitForToken(): Promise<void> {
    this.refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    
    // Wait until we have a token
    const waitTime = (1 - this.tokens) / this.refillRate * 1000;
    await delay(waitTime);
    this.tokens = 0;
  }
  
  private refill(): void {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + timePassed * this.refillRate);
    this.lastRefill = now;
  }
}
