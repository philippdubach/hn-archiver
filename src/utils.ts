/**
 * Utility functions for HackerNews Archiver
 * Reusable helpers for batching, comparison, validation, and timing
 */

import type { DBItem, HNItem, EnrichedHNItem } from './types';
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
 * Deep comparison to detect if item data has actually changed
 * Ignores metadata fields like last_updated_at
 */
export function hasItemChanged(oldItem: DBItem, newItem: HNItem): boolean {
  // Compare primitive fields
  if (oldItem.score !== newItem.score) return true;
  if (oldItem.descendants !== newItem.descendants) return true;
  if (oldItem.title !== newItem.title) return true;
  if (oldItem.text !== newItem.text) return true;
  if (oldItem.url !== newItem.url) return true;
  if (oldItem.deleted !== (newItem.deleted || false)) return true;
  if (oldItem.dead !== (newItem.dead || false)) return true;
  if (oldItem.by !== newItem.by) return true;
  
  // Compare kids array (stored as JSON in DB)
  const oldKids = oldItem.kids ? JSON.parse(oldItem.kids) : null;
  const newKids = newItem.kids || null;
  if (JSON.stringify(oldKids) !== JSON.stringify(newKids)) return true;
  
  return false;
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
  updateCount: number
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
 * Safely parse JSON with error handling
 * Returns null if parsing fails
 */
export function safeJsonParse<T>(json: string | null): T | null {
  if (!json) return null;
  
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Get current Unix timestamp in seconds (matches HN API format)
 */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Get current Unix timestamp in milliseconds (for internal use)
 */
export function getCurrentTimestampMs(): number {
  return Date.now();
}

/**
 * Validate that a timestamp is reasonable (not too old, not in future)
 */
export function isValidTimestamp(timestamp: number): boolean {
  const now = getCurrentTimestamp();
  const hnLaunchDate = 1160418111; // Oct 2006 when HN launched
  return timestamp >= hnLaunchDate && timestamp <= now + 86400; // Allow 1 day future for clock skew
}

/**
 * Batch async operations with concurrency limit
 * Prevents overwhelming the API or Worker CPU limits
 */
export async function batchProcess<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = Config.CONCURRENT_REQUESTS
): Promise<R[]> {
  const results: R[] = [];
  const chunks = chunk(items, concurrency);
  
  for (const chunk of chunks) {
    const chunkResults = await Promise.allSettled(
      chunk.map((item) => processor(item))
    );
    
    // Extract successful results, log failures
    for (const result of chunkResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        console.error('Batch processing error:', result.reason);
      }
    }
  }
  
  return results;
}

/**
 * Sanitize and truncate error messages for logging
 * Prevents excessive log spam
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

/**
 * Create a structured error details object for database storage
 */
export function createErrorDetails(
  error: unknown,
  context?: Record<string, unknown>
): string {
  const details = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.slice(0, 1000) : undefined,
    context,
    timestamp: getCurrentTimestampMs(),
  };
  
  return JSON.stringify(details);
}

/**
 * Check if an error is retryable (network issues, 5xx errors)
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // Network errors are retryable
    if (message.includes('network') || message.includes('timeout')) {
      return true;
    }
    
    // 5xx errors are retryable
    if (message.includes('500') || message.includes('502') || 
        message.includes('503') || message.includes('504')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Rate limiter with token bucket algorithm
 * Prevents API rate limit violations
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
