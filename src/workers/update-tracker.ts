/**
 * Update Tracker Worker
 * Tracks changes to existing items using HN's /v0/updates endpoint
 * Runs every 10 minutes - most efficient way to catch changes
 */

import type { WorkerEnv, WorkerResult, EnrichedHNItem } from '../types';
import { fetchUpdates, fetchTopStories, fetchItemsBatch } from '../hn-api';
import { getRecentlyUpdatedItems, updateState, logError, recordMetrics, batchUpsertItems, batchInsertSnapshots } from '../db';
import { getCurrentTimestampMs, chunk } from '../utils';
import { Config } from '../types';

/**
 * Main update tracker entry point
 * Efficiently updates changed items without polling all items
 */
export async function runUpdateTracker(env: WorkerEnv): Promise<WorkerResult> {
  const startTime = getCurrentTimestampMs();
  const workerType = 'update_tracker';
  
  let itemsProcessed = 0;
  let itemsChanged = 0;
  let snapshotsCreated = 0;
  let errors = 0;
  const errorMessages: string[] = [];
  
  try {
    console.log('[UpdateTracker] Starting update tracking run');
    
    // Step 1: Fetch recently changed items from HN
    const updates = await fetchUpdates();
    const changedIds = updates.items || [];
    
    console.log(`[UpdateTracker] Found ${changedIds.length} changed items from HN API`);
    
    if (changedIds.length === 0) {
      await updateState(env.DB, 'last_updates_check', getCurrentTimestampMs());
      
      const duration = getCurrentTimestampMs() - startTime;
      await recordMetrics(env.DB, {
        worker_type: workerType,
        items_processed: 0,
        items_changed: 0,
        snapshots_created: 0,
        duration_ms: duration,
        errors: 0,
      });
      
      console.log('[UpdateTracker] No updates to process');
      
      return {
        success: true,
        items_processed: 0,
        items_changed: 0,
        snapshots_created: 0,
        duration_ms: duration,
        errors: 0,
      };
    }
    
    // Step 2: Filter out items we just updated (avoid duplicate work)
    const recentlyUpdated = await getRecentlyUpdatedItems(
      env.DB,
      changedIds,
      Config.RECENT_UPDATE_WINDOW_MS
    );
    
    const idsToUpdate = changedIds.filter((id) => !recentlyUpdated.has(id));
    
    console.log(`[UpdateTracker] Filtered to ${idsToUpdate.length} items (${recentlyUpdated.size} recently updated)`);
    
    if (idsToUpdate.length === 0) {
      await updateState(env.DB, 'last_updates_check', getCurrentTimestampMs());
      
      const duration = getCurrentTimestampMs() - startTime;
      await recordMetrics(env.DB, {
        worker_type: workerType,
        items_processed: 0,
        items_changed: 0,
        snapshots_created: 0,
        duration_ms: duration,
        errors: 0,
      });
      
      return {
        success: true,
        items_processed: 0,
        items_changed: 0,
        snapshots_created: 0,
        duration_ms: duration,
        errors: 0,
      };
    }
    
    // Step 3: Fetch front page for prioritization
    let frontPageIds: Set<number>;
    try {
      const topStories = await fetchTopStories();
      frontPageIds = new Set(topStories);
      console.log(`[UpdateTracker] Front page has ${frontPageIds.size} stories`);
    } catch (error) {
      console.error('[UpdateTracker] Failed to fetch front page:', error);
      frontPageIds = new Set();
      errors++;
    }
    
    // Step 4: Fetch and process updated items in batches
    const batches = chunk(idsToUpdate, Config.BATCH_SIZE);
    let currentBatchNum = 0;
    
    for (const batch of batches) {
      currentBatchNum++;
      
      try {
        // Fetch batch of items in parallel
        const items = await fetchItemsBatch(batch);
        console.log(`[UpdateTracker] Batch ${currentBatchNum}/${batches.length}: Fetched ${items.length}/${batch.length} items`);
        
        // Enrich items with front page flag
        const enrichedItems: EnrichedHNItem[] = items.map(item => ({
          ...item,
          isFrontPage: frontPageIds.has(item.id),
        }));
        
        // Batch upsert all items in single transaction
        const batchResult = await batchUpsertItems(env.DB, enrichedItems);
        itemsProcessed += batchResult.processed;
        itemsChanged += batchResult.changed;
        
        // Batch insert all snapshots
        if (batchResult.snapshots.length > 0) {
          await batchInsertSnapshots(env.DB, batchResult.snapshots);
          snapshotsCreated += batchResult.snapshots.length;
        }
        
        console.log(`[UpdateTracker] Batch ${currentBatchNum}: Processed ${batchResult.processed}, changed ${batchResult.changed}, snapshots ${batchResult.snapshots.length}`);
        
      } catch (error) {
        errors++;
        const errorMsg = `Failed to process batch ${currentBatchNum}: ${error}`;
        errorMessages.push(errorMsg);
        console.error(`[UpdateTracker] ${errorMsg}`);
        
        if (error instanceof Error) {
          await logError(env.DB, workerType, error, {
            batchNum: currentBatchNum,
            batchSize: batch.length
          });
        }
        
        // Continue with next batch
        continue;
      }
    }
    
    // Update state
    await updateState(env.DB, 'last_updates_check', getCurrentTimestampMs());
    
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
    
    console.log(`[UpdateTracker] Completed: ${itemsProcessed} processed, ${itemsChanged} changed, ${snapshotsCreated} snapshots, ${errors} errors in ${duration}ms`);
    
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
    const errorMsg = `Update tracker failed: ${error}`;
    errorMessages.push(errorMsg);
    console.error(`[UpdateTracker] ${errorMsg}`);
    
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
