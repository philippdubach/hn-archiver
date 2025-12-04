/**
 * TypeScript type definitions for HackerNews Archiver
 * Strict typing for type safety and IDE autocomplete
 */

// HackerNews API response types
export type HNItemType = 'story' | 'comment' | 'job' | 'poll' | 'pollopt';

export interface HNItem {
  id: number;
  type: HNItemType;
  deleted?: boolean;
  dead?: boolean;
  by?: string;
  time: number;
  text?: string;
  parent?: number;
  kids?: number[];
  url?: string;
  score?: number;
  title?: string;
  descendants?: number;
  poll?: number;  // For pollopts
  parts?: number[];  // For polls
}

// HN API endpoints responses
export interface HNUpdates {
  items: number[];
  profiles: string[];
}

// Database item representation with temporal fields
export interface DBItem extends Omit<HNItem, 'kids'> {
  kids: string | null;  // JSON string in DB
  first_seen_at: number;
  last_updated_at: number;
  last_changed_at: number;
  update_count: number;
}

// Snapshot record for time-series analysis
export type SnapshotReason = 'score_spike' | 'front_page' | 'sample' | 'new_item';

export interface Snapshot {
  id?: number;
  item_id: number;
  captured_at: number;
  score: number | null;
  descendants: number | null;
  snapshot_reason: SnapshotReason;
}

// Archiving state tracking
export interface ArchivingState {
  key: string;
  value: number;
  updated_at: number;
}

// Error log entry
export interface ErrorLog {
  id?: number;
  timestamp: number;
  worker_type: string;
  error_message: string;
  error_details: string | null;
}

// Worker metrics
export interface WorkerMetrics {
  id?: number;
  timestamp: number;
  worker_type: string;
  items_processed: number;
  items_changed: number;
  snapshots_created: number;
  duration_ms: number;
  errors: number;
}

// Workers AI binding type
export interface AIBinding {
  run(model: string, inputs: unknown): Promise<unknown>;
}

// Vectorize binding type for similarity search
export interface VectorizeBinding {
  insert(vectors: VectorizeVector[]): Promise<VectorizeVectorMutation>;
  upsert(vectors: VectorizeVector[]): Promise<VectorizeVectorMutation>;
  query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches>;
  getByIds(ids: string[]): Promise<VectorizeVector[]>;
  deleteByIds(ids: string[]): Promise<VectorizeVectorMutation>;
  describe(): Promise<VectorizeIndexDetails>;
}

export interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
}

export interface VectorizeQueryOptions {
  topK?: number;
  returnValues?: boolean;
  returnMetadata?: 'none' | 'indexed' | 'all';
  filter?: Record<string, unknown>;
}

export interface VectorizeMatches {
  matches: VectorizeMatch[];
  count: number;
}

export interface VectorizeMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, string | number | boolean>;
}

export interface VectorizeVectorMutation {
  mutationId: string;
  count: number;
}

export interface VectorizeIndexDetails {
  dimensions: number;
  vectorCount: number;
}

// Usage counter for budget tracking
export interface UsageCounter {
  counter_key: string;
  counter_value: number;
  updated_at: number;
}

// Budget limits for paid plan (stay within included amounts)
export const BudgetLimits = {
  // D1: 25 billion reads/month, but we'll set a conservative daily limit
  D1_READS_PER_DAY: 500_000_000,  // 500M/day = 15B/month (well under 25B)
  // Vectorize: 50 million queried dimensions/month
  // 768 dimensions per query, so ~65k queries/month max
  // Conservative: 1500 queries/day to stay safe
  VECTORIZE_QUERIES_PER_DAY: 1500,
  // Vectorize: 10 million stored dimensions
  // 768 dimensions per vector = ~13k vectors max
  // Conservative: 10k vectors total
  VECTORIZE_MAX_STORED_VECTORS: 10000,
  // Embedding generation per backfill run
  EMBEDDING_BATCH_SIZE: 50,
} as const;

// Worker environment bindings
export interface WorkerEnv {
  DB: D1Database;
  AI: AIBinding;
  VECTORIZE: VectorizeBinding;
  TRIGGER_SECRET?: string;  // Optional secret for protected endpoints
}

// Worker execution result
export interface WorkerResult {
  success: boolean;
  items_processed: number;
  items_changed: number;
  snapshots_created: number;
  duration_ms: number;
  errors: number;
  error_messages?: string[];
}

// Configuration constants
export const Config = {
  HN_API_BASE: 'https://hacker-news.firebaseio.com/v0',
  BATCH_SIZE: 100,
  CONCURRENT_REQUESTS: 100,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1000,
  SNAPSHOT_SCORE_THRESHOLD: 20,
  SNAPSHOT_SAMPLE_FREQUENCY: 4,
  STALE_ITEM_THRESHOLD_MS: 24 * 60 * 60 * 1000,  // 24 hours
  BACKFILL_LIMIT: 100,
  RECENT_UPDATE_WINDOW_MS: 5 * 60 * 1000,  // 5 minutes
  // Stale item query thresholds
  STALE_MIN_SCORE: 50,
  STALE_MIN_DESCENDANTS: 20,
  // Health check thresholds (ms)
  HEALTH_DEGRADED_DISCOVERY_MS: 10 * 60 * 1000,  // 10 minutes
  HEALTH_DEGRADED_UPDATES_MS: 20 * 60 * 1000,    // 20 minutes
  HEALTH_UNHEALTHY_DISCOVERY_MS: 30 * 60 * 1000, // 30 minutes
} as const;

// Type guards for runtime validation
export function isValidHNItem(item: unknown): item is HNItem {
  if (typeof item !== 'object' || item === null) return false;
  const i = item as Partial<HNItem>;
  return (
    typeof i.id === 'number' &&
    typeof i.type === 'string' &&
    ['story', 'comment', 'job', 'poll', 'pollopt'].includes(i.type) &&
    typeof i.time === 'number'
  );
}

export function isValidHNUpdates(data: unknown): data is HNUpdates {
  if (typeof data !== 'object' || data === null) return false;
  const u = data as Partial<HNUpdates>;
  return (
    Array.isArray(u.items) &&
    u.items.every((id) => typeof id === 'number') &&
    Array.isArray(u.profiles) &&
    u.profiles.every((p) => typeof p === 'string')
  );
}

// Utility type for item with computed fields
export interface EnrichedHNItem extends HNItem {
  isFrontPage?: boolean;
  shouldSnapshot?: boolean;
}

// Database query result types
export interface UpsertResult {
  changed: boolean;
  isNew: boolean;
  shouldSnapshot: boolean;
  oldScore?: number;
  newScore?: number;
  updateCount: number;
}

// Statistics for monitoring
export interface ArchiveStats {
  max_item_id: number;
  total_items: number;
  items_today: number;
  deleted_count: number;
  snapshots_today: number;
  errors_today: number;
  last_discovery: number;
  last_update_check: number;
  last_backfill: number;
}

// HTTP response types for API endpoints
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  database: 'connected' | 'error';
  last_run: {
    discovery: number;
    updates: number;
    backfill: number;
  };
}

export interface StatsResponse extends ArchiveStats {
  timestamp: number;
}

// Error types for better error handling
export class HNAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public itemId?: number
  ) {
    super(message);
    this.name = 'HNAPIError';
  }
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    public query?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class WorkerError extends Error {
  constructor(
    message: string,
    public workerType: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}
