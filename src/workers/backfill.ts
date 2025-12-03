/**
 * Backfill Worker
 * Refreshes stale items (not updated recently)
 * Runs every 6 hours to catch updates missed by /v0/updates endpoint
 */

import type { WorkerEnv, WorkerResult, EnrichedHNItem } from '../types';
import { fetchItemsBatch } from '../hn-api';
import { batchUpsertItems, batchInsertSnapshots, getStaleItems, updateState, logError, recordMetrics } from '../db';
import { getCurrentTimestampMs } from '../utils';
import { Config } from '../types';

/**
 * Main backfill worker entry point
 * Refreshes old items to catch updates that /v0/updates might have missed
 */
export async function runBackfill(env: WorkerEnv): Promise<WorkerResult> {
  const startTime = getCurrentTimestampMs();
  const workerType = 'backfill';
  
  let itemsProcessed = 0;
  let itemsChanged = 0;
  let snapshotsCreated = 0;
  let errors = 0;
  const errorMessages: string[] = [];
  
  try {
    console.log('[Backfill] Starting backfill run');
    
    // Step 1: Find stale items worth refreshing
    const staleIds = await getStaleItems(
      env.DB,
      Config.STALE_ITEM_THRESHOLD_MS,
      Config.BACKFILL_LIMIT
    );
    
    console.log(`[Backfill] Found ${staleIds.length} stale items to refresh`);
    
    if (staleIds.length === 0) {
      await updateState(env.DB, 'last_backfill_run', getCurrentTimestampMs());
      
      const duration = getCurrentTimestampMs() - startTime;
      await recordMetrics(env.DB, {
        worker_type: workerType,
        items_processed: 0,
        items_changed: 0,
        snapshots_created: 0,
        duration_ms: duration,
        errors: 0,
      });
      
      console.log('[Backfill] No stale items to process');
      
      return {
        success: true,
        items_processed: 0,
        items_changed: 0,
        snapshots_created: 0,
        duration_ms: duration,
        errors: 0,
      };
    }
    
    // Step 2: Fetch and process stale items using batch operations
    try {
      const items = await fetchItemsBatch(staleIds);
      console.log(`[Backfill] Fetched ${items.length}/${staleIds.length} items`);
      
      // Backfill items are not on front page (by definition, they're old)
      const enrichedItems: EnrichedHNItem[] = items.map(item => ({
        ...item,
        isFrontPage: false,
      }));
      
      // Batch upsert all items in single transaction
      const batchResult = await batchUpsertItems(env.DB, enrichedItems);
      itemsProcessed = batchResult.processed;
      itemsChanged = batchResult.changed;
      
      // For backfill, only create snapshots for significant score increases
      // Filter snapshots to only include score_spike reason
      const significantSnapshots = batchResult.snapshots.filter(s => s.reason === 'score_spike');
      
      if (significantSnapshots.length > 0) {
        await batchInsertSnapshots(env.DB, significantSnapshots);
        snapshotsCreated = significantSnapshots.length;
      }
      
      console.log(`[Backfill] Batch processed: ${itemsProcessed} items, ${itemsChanged} changed, ${snapshotsCreated} snapshots`);
      
    } catch (error) {
      errors++;
      const errorMsg = `Failed to process stale items: ${error}`;
      errorMessages.push(errorMsg);
      console.error(`[Backfill] ${errorMsg}`);
      
      if (error instanceof Error) {
        await logError(env.DB, workerType, error);
      }
    }
    
    // Update state
    await updateState(env.DB, 'last_backfill_run', getCurrentTimestampMs());
    
    const duration = getCurrentTimestampMs() - startTime;
    
    // Record metrics
    await recordMetrics(env.DB, {
      worker_type: workerType,
      items_processed: itemsProcessed,
      items_changed: itemsChanged,
      snapshots_created: snapshotsCreated,
      duration_ms: duration,
      errors,
    });
    
    console.log(`[Backfill] Completed: ${itemsProcessed} processed, ${itemsChanged} changed, ${snapshotsCreated} snapshots, ${errors} errors in ${duration}ms`);
    
    return {
      success: errors === 0,
      items_processed: itemsProcessed,
      items_changed: itemsChanged,
      snapshots_created: snapshotsCreated,
      duration_ms: duration,
      errors,
      error_messages: errorMessages.length > 0 ? errorMessages : undefined,
    };
    
  } catch (error) {
    errors++;
    const errorMsg = `Backfill worker failed: ${error}`;
    errorMessages.push(errorMsg);
    console.error(`[Backfill] ${errorMsg}`);
    
    if (error instanceof Error) {
      await logError(env.DB, workerType, error);
    }
    
    const duration = getCurrentTimestampMs() - startTime;
    
    return {
      success: false,
      items_processed: itemsProcessed,
      items_changed: itemsChanged,
      snapshots_created: snapshotsCreated,
      duration_ms: duration,
      errors,
      error_messages: errorMessages,
    };
  }
}
