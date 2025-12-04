/**
 * Backfill Worker
 * Refreshes stale items (not updated recently)
 * Runs every 6 hours to catch updates missed by /v0/updates endpoint
 * Also backfills AI analysis for unanalyzed stories
 * Also backfills embeddings for stories with AI analysis
 */

import type { WorkerEnv, WorkerResult, EnrichedHNItem } from '../types';
import { fetchItemsBatch } from '../hn-api';
import { batchUpsertItems, batchInsertSnapshots, getStaleItems, updateState, logError, recordMetrics, getItemsNeedingAIAnalysis, batchUpdateItemsAI } from '../db';
import { getCurrentTimestampMs } from '../utils';
import { Config } from '../types';
import { batchAnalyzeStories } from '../ai-analysis';
import { runEmbeddingBackfill } from './embedding-backfill';

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
    
    // Step 2: Fetch and process stale items using batch operations (if any)
    if (staleIds.length > 0) {
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
    } else {
      console.log('[Backfill] No stale items to process');
    }
    
    // Update state
    await updateState(env.DB, 'last_backfill_run', getCurrentTimestampMs());
    
    // Step 3: AI Analysis backfill for unanalyzed stories
    // Run after regular backfill to stay within neuron quota
    let itemsAnalyzed = 0;
    if (env.AI) {
      try {
        console.log('[Backfill] Running AI analysis backfill');
        
        // Get stories that haven't been analyzed yet (limit to 50 per run)
        const unanalyzedStories = await getItemsNeedingAIAnalysis(env.DB, 50);
        
        if (unanalyzedStories.length > 0) {
          console.log(`[Backfill] Found ${unanalyzedStories.length} unanalyzed stories`);
          
          // Convert to HNItem format for analysis
          const storiesToAnalyze = unanalyzedStories.map(s => ({
            id: s.id,
            type: s.type as 'story',
            title: s.title,
            url: s.url || undefined,
            time: 0, // Not needed for analysis
          }));
          
          const aiResults = await batchAnalyzeStories(env.AI, storiesToAnalyze, 50);
          
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
          
          if (analysisData.size > 0) {
            await batchUpdateItemsAI(env.DB, analysisData);
            itemsAnalyzed = analysisData.size;
            console.log(`[Backfill] AI analysis backfill complete: ${itemsAnalyzed} stories analyzed`);
          }
        } else {
          console.log('[Backfill] No unanalyzed stories found');
        }
      } catch (error) {
        // AI analysis failure shouldn't fail the entire backfill run
        console.error('[Backfill] AI analysis backfill failed, continuing:', error);
        errors++;
        errorMessages.push(`AI analysis backfill failed: ${error}`);
        
        if (error instanceof Error) {
          await logError(env.DB, workerType, error, { context: 'ai_backfill' });
        }
      }
    }
    
    // Step 4: Embedding backfill for stories with AI analysis
    // Generates embeddings and stores in Vectorize for similarity search
    let embeddingsCreated = 0;
    if (env.AI && env.VECTORIZE) {
      try {
        console.log('[Backfill] Running embedding backfill');
        const embeddingResult = await runEmbeddingBackfill(env);
        embeddingsCreated = embeddingResult.items_changed;
        
        if (embeddingResult.errors > 0) {
          errors += embeddingResult.errors;
          if (embeddingResult.error_messages) {
            errorMessages.push(...embeddingResult.error_messages);
          }
        }
        
        console.log(`[Backfill] Embedding backfill complete: ${embeddingsCreated} embeddings created`);
      } catch (error) {
        // Embedding failure shouldn't fail the entire backfill run
        console.error('[Backfill] Embedding backfill failed, continuing:', error);
        errors++;
        errorMessages.push(`Embedding backfill failed: ${error}`);
        
        if (error instanceof Error) {
          await logError(env.DB, workerType, error, { context: 'embedding_backfill' });
        }
      }
    }
    
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
    
    console.log(`[Backfill] Completed: ${itemsProcessed} processed, ${itemsChanged} changed, ${snapshotsCreated} snapshots, ${itemsAnalyzed} AI analyzed, ${embeddingsCreated} embeddings, ${errors} errors in ${duration}ms`);
    
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
