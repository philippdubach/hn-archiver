/**
 * Discovery Worker
 * Continuously discovers new items from HackerNews
 * Runs every 5 minutes to capture all new content
 */

import type { WorkerEnv, WorkerResult, EnrichedHNItem, HNItem } from '../types';
import { fetchMaxItemId, fetchTopStories, fetchItemsBatch } from '../hn-api';
import { getState, updateState, logError, recordMetrics, batchUpsertItems, batchInsertSnapshots, batchUpdateItemsAI } from '../db';
import { getCurrentTimestampMs, chunk } from '../utils';
import { Config } from '../types';
import { batchAnalyzeStories } from '../ai-analysis';

/**
 * Main discovery worker entry point
 * Discovers and archives new items from HackerNews
 */
export async function runDiscovery(env: WorkerEnv): Promise<WorkerResult> {
  const startTime = getCurrentTimestampMs();
  const workerType = 'discovery';
  
  let itemsProcessed = 0;
  let itemsChanged = 0;
  let snapshotsCreated = 0;
  let itemsAnalyzed = 0;
  let errors = 0;
  const errorMessages: string[] = [];
  
  try {
    console.log('[Discovery] Starting discovery run');
    
    // Step 1: Get current max item ID from HN
    const maxId = await fetchMaxItemId();
    const lastSeen = await getState(env.DB, 'max_item_id_seen');
    
    console.log(`[Discovery] Max ID: ${maxId}, Last seen: ${lastSeen}`);
    
    // If this is first run, only process recent items (last 1000)
    const startId = lastSeen === 0 ? Math.max(0, maxId - 1000) : lastSeen + 1;
    
    if (startId > maxId) {
      console.log('[Discovery] No new items to process');
      await updateState(env.DB, 'last_discovery_run', getCurrentTimestampMs());
      
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
    
    // Step 2: Fetch front page stories for prioritization
    let frontPageIds: Set<number>;
    try {
      const topStories = await fetchTopStories();
      frontPageIds = new Set(topStories);
      console.log(`[Discovery] Front page has ${frontPageIds.size} stories`);
    } catch (error) {
      console.error('[Discovery] Failed to fetch front page, continuing without it:', error);
      frontPageIds = new Set();
      errors++;
    }
    
    // Step 3: Generate list of new item IDs to fetch
    const newIds: number[] = [];
    for (let id = startId; id <= maxId; id++) {
      newIds.push(id);
    }
    
    console.log(`[Discovery] Processing ${newIds.length} new items`);
    
    // Collect all new stories for AI analysis at the end
    const newStories: HNItem[] = [];
    
    // Step 4: Fetch and process items in batches
    const batches = chunk(newIds, Config.BATCH_SIZE);
    let currentBatchNum = 0;
    
    for (const batch of batches) {
      currentBatchNum++;
      
      try {
        // Fetch batch of items in parallel
        const items = await fetchItemsBatch(batch);
        console.log(`[Discovery] Batch ${currentBatchNum}/${batches.length}: Fetched ${items.length}/${batch.length} items`);
        
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
        
        // Collect new stories for AI analysis
        const stories = items.filter(item => item.type === 'story' && item.title);
        newStories.push(...stories);
        
        console.log(`[Discovery] Batch ${currentBatchNum}: Processed ${batchResult.processed}, changed ${batchResult.changed}, snapshots ${batchResult.snapshots.length}`);
        
        // Update progress after each batch (enables resume on timeout)
        const lastIdInBatch = Math.max(...batch);
        await updateState(env.DB, 'max_item_id_seen', lastIdInBatch);
        
      } catch (error) {
        errors++;
        const errorMsg = `Failed to process batch ${currentBatchNum}: ${error}`;
        errorMessages.push(errorMsg);
        console.error(`[Discovery] ${errorMsg}`);
        
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
    
    // Step 5: AI Analysis for new stories
    // Only analyze if we have the AI binding and stories to analyze
    if (env.AI && newStories.length > 0) {
      try {
        console.log(`[Discovery] Running AI analysis on ${newStories.length} new stories`);
        
        // Limit to 50 stories per run to stay within neuron quota
        // Free tier: 10,000 neurons/day, ~55 neurons per story = ~180 stories/day
        const maxAnalysis = Math.min(newStories.length, 50);
        const storiesToAnalyze = newStories.slice(0, maxAnalysis);
        
        const aiResults = await batchAnalyzeStories(env.AI, storiesToAnalyze, maxAnalysis);
        
        // Convert to format for database update
        const analysisData = new Map<number, { topic: string | null; contentType: string | null; sentiment: number | null; analyzedAt: number }>();
        for (const [itemId, result] of aiResults) {
          analysisData.set(itemId, {
            topic: result.topic,
            contentType: result.contentType,
            sentiment: result.sentiment,
            analyzedAt: result.analyzedAt,
          });
        }
        
        // Batch update AI results
        if (analysisData.size > 0) {
          await batchUpdateItemsAI(env.DB, analysisData);
          itemsAnalyzed = analysisData.size;
          console.log(`[Discovery] AI analysis complete: ${itemsAnalyzed} stories analyzed`);
        }
        
      } catch (error) {
        // AI analysis failure shouldn't fail the entire discovery run
        console.error('[Discovery] AI analysis failed, continuing:', error);
        errors++;
        errorMessages.push(`AI analysis failed: ${error}`);
        
        if (error instanceof Error) {
          await logError(env.DB, workerType, error, { context: 'ai_analysis' });
        }
      }
    }
    
    // Update final state
    await updateState(env.DB, 'max_item_id_seen', maxId);
    await updateState(env.DB, 'last_discovery_run', getCurrentTimestampMs());
    
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
    
    console.log(`[Discovery] Completed: ${itemsProcessed} processed, ${itemsChanged} changed, ${snapshotsCreated} snapshots, ${itemsAnalyzed} AI analyzed, ${errors} errors in ${duration}ms`);
    
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
    const errorMsg = `Discovery worker failed: ${error}`;
    errorMessages.push(errorMsg);
    console.error(`[Discovery] ${errorMsg}`);
    
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
