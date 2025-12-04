/**
 * Database Operations Layer
 * All D1 database interactions with parameterized queries, transactions,
 * and optimized upsert logic for performance and security
 */

import type {
  DBItem,
  Snapshot,
  WorkerMetrics,
  UpsertResult,
  ArchiveStats,
  EnrichedHNItem,
} from './types';
import { DatabaseError, Config } from './types';
import { getCurrentTimestampMs, shouldCreateSnapshot, getSnapshotReason } from './utils';

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
      oldScore: oldScore ?? undefined,
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
 * Batch upsert multiple items using D1's batch API
 * Significantly faster than individual upserts - single transaction
 */
export async function batchUpsertItems(
  db: D1Database,
  items: EnrichedHNItem[]
): Promise<{ processed: number; changed: number; snapshots: Array<{ id: number; score?: number; descendants?: number; reason: Snapshot['snapshot_reason'] }> }> {
  if (items.length === 0) return { processed: 0, changed: 0, snapshots: [] };
  
  const now = getCurrentTimestampMs();
  const snapshots: Array<{ id: number; score?: number; descendants?: number; reason: Snapshot['snapshot_reason'] }> = [];
  let changed = 0;
  
  // First, batch query to check existing items
  const ids = items.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  
  const existingResults = await db
    .prepare(`SELECT id, score, deleted, dead, title, url, text, descendants, kids, update_count, last_changed_at FROM items WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number; score: number | null; deleted: number; dead: number; title: string | null; url: string | null; text: string | null; descendants: number | null; kids: string | null; update_count: number; last_changed_at: number }>();
  
  const existingMap = new Map(existingResults.results?.map(r => [r.id, r]) || []);
  
  // Build batch statements
  const statements: D1PreparedStatement[] = [];
  
  for (const item of items) {
    const kidsJson = item.kids ? JSON.stringify(item.kids) : null;
    const existing = existingMap.get(item.id);
    const isNew = !existing;
    
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
    
    if (contentChanged) changed++;
    
    const lastChangedAt = contentChanged ? now : (existing?.last_changed_at || now);
    const updateCount = (existing?.update_count || 0) + 1;
    
    if (isNew) {
      const itemTime = item.time && item.time > 0 ? item.time : now;
      statements.push(
        db.prepare(`INSERT INTO items (id, type, deleted, dead, title, url, text, by, time, score, descendants, parent, kids, first_seen_at, last_updated_at, last_changed_at, update_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(item.id, item.type, item.deleted ? 1 : 0, item.dead ? 1 : 0, item.title || null, item.url || null, item.text || null, item.by || null, itemTime, item.score || null, item.descendants || null, item.parent || null, kidsJson, now, now, now, 0)
      );
    } else {
      statements.push(
        db.prepare(`UPDATE items SET type = ?, deleted = ?, dead = ?, title = ?, url = ?, text = ?, by = ?, score = ?, descendants = ?, parent = ?, kids = ?, last_updated_at = ?, last_changed_at = ?, update_count = ? WHERE id = ?`)
          .bind(item.type, item.deleted ? 1 : 0, item.dead ? 1 : 0, item.title || null, item.url || null, item.text || null, item.by || null, item.score || null, item.descendants || null, item.parent || null, kidsJson, now, lastChangedAt, updateCount, item.id)
      );
    }
    
    // Check if snapshot needed
    if (shouldCreateSnapshot(isNew ? null : ({ score: existing?.score } as DBItem), item, updateCount, contentChanged)) {
      const reason = getSnapshotReason(isNew ? null : ({ score: existing?.score } as DBItem), item, updateCount);
      snapshots.push({ id: item.id, score: item.score, descendants: item.descendants, reason });
    }
  }
  
  // Execute batch in a single transaction
  if (statements.length > 0) {
    await db.batch(statements);
  }
  
  return { processed: items.length, changed, snapshots };
}

/**
 * Batch insert snapshots using D1's batch API
 */
export async function batchInsertSnapshots(
  db: D1Database,
  snapshots: Array<{ id: number; score?: number; descendants?: number; reason: Snapshot['snapshot_reason'] }>
): Promise<void> {
  if (snapshots.length === 0) return;
  
  const now = getCurrentTimestampMs();
  const statements = snapshots.map(s =>
    db.prepare(`INSERT INTO item_snapshots (item_id, captured_at, score, descendants, snapshot_reason) VALUES (?, ?, ?, ?, ?)`)
      .bind(s.id, now, s.score || null, s.descendants || null, s.reason)
  );
  
  await db.batch(statements);
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
          AND (score > ? OR descendants > ?)
        ORDER BY descendants DESC, score DESC, last_updated_at ASC
        LIMIT ?
      `)
      .bind(threshold, Config.STALE_MIN_SCORE, Config.STALE_MIN_DESCENDANTS, limit)
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
 * Uses chunking to avoid D1 bind parameter limits
 */
export async function getRecentlyUpdatedItems(
  db: D1Database,
  itemIds: number[],
  withinMs: number
): Promise<Set<number>> {
  if (itemIds.length === 0) return new Set();
  
  const threshold = getCurrentTimestampMs() - withinMs;
  const recentIds = new Set<number>();
  
  // D1 has limits on bind parameters, so chunk the query
  const CHUNK_SIZE = 50;
  
  try {
    for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
      const chunk = itemIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      
      const results = await db
        .prepare(`
          SELECT id FROM items
          WHERE id IN (${placeholders})
            AND last_updated_at >= ?
        `)
        .bind(...chunk, threshold)
        .all<{ id: number }>();
      
      for (const row of results.results || []) {
        recentIds.add(row.id);
      }
    }
    
    return recentIds;
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

// ============================================
// Frontend API Functions
// ============================================

/**
 * Get paginated list of items for frontend
 */
export async function getItems(
  db: D1Database,
  options: {
    limit?: number;
    offset?: number;
    type?: string;
    orderBy?: 'time' | 'score' | 'descendants';
    order?: 'asc' | 'desc';
    since?: number; // Unix timestamp - only return items since this time
  }
): Promise<{ items: DBItem[]; total: number }> {
  const { limit = 50, offset = 0, type, orderBy = 'time', order = 'desc', since } = options;
  
  // Validate orderBy to prevent SQL injection
  const validOrderBy = ['time', 'score', 'descendants'].includes(orderBy) ? orderBy : 'time';
  const validOrder = order === 'asc' ? 'ASC' : 'DESC';
  
  try {
    let countQuery = 'SELECT COUNT(*) as count FROM items';
    let itemsQuery = `SELECT id, type, deleted, dead, title, url, text, by, time, score, descendants, parent, first_seen_at, last_updated_at FROM items`;
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];
    
    if (type) {
      // Filter by specific type
      conditions.push('type = ?');
      bindings.push(type);
    } else {
      // Default: exclude comments (show only posts)
      conditions.push("type != 'comment'");
    }
    
    if (since) {
      conditions.push('time >= ?');
      bindings.push(since);
    }
    
    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      countQuery += whereClause;
      itemsQuery += whereClause;
    }
    
    itemsQuery += ` ORDER BY ${validOrderBy} ${validOrder} NULLS LAST LIMIT ? OFFSET ?`;
    
    const [countResult, itemsResult] = await Promise.all([
      db.prepare(countQuery).bind(...bindings).first<{ count: number }>(),
      db.prepare(itemsQuery).bind(...bindings, limit, offset).all<DBItem>(),
    ]);
    
    return {
      items: itemsResult.results || [],
      total: countResult?.count || 0,
    };
  } catch (error) {
    throw new DatabaseError('Failed to get items', 'get_items', error);
  }
}

/**
 * Get a single item with its snapshots
 */
export async function getItemWithSnapshots(
  db: D1Database,
  itemId: number
): Promise<{ item: DBItem | null; snapshots: Snapshot[] }> {
  try {
    const [itemResult, snapshotsResult] = await Promise.all([
      db.prepare(`SELECT * FROM items WHERE id = ?`).bind(itemId).first<DBItem>(),
      db.prepare(`SELECT * FROM item_snapshots WHERE item_id = ? ORDER BY captured_at DESC LIMIT 100`)
        .bind(itemId)
        .all<Snapshot>(),
    ]);
    
    return {
      item: itemResult || null,
      snapshots: snapshotsResult.results || [],
    };
  } catch (error) {
    throw new DatabaseError(`Failed to get item ${itemId}`, 'get_item_with_snapshots', error);
  }
}

/**
 * Get recent worker metrics for monitoring
 */
export async function getRecentMetrics(
  db: D1Database,
  limit: number = 50
): Promise<WorkerMetrics[]> {
  try {
    const result = await db
      .prepare(`
        SELECT 
          id,
          timestamp as started_at,
          worker_type,
          items_processed,
          items_changed,
          snapshots_created,
          duration_ms,
          errors,
          CASE WHEN errors > 0 THEN 'error' ELSE 'completed' END as status
        FROM worker_metrics 
        ORDER BY timestamp DESC 
        LIMIT ?
      `)
      .bind(limit)
      .all<WorkerMetrics & { status: string }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get recent metrics', 'get_recent_metrics', error);
  }
}

/**
 * Get type distribution for analytics
 */
export async function getTypeDistribution(db: D1Database): Promise<Array<{ type: string; count: number }>> {
  try {
    const result = await db
      .prepare(`
        SELECT type, COUNT(*) as count 
        FROM items 
        GROUP BY type 
        ORDER BY count DESC
      `)
      .all<{ type: string; count: number }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get type distribution', 'get_type_distribution', error);
  }
}

/**
 * Get snapshot reason distribution
 */
export async function getSnapshotReasons(db: D1Database): Promise<Array<{ reason: string; count: number }>> {
  try {
    const result = await db
      .prepare(`
        SELECT snapshot_reason as reason, COUNT(*) as count 
        FROM item_snapshots 
        GROUP BY snapshot_reason 
        ORDER BY count DESC
      `)
      .all<{ reason: string; count: number }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get snapshot reasons', 'get_snapshot_reasons', error);
  }
}

/**
 * Get top items by score or descendants
 */
export async function getTopItems(
  db: D1Database,
  orderBy: 'score' | 'descendants',
  limit: number = 10
): Promise<Array<{ id: number; title: string | null; type: string; score: number | null; descendants: number | null }>> {
  const validOrderBy = orderBy === 'descendants' ? 'descendants' : 'score';
  
  try {
    const result = await db
      .prepare(`
        SELECT id, title, type, score, descendants
        FROM items
        WHERE deleted = 0 AND type IN ('story', 'poll', 'job')
        ORDER BY ${validOrderBy} DESC NULLS LAST
        LIMIT ?
      `)
      .bind(limit)
      .all<{ id: number; title: string | null; type: string; score: number | null; descendants: number | null }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get top items', 'get_top_items', error);
  }
}

// ============================================
// Advanced Analytics Functions
// ============================================

export interface AuthorStats {
  by: string;
  post_count: number;
  story_count: number;
  comment_count: number;
  total_score: number;
  avg_score: number;
  total_comments_received: number;
}

/**
 * Get top authors by post count
 */
export async function getTopAuthors(
  db: D1Database,
  limit: number = 20
): Promise<AuthorStats[]> {
  try {
    const result = await db
      .prepare(`
        SELECT 
          by,
          COUNT(*) as post_count,
          SUM(CASE WHEN type = 'story' THEN 1 ELSE 0 END) as story_count,
          SUM(CASE WHEN type = 'comment' THEN 1 ELSE 0 END) as comment_count,
          COALESCE(SUM(score), 0) as total_score,
          ROUND(COALESCE(AVG(score), 0), 1) as avg_score,
          COALESCE(SUM(descendants), 0) as total_comments_received
        FROM items 
        WHERE by IS NOT NULL AND by != '' AND deleted = 0
        GROUP BY by 
        ORDER BY post_count DESC 
        LIMIT ?
      `)
      .bind(limit)
      .all<AuthorStats>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get top authors', 'get_top_authors', error);
  }
}

/**
 * Get most successful authors by average score (min 3 stories)
 */
export async function getSuccessfulAuthors(
  db: D1Database,
  limit: number = 20
): Promise<AuthorStats[]> {
  try {
    const result = await db
      .prepare(`
        SELECT 
          by,
          COUNT(*) as post_count,
          SUM(CASE WHEN type = 'story' THEN 1 ELSE 0 END) as story_count,
          SUM(CASE WHEN type = 'comment' THEN 1 ELSE 0 END) as comment_count,
          COALESCE(SUM(score), 0) as total_score,
          ROUND(COALESCE(AVG(score), 0), 1) as avg_score,
          COALESCE(SUM(descendants), 0) as total_comments_received
        FROM items 
        WHERE by IS NOT NULL AND by != '' AND deleted = 0 AND type = 'story'
        GROUP BY by 
        HAVING story_count >= 2
        ORDER BY avg_score DESC 
        LIMIT ?
      `)
      .bind(limit)
      .all<AuthorStats>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get successful authors', 'get_successful_authors', error);
  }
}

/**
 * Get posts per hour of day (UTC)
 */
export async function getPostsByHour(db: D1Database): Promise<Array<{ hour: number; count: number; avg_score: number }>> {
  try {
    const result = await db
      .prepare(`
        SELECT 
          CAST(strftime('%H', time, 'unixepoch') AS INTEGER) as hour,
          COUNT(*) as count,
          ROUND(COALESCE(AVG(score), 0), 1) as avg_score
        FROM items 
        WHERE type = 'story' AND deleted = 0 AND time IS NOT NULL
        GROUP BY hour
        ORDER BY hour
      `)
      .all<{ hour: number; count: number; avg_score: number }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get posts by hour', 'get_posts_by_hour', error);
  }
}

/**
 * Get posts per day of week (0=Sunday, 6=Saturday)
 */
export async function getPostsByDayOfWeek(db: D1Database): Promise<Array<{ day: number; day_name: string; count: number; avg_score: number }>> {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  try {
    const result = await db
      .prepare(`
        SELECT 
          CAST(strftime('%w', time, 'unixepoch') AS INTEGER) as day,
          COUNT(*) as count,
          ROUND(COALESCE(AVG(score), 0), 1) as avg_score
        FROM items 
        WHERE type = 'story' AND deleted = 0 AND time IS NOT NULL
        GROUP BY day
        ORDER BY day
      `)
      .all<{ day: number; count: number; avg_score: number }>();
    
    return (result.results || []).map(r => ({
      ...r,
      day_name: dayNames[r.day] || 'Unknown'
    }));
  } catch (error) {
    throw new DatabaseError('Failed to get posts by day of week', 'get_posts_by_day_of_week', error);
  }
}

/**
 * Get posts per date (last N days)
 */
export async function getPostsByDate(
  db: D1Database,
  days: number = 30
): Promise<Array<{ date: string; count: number; avg_score: number }>> {
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
  
  try {
    const result = await db
      .prepare(`
        SELECT 
          date(time, 'unixepoch') as date,
          COUNT(*) as count,
          ROUND(COALESCE(AVG(score), 0), 1) as avg_score
        FROM items 
        WHERE type = 'story' AND deleted = 0 AND time > ?
        GROUP BY date
        ORDER BY date DESC
      `)
      .bind(cutoff)
      .all<{ date: string; count: number; avg_score: number }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get posts by date', 'get_posts_by_date', error);
  }
}

export interface ViralPost {
  id: number;
  title: string | null;
  by: string | null;
  current_score: number;
  first_score: number;
  peak_score: number;
  score_growth: number;
  snapshot_count: number;
  hours_tracked: number;
}

/**
 * Get viral posts - items with highest score growth from snapshots
 */
export async function getViralPosts(
  db: D1Database,
  limit: number = 10
): Promise<ViralPost[]> {
  try {
    const result = await db
      .prepare(`
        SELECT 
          i.id,
          i.title,
          i.by,
          i.score as current_score,
          MIN(s.score) as first_score,
          MAX(s.score) as peak_score,
          (MAX(s.score) - MIN(s.score)) as score_growth,
          COUNT(s.id) as snapshot_count,
          ROUND((MAX(s.captured_at) - MIN(s.captured_at)) / 3600000.0, 1) as hours_tracked
        FROM items i
        JOIN item_snapshots s ON i.id = s.item_id
        WHERE i.deleted = 0 AND i.type = 'story' AND s.score IS NOT NULL
        GROUP BY i.id
        HAVING snapshot_count > 1 AND score_growth > 0
        ORDER BY score_growth DESC
        LIMIT ?
      `)
      .bind(limit)
      .all<ViralPost>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get viral posts', 'get_viral_posts', error);
  }
}

/**
 * Get domain statistics - most posted domains
 */
export async function getTopDomains(
  db: D1Database,
  limit: number = 20
): Promise<Array<{ domain: string; count: number; avg_score: number; total_score: number }>> {
  try {
    // SQLite doesn't have great URL parsing, so we extract domain with substr/instr
    const result = await db
      .prepare(`
        SELECT 
          CASE 
            WHEN url LIKE 'https://%' THEN 
              SUBSTR(url, 9, 
                CASE 
                  WHEN INSTR(SUBSTR(url, 9), '/') > 0 THEN INSTR(SUBSTR(url, 9), '/') - 1
                  ELSE LENGTH(SUBSTR(url, 9))
                END
              )
            WHEN url LIKE 'http://%' THEN 
              SUBSTR(url, 8, 
                CASE 
                  WHEN INSTR(SUBSTR(url, 8), '/') > 0 THEN INSTR(SUBSTR(url, 8), '/') - 1
                  ELSE LENGTH(SUBSTR(url, 8))
                END
              )
            ELSE url
          END as domain,
          COUNT(*) as count,
          ROUND(COALESCE(AVG(score), 0), 1) as avg_score,
          COALESCE(SUM(score), 0) as total_score
        FROM items 
        WHERE type = 'story' AND deleted = 0 AND url IS NOT NULL AND url != ''
        GROUP BY domain
        HAVING count >= 2
        ORDER BY count DESC
        LIMIT ?
      `)
      .bind(limit)
      .all<{ domain: string; count: number; avg_score: number; total_score: number }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get top domains', 'get_top_domains', error);
  }
}

/**
 * Get overall archive statistics summary
 */
export async function getDetailedStats(db: D1Database): Promise<{
  total_stories: number;
  total_comments: number;
  total_authors: number;
  avg_story_score: number;
  avg_comments_per_story: number;
  total_snapshots: number;
  oldest_item_time: number | null;
  newest_item_time: number | null;
}> {
  try {
    const result = await db
      .prepare(`
        SELECT 
          (SELECT COUNT(*) FROM items WHERE type = 'story') as total_stories,
          (SELECT COUNT(*) FROM items WHERE type = 'comment') as total_comments,
          (SELECT COUNT(DISTINCT by) FROM items WHERE by IS NOT NULL) as total_authors,
          (SELECT ROUND(COALESCE(AVG(score), 0), 1) FROM items WHERE type = 'story') as avg_story_score,
          (SELECT ROUND(COALESCE(AVG(descendants), 0), 1) FROM items WHERE type = 'story') as avg_comments_per_story,
          (SELECT COUNT(*) FROM item_snapshots) as total_snapshots,
          (SELECT MIN(time) FROM items WHERE time IS NOT NULL) as oldest_item_time,
          (SELECT MAX(time) FROM items WHERE time IS NOT NULL) as newest_item_time
      `)
      .first<{
        total_stories: number;
        total_comments: number;
        total_authors: number;
        avg_story_score: number;
        avg_comments_per_story: number;
        total_snapshots: number;
        oldest_item_time: number | null;
        newest_item_time: number | null;
      }>();
    
    return result || {
      total_stories: 0,
      total_comments: 0,
      total_authors: 0,
      avg_story_score: 0,
      avg_comments_per_story: 0,
      total_snapshots: 0,
      oldest_item_time: null,
      newest_item_time: null
    };
  } catch (error) {
    throw new DatabaseError('Failed to get detailed stats', 'get_detailed_stats', error);
  }
}

// ============================================
// AI Analysis Functions
// ============================================

export interface AIAnalysisData {
  topic: string | null;
  contentType: string | null;
  sentiment: number | null;
  analyzedAt: number;
}

/**
 * Update AI analysis results for an item
 */
export async function updateItemAI(
  db: D1Database,
  itemId: number,
  analysis: AIAnalysisData
): Promise<void> {
  try {
    await db
      .prepare(`
        UPDATE items SET
          ai_topic = ?,
          ai_content_type = ?,
          ai_sentiment = ?,
          ai_analyzed_at = ?
        WHERE id = ?
      `)
      .bind(
        analysis.topic,
        analysis.contentType,
        analysis.sentiment,
        analysis.analyzedAt,
        itemId
      )
      .run();
  } catch (error) {
    throw new DatabaseError(
      `Failed to update AI analysis for item ${itemId}`,
      'update_item_ai',
      error
    );
  }
}

/**
 * Batch update AI analysis results for multiple items
 */
export async function batchUpdateItemsAI(
  db: D1Database,
  analyses: Map<number, AIAnalysisData>
): Promise<number> {
  if (analyses.size === 0) return 0;
  
  const statements: D1PreparedStatement[] = [];
  
  for (const [itemId, analysis] of analyses) {
    statements.push(
      db.prepare(`
        UPDATE items SET
          ai_topic = ?,
          ai_content_type = ?,
          ai_sentiment = ?,
          ai_analyzed_at = ?
        WHERE id = ?
      `)
        .bind(
          analysis.topic,
          analysis.contentType,
          analysis.sentiment,
          analysis.analyzedAt,
          itemId
        )
    );
  }
  
  await db.batch(statements);
  return analyses.size;
}

/**
 * Get items that haven't been analyzed by AI yet
 */
export async function getItemsNeedingAIAnalysis(
  db: D1Database,
  limit: number = 50
): Promise<Array<{ id: number; title: string; url: string | null; type: string }>> {
  try {
    const result = await db
      .prepare(`
        SELECT id, title, url, type
        FROM items
        WHERE type = 'story' 
          AND title IS NOT NULL 
          AND ai_analyzed_at IS NULL
          AND deleted = 0
        ORDER BY first_seen_at DESC
        LIMIT ?
      `)
      .bind(limit)
      .all<{ id: number; title: string; url: string | null; type: string }>();
    
    return result.results || [];
  } catch (error) {
    throw new DatabaseError('Failed to get items needing AI analysis', 'get_items_needing_ai', error);
  }
}

/**
 * Get AI analysis statistics
 */
export async function getAIAnalysisStats(db: D1Database): Promise<{
  total_analyzed: number;
  total_pending: number;
  topics: Array<{ topic: string; count: number }>;
  content_types: Array<{ content_type: string; count: number }>;
  avg_sentiment: number;
}> {
  try {
    const [statsResult, topicsResult, contentTypesResult] = await Promise.all([
      db.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM items WHERE ai_analyzed_at IS NOT NULL) as total_analyzed,
          (SELECT COUNT(*) FROM items WHERE type = 'story' AND ai_analyzed_at IS NULL AND deleted = 0 AND title IS NOT NULL) as total_pending,
          (SELECT ROUND(AVG(ai_sentiment), 3) FROM items WHERE ai_sentiment IS NOT NULL) as avg_sentiment
      `).first<{ total_analyzed: number; total_pending: number; avg_sentiment: number }>(),
      
      db.prepare(`
        SELECT ai_topic as topic, COUNT(*) as count
        FROM items
        WHERE ai_topic IS NOT NULL
        GROUP BY ai_topic
        ORDER BY count DESC
      `).all<{ topic: string; count: number }>(),
      
      db.prepare(`
        SELECT ai_content_type as content_type, COUNT(*) as count
        FROM items
        WHERE ai_content_type IS NOT NULL
        GROUP BY ai_content_type
        ORDER BY count DESC
      `).all<{ content_type: string; count: number }>(),
    ]);
    
    return {
      total_analyzed: statsResult?.total_analyzed || 0,
      total_pending: statsResult?.total_pending || 0,
      topics: topicsResult.results || [],
      content_types: contentTypesResult.results || [],
      avg_sentiment: statsResult?.avg_sentiment || 0.5,
    };
  } catch (error) {
    throw new DatabaseError('Failed to get AI analysis stats', 'get_ai_analysis_stats', error);
  }
}
