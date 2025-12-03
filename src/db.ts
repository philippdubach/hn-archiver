/**
 * Database Operations Layer
 * All D1 database interactions with parameterized queries, transactions,
 * and optimized upsert logic for performance and security
 */

import type {
  WorkerEnv,
  HNItem,
  DBItem,
  Snapshot,
  ArchivingState,
  ErrorLog,
  WorkerMetrics,
  UpsertResult,
  ArchiveStats,
  EnrichedHNItem,
} from './types';
import { DatabaseError } from './types';
import { getCurrentTimestampMs, hasItemChanged, shouldCreateSnapshot, getSnapshotReason } from './utils';

/**
 * Upsert an item into the database with intelligent change detection
 * Returns metadata about what changed for snapshot decisions
 * Uses single query with RETURNING clause for optimal performance
 */
export async function upsertItem(
  db: D1Database,
  item: EnrichedHNItem
): Promise<UpsertResult> {
  const now = getCurrentTimestampMs();
  const kidsJson = item.kids ? JSON.stringify(item.kids) : null;
  
  try {
    // First, check if item exists and get full data for comparison
    const existing = await db
      .prepare(`
        SELECT 
          score, deleted, dead, title, url, text, descendants, kids,
          first_seen_at, last_changed_at, update_count
        FROM items 
        WHERE id = ?
      `)
      .bind(item.id)
      .first<{
        score: number | null;
        deleted: number;
        dead: number;
        title: string | null;
        url: string | null;
        text: string | null;
        descendants: number | null;
        kids: string | null;
        first_seen_at: number;
        last_changed_at: number;
        update_count: number;
      }>();
    
    const isNew = !existing;
    const oldScore = existing?.score;
    
    // Determine if content changed
    let contentChanged = isNew;
    if (existing) {
      contentChanged =
        (item.deleted ? 1 : 0) !== existing.deleted ||
        (item.dead ? 1 : 0) !== existing.dead ||
        (item.title || null) !== existing.title ||
        (item.url || null) !== existing.url ||
        (item.text || null) !== existing.text ||
        (item.score || null) !== existing.score ||
        (item.descendants || null) !== existing.descendants ||
        kidsJson !== existing.kids;
    }
    
    const lastChangedAt = contentChanged ? now : (existing?.last_changed_at || now);
    
    // Use separate INSERT/UPDATE for better D1 compatibility
    if (isNew) {
      // New item - use item.time if valid (> 0), otherwise use current time
      const itemTime = item.time && item.time > 0 ? item.time : now;
      await db
        .prepare(`
          INSERT INTO items (
            id, type, deleted, dead, title, url, text, by, time,
            score, descendants, parent, kids,
            first_seen_at, last_updated_at, last_changed_at, update_count
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          item.id,
          item.type,
          item.deleted ? 1 : 0,
          item.dead ? 1 : 0,
          item.title || null,
          item.url || null,
          item.text || null,
          item.by || null,
          itemTime,
          item.score || null,
          item.descendants || null,
          item.parent || null,
          kidsJson,
          now,
          now,
          now,
          0
        )
        .run();
    } else {
      // Existing item - calculate new update count and update
      const newUpdateCount = (existing?.update_count || 0) + 1;
      await db
        .prepare(`
          UPDATE items SET
            type = ?,
            deleted = ?,
            dead = ?,
            title = ?,
            url = ?,
            text = ?,
            by = ?,
            score = ?,
            descendants = ?,
            parent = ?,
            kids = ?,
            last_updated_at = ?,
            last_changed_at = ?,
            update_count = ?
          WHERE id = ?
        `)
        .bind(
          item.type,
          item.deleted ? 1 : 0,
          item.dead ? 1 : 0,
          item.title || null,
          item.url || null,
          item.text || null,
          item.by || null,
          item.score || null,
          item.descendants || null,
          item.parent || null,
          kidsJson,
          now,
          lastChangedAt,
          newUpdateCount,
          item.id
        )
        .run();
    }
    
    const changed = contentChanged;
    const updateCount = (existing?.update_count || 0) + 1;
    
    // Determine if snapshot should be created
    const shouldSnapshot = shouldCreateSnapshot(
      isNew ? null : ({ score: oldScore } as DBItem),
      item,
      updateCount,
      changed
    );
    
    return {
      changed,
      isNew,
      shouldSnapshot,
      oldScore,
      newScore: item.score,
      updateCount,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`Upsert failed for item ${item.id}:`, errorMsg, error);
    throw new DatabaseError(
      `Failed to upsert item ${item.id}: ${errorMsg}`,
      'upsert_item',
      error
    );
  }
}

/**
 * Insert a snapshot record for time-series analysis
 * Only called when snapshot criteria are met
 */
export async function insertSnapshot(
  db: D1Database,
  itemId: number,
  score: number | undefined,
  descendants: number | undefined,
  reason: Snapshot['snapshot_reason']
): Promise<void> {
  const now = getCurrentTimestampMs();
  
  try {
    await db
      .prepare(`
        INSERT INTO item_snapshots (item_id, captured_at, score, descendants, snapshot_reason)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(itemId, now, score || null, descendants || null, reason)
      .run();
  } catch (error) {
    throw new DatabaseError(
      `Failed to insert snapshot for item ${itemId}`,
      'insert_snapshot',
      error
    );
  }
}

/**
 * Get archiving state value by key
 */
export async function getState(db: D1Database, key: string): Promise<number> {
  try {
    const result = await db
      .prepare('SELECT value FROM archiving_state WHERE key = ?')
      .bind(key)
      .first<{ value: number }>();
    
    return result?.value || 0;
  } catch (error) {
    throw new DatabaseError(
      `Failed to get state for key ${key}`,
      'get_state',
      error
    );
  }
}

/**
 * Update archiving state value
 */
export async function updateState(
  db: D1Database,
  key: string,
  value: number
): Promise<void> {
  const now = getCurrentTimestampMs();
  
  try {
    await db
      .prepare(`
        INSERT INTO archiving_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .bind(key, value, now)
      .run();
  } catch (error) {
    throw new DatabaseError(
      `Failed to update state for key ${key}`,
      'update_state',
      error
    );
  }
}

/**
 * Get items that haven't been updated recently (for backfill)
 * Prioritizes high-value items (high score/descendants)
 */
export async function getStaleItems(
  db: D1Database,
  olderThanMs: number,
  limit: number = 100
): Promise<number[]> {
  const threshold = getCurrentTimestampMs() - olderThanMs;
  
  try {
    const results = await db
      .prepare(`
        SELECT id FROM items
        WHERE last_updated_at < ?
          AND deleted = 0
          AND (score > 50 OR descendants > 20)
        ORDER BY descendants DESC, score DESC, last_updated_at ASC
        LIMIT ?
      `)
      .bind(threshold, limit)
      .all<{ id: number }>();
    
    return results.results?.map((r) => r.id) || [];
  } catch (error) {
    throw new DatabaseError(
      'Failed to get stale items',
      'get_stale_items',
      error
    );
  }
}

/**
 * Get items that were recently updated (to avoid duplicate work)
 */
export async function getRecentlyUpdatedItems(
  db: D1Database,
  itemIds: number[],
  withinMs: number
): Promise<Set<number>> {
  if (itemIds.length === 0) return new Set();
  
  const threshold = getCurrentTimestampMs() - withinMs;
  const placeholders = itemIds.map(() => '?').join(',');
  
  try {
    const results = await db
      .prepare(`
        SELECT id FROM items
        WHERE id IN (${placeholders})
          AND last_updated_at >= ?
      `)
      .bind(...itemIds, threshold)
      .all<{ id: number }>();
    
    return new Set(results.results?.map((r) => r.id) || []);
  } catch (error) {
    throw new DatabaseError(
      'Failed to get recently updated items',
      'get_recently_updated_items',
      error
    );
  }
}

/**
 * Log an error to the database for debugging and monitoring
 */
export async function logError(
  db: D1Database,
  workerType: string,
  error: Error,
  context?: Record<string, unknown>
): Promise<void> {
  const now = getCurrentTimestampMs();
  const errorDetails = JSON.stringify({
    message: error.message,
    stack: error.stack?.slice(0, 1000),
    context,
  });
  
  try {
    await db
      .prepare(`
        INSERT INTO error_log (timestamp, worker_type, error_message, error_details)
        VALUES (?, ?, ?, ?)
      `)
      .bind(now, workerType, error.message.slice(0, 500), errorDetails)
      .run();
    
    // Also increment error counter
    await db
      .prepare(`
        UPDATE archiving_state
        SET value = value + 1, updated_at = ?
        WHERE key = 'errors_today'
      `)
      .bind(now)
      .run();
  } catch (dbError) {
    // Don't throw - logging errors shouldn't break the worker
    console.error('Failed to log error to database:', dbError);
  }
}

/**
 * Record worker metrics for monitoring and optimization
 */
export async function recordMetrics(
  db: D1Database,
  metrics: Omit<WorkerMetrics, 'id' | 'timestamp'>
): Promise<void> {
  const now = getCurrentTimestampMs();
  
  try {
    await db
      .prepare(`
        INSERT INTO worker_metrics (
          timestamp, worker_type, items_processed, items_changed,
          snapshots_created, duration_ms, errors
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        now,
        metrics.worker_type,
        metrics.items_processed,
        metrics.items_changed,
        metrics.snapshots_created,
        metrics.duration_ms,
        metrics.errors
      )
      .run();
  } catch (error) {
    // Don't throw - metrics shouldn't break the worker
    console.error('Failed to record metrics:', error);
  }
}

/**
 * Get comprehensive statistics about the archive
 * Used for monitoring endpoints and dashboards
 */
export async function getArchiveStats(db: D1Database): Promise<ArchiveStats> {
  try {
    const oneDayAgo = getCurrentTimestampMs() - 24 * 60 * 60 * 1000;
    
    const result = await db
      .prepare(`
        SELECT
          (SELECT value FROM archiving_state WHERE key = 'max_item_id_seen') as max_item_id,
          (SELECT COUNT(*) FROM items) as total_items,
          (SELECT COUNT(*) FROM items WHERE first_seen_at > ?) as items_today,
          (SELECT COUNT(*) FROM items WHERE deleted = 1) as deleted_count,
          (SELECT COUNT(*) FROM item_snapshots WHERE captured_at > ?) as snapshots_today,
          (SELECT value FROM archiving_state WHERE key = 'errors_today') as errors_today,
          (SELECT value FROM archiving_state WHERE key = 'last_discovery_run') as last_discovery,
          (SELECT value FROM archiving_state WHERE key = 'last_updates_check') as last_update_check,
          (SELECT value FROM archiving_state WHERE key = 'last_backfill_run') as last_backfill
      `)
      .bind(oneDayAgo, oneDayAgo)
      .first<ArchiveStats>();
    
    if (!result) {
      throw new DatabaseError('Failed to get archive stats');
    }
    
    return result;
  } catch (error) {
    throw new DatabaseError('Failed to get archive stats', 'get_archive_stats', error);
  }
}

/**
 * Clean up old error logs (keep last 7 days)
 * Should be run periodically to prevent table bloat
 */
export async function cleanupOldErrors(db: D1Database): Promise<number> {
  const sevenDaysAgo = getCurrentTimestampMs() - 7 * 24 * 60 * 60 * 1000;
  
  try {
    const result = await db
      .prepare('DELETE FROM error_log WHERE timestamp < ?')
      .bind(sevenDaysAgo)
      .run();
    
    return result.meta.changes || 0;
  } catch (error) {
    console.error('Failed to cleanup old errors:', error);
    return 0;
  }
}

/**
 * Clean up old metrics (keep last 30 days)
 * Should be run periodically to prevent table bloat
 */
export async function cleanupOldMetrics(db: D1Database): Promise<number> {
  const thirtyDaysAgo = getCurrentTimestampMs() - 30 * 24 * 60 * 60 * 1000;
  
  try {
    const result = await db
      .prepare('DELETE FROM worker_metrics WHERE timestamp < ?')
      .bind(thirtyDaysAgo)
      .run();
    
    return result.meta.changes || 0;
  } catch (error) {
    console.error('Failed to cleanup old metrics:', error);
    return 0;
  }
}
