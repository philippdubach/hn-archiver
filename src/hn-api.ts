/**
 * HackerNews API Client
 * Handles all interactions with the HN Firebase API with robust error handling,
 * retry logic, and batch processing optimizations
 */

import type { HNItem, HNUpdates } from './types';
import { Config, isValidHNItem, isValidHNUpdates } from './types';
import { retryWithBackoff, chunk, RateLimiter } from './utils';

// Rate limiter: 50 requests per second (balanced - HN has no official limit)
const rateLimiter = new RateLimiter(50, 50);

// Fetch timeout in milliseconds (Workers have 30s limit, use 10s for individual requests)
const FETCH_TIMEOUT_MS = 10000;

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch the current maximum item ID from HN
 * This is the highest item number that has been created
 */
export async function fetchMaxItemId(): Promise<number> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetchWithTimeout(`${Config.HN_API_BASE}/maxitem.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const maxId = await response.json();
    
    if (typeof maxId !== 'number' || maxId < 0) {
      throw new Error(`Invalid max item ID: ${maxId}`);
    }
    
    return maxId as number;
  });
}

/**
 * Fetch a single item by ID from HN API
 * Returns null if item doesn't exist or is deleted
 */
export async function fetchItem(id: number): Promise<HNItem | null> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetchWithTimeout(`${Config.HN_API_BASE}/item/${id}.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    // 404 means item doesn't exist or was deleted - not an error
    if (response.status === 404) {
      return null;
    }
    
    if (!response.ok) {
      throw new Error(`HN API error for item ${id}: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // HN API returns null for deleted items
    if (data === null) {
      return null;
    }
    
    // Validate response structure
    if (!isValidHNItem(data)) {
      console.warn(`Invalid item data for ID ${id}:`, data);
      return null;
    }
    
    return data as HNItem;
  }, Config.RETRY_ATTEMPTS, Config.RETRY_DELAY_MS);
}

/**
 * Fetch multiple items in parallel with batching
 * Optimized for performance - fetches up to 100 items concurrently
 * Handles failures gracefully and continues processing
 */
export async function fetchItemsBatch(ids: number[]): Promise<HNItem[]> {
  if (ids.length === 0) return [];
  
  // Process in chunks to respect concurrency limits
  const chunks = chunk(ids, Config.CONCURRENT_REQUESTS);
  const allItems: HNItem[] = [];
  
  for (const chunkIds of chunks) {
    // Use Promise.allSettled to handle individual failures
    const promises = chunkIds.map(async (id) => {
      try {
        const item = await fetchItem(id);
        return item;
      } catch (error) {
        console.error(`Failed to fetch item ${id}:`, error);
        return null;
      }
    });
    
    const results = await Promise.allSettled(promises);
    
    // Extract successful results
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        allItems.push(result.value);
      }
    }
  }
  
  return allItems;
}

/**
 * Fetch top stories (up to 500 IDs)
 * These are the stories currently on the front page
 */
export async function fetchTopStories(): Promise<number[]> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetchWithTimeout(`${Config.HN_API_BASE}/topstories.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!Array.isArray(data) || !data.every((id) => typeof id === 'number')) {
      throw new Error('Invalid top stories response');
    }
    
    return data as number[];
  });
}

/**
 * Fetch recently changed items and profiles
 * CRITICAL for efficiency - tells us which items changed without polling everything
 */
export async function fetchUpdates(): Promise<HNUpdates> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetchWithTimeout(`${Config.HN_API_BASE}/updates.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!isValidHNUpdates(data)) {
      throw new Error('Invalid updates response');
    }
    
    return data as HNUpdates;
  });
}
