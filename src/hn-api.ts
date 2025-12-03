/**
 * HackerNews API Client
 * Handles all interactions with the HN Firebase API with robust error handling,
 * retry logic, and batch processing optimizations
 */

import type { HNItem, HNUpdates, HNAPIError } from './types';
import { Config, isValidHNItem, isValidHNUpdates } from './types';
import { retryWithBackoff, chunk, RateLimiter } from './utils';

// Rate limiter: 10 requests per second (conservative, HN has no official limit)
const rateLimiter = new RateLimiter(10, 10);

/**
 * Fetch the current maximum item ID from HN
 * This is the highest item number that has been created
 */
export async function fetchMaxItemId(): Promise<number> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetch(`${Config.HN_API_BASE}/maxitem.json`, {
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
    
    const response = await fetch(`${Config.HN_API_BASE}/item/${id}.json`, {
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
    
    const response = await fetch(`${Config.HN_API_BASE}/topstories.json`, {
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
 * Fetch new stories (up to 500 IDs)
 * These are the most recently created stories
 */
export async function fetchNewStories(): Promise<number[]> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetch(`${Config.HN_API_BASE}/newstories.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!Array.isArray(data) || !data.every((id) => typeof id === 'number')) {
      throw new Error('Invalid new stories response');
    }
    
    return data as number[];
  });
}

/**
 * Fetch best stories (up to 500 IDs)
 * These are the highest-rated recent stories
 */
export async function fetchBestStories(): Promise<number[]> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetch(`${Config.HN_API_BASE}/beststories.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!Array.isArray(data) || !data.every((id) => typeof id === 'number')) {
      throw new Error('Invalid best stories response');
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
    
    const response = await fetch(`${Config.HN_API_BASE}/updates.json`, {
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

/**
 * Fetch Ask HN stories (up to 200 IDs)
 */
export async function fetchAskStories(): Promise<number[]> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetch(`${Config.HN_API_BASE}/askstories.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid ask stories response');
    }
    
    return data as number[];
  });
}

/**
 * Fetch Show HN stories (up to 200 IDs)
 */
export async function fetchShowStories(): Promise<number[]> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetch(`${Config.HN_API_BASE}/showstories.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid show stories response');
    }
    
    return data as number[];
  });
}

/**
 * Fetch job stories (up to 200 IDs)
 */
export async function fetchJobStories(): Promise<number[]> {
  return retryWithBackoff(async () => {
    await rateLimiter.waitForToken();
    
    const response = await fetch(`${Config.HN_API_BASE}/jobstories.json`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`HN API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid job stories response');
    }
    
    return data as number[];
  });
}
