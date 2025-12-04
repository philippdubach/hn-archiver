/**
 * Embedding Backfill Worker
 * Generates embeddings for stories that have AI analysis but no embeddings yet
 * Runs as part of backfill cycle with strict budget controls
 * 
 * Budget constraints (paid plan included limits):
 * - Vectorize: 50M queried dimensions/month, 10M stored dimensions
 * - At 768 dimensions/vector: ~13k vectors max stored
 * - Rate limited to 50 embeddings per run to stay safe
 */

import type { WorkerEnv, WorkerResult } from '../types';
import { BudgetLimits } from '../types';
import { 
  getStoriesNeedingEmbeddings, 
  markEmbeddingsGenerated, 
  incrementUsageCounter,
  checkUsageLimits,
  recordMetrics,
  logError 
} from '../db';
import { batchGenerateEmbeddings } from '../ai-analysis';
import { getCurrentTimestampMs } from '../utils';

/**
 * Main embedding backfill entry point
 * Called from backfill worker after regular backfill completes
 */
export async function runEmbeddingBackfill(env: WorkerEnv): Promise<WorkerResult> {
  const startTime = getCurrentTimestampMs();
  const workerType = 'embedding-backfill';
  
  let itemsProcessed = 0;
  let itemsChanged = 0;
  let errors = 0;
  const errorMessages: string[] = [];
  
  try {
    console.log('[EmbeddingBackfill] Starting embedding backfill run');
    
    // Check budget limits before proceeding
    const limitCheck = await checkUsageLimits(env.DB, 'embedding_backfill');
    if (!limitCheck.allowed) {
      console.log(`[EmbeddingBackfill] Skipping due to budget limits: ${limitCheck.reason}`);
      
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
        error_messages: [limitCheck.reason || 'Budget limit reached'],
      };
    }
    
    // Get stories that need embeddings (have AI analysis but no embedding)
    const stories = await getStoriesNeedingEmbeddings(
      env.DB, 
      BudgetLimits.EMBEDDING_BATCH_SIZE
    );
    
    console.log(`[EmbeddingBackfill] Found ${stories.length} stories needing embeddings`);
    
    if (stories.length === 0) {
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
    
    itemsProcessed = stories.length;
    
    // Generate embeddings and upsert to Vectorize
    const result = await batchGenerateEmbeddings(
      env.AI,
      env.VECTORIZE,
      stories,
      BudgetLimits.EMBEDDING_BATCH_SIZE
    );
    
    itemsChanged = result.success;
    errors = result.failed;
    
    // Mark successful embeddings in DB
    if (result.success > 0) {
      const successIds = stories
        .slice(0, result.success)
        .map(s => s.id);
      
      await markEmbeddingsGenerated(env.DB, successIds);
      
      // Update usage counters
      await incrementUsageCounter(env.DB, 'embeddings_stored_total', result.success);
      
      console.log(`[EmbeddingBackfill] Marked ${successIds.length} items as having embeddings`);
    }
    
    const duration = getCurrentTimestampMs() - startTime;
    
    // Record metrics
    await recordMetrics(env.DB, {
      worker_type: workerType,
      items_processed: itemsProcessed,
      items_changed: itemsChanged,
      snapshots_created: 0,
      duration_ms: duration,
      errors,
    });
    
    console.log(`[EmbeddingBackfill] Completed: ${itemsProcessed} processed, ${itemsChanged} embeddings created, ${errors} failed in ${duration}ms`);
    
    return {
      success: errors === 0,
      items_processed: itemsProcessed,
      items_changed: itemsChanged,
      snapshots_created: 0,
      duration_ms: duration,
      errors,
      error_messages: errorMessages.length > 0 ? errorMessages : undefined,
    };
    
  } catch (error) {
    errors++;
    const errorMsg = `Embedding backfill failed: ${error}`;
    errorMessages.push(errorMsg);
    console.error(`[EmbeddingBackfill] ${errorMsg}`);
    
    if (error instanceof Error) {
      await logError(env.DB, workerType, error);
    }
    
    const duration = getCurrentTimestampMs() - startTime;
    
    return {
      success: false,
      items_processed: itemsProcessed,
      items_changed: itemsChanged,
      snapshots_created: 0,
      duration_ms: duration,
      errors,
      error_messages: errorMessages,
    };
  }
}
