/**
 * Main Worker Entry Point
 * Routes cron triggers and HTTP requests to appropriate handlers
 * Provides monitoring and health check endpoints
 */

import type { WorkerEnv, StatsResponse, HealthResponse } from './types';
import { Config, BudgetLimits } from './types';
import { runDiscovery } from './workers/discovery';
import { runUpdateTracker } from './workers/update-tracker';
import { runBackfill } from './workers/backfill';
import {
  getArchiveStats,
  cleanupOldErrors,
  cleanupOldMetrics,
  getItems,
  getItemWithSnapshots,
  getRecentMetrics,
  getTypeDistribution,
  getSnapshotReasons,
  getTopItems,
  getTopAuthors,
  getSuccessfulAuthors,
  getPostsByHour,
  getPostsByDayOfWeek,
  getPostsByDate,
  getViralPosts,
  getTopDomains,
  getDetailedStats,
  getAIAnalysisStats,
  getItemsNeedingAIAnalysis,
  batchUpdateItemsAI,
  getTopicPerformance,
  getContentTypePerformance,
  getSentimentDistribution,
  getSentimentByTopic,
  getTopPostsBySentiment,
  getStoryForSimilarity,
  getStoriesByIds,
  incrementUsageCounter,
  getUsageStats,
  checkUsageLimits,
  getEmbeddingCoverage,
  getTopicClusterStats,
  getCachedAnalytics,
  setCachedAnalytics,
  getSampleStoriesPerTopic,
} from './db';
import { getCurrentTimestampMs } from './utils';
import { batchAnalyzeStories, generateEmbedding } from './ai-analysis';

/**
 * Scheduled event handler - routes cron triggers to appropriate workers
 */
export default {
  async scheduled(
    event: ScheduledEvent,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    const cron = event.cron;
    console.log(`[Worker] Scheduled event triggered: ${cron}`);
    
    try {
      // Route to appropriate worker based on cron schedule
      // Schedules defined in wrangler.toml: */3, */10, 0 */2
      if (cron === '*/3 * * * *') {
        // Discovery worker - every 3 minutes
        const result = await runDiscovery(env);
        console.log(`[Worker] Discovery completed:`, result);
      } else if (cron === '*/10 * * * *') {
        // Update tracker - every 10 minutes
        const result = await runUpdateTracker(env);
        console.log(`[Worker] Update tracker completed:`, result);
      } else if (cron === '0 */2 * * *') {
        // Backfill worker - every 2 hours
        const result = await runBackfill(env);
        console.log(`[Worker] Backfill completed:`, result);
        
        // Also run cleanup on backfill schedule (every 6 hours)
        const errorsDeleted = await cleanupOldErrors(env.DB);
        const metricsDeleted = await cleanupOldMetrics(env.DB);
        console.log(`[Worker] Cleanup: ${errorsDeleted} errors, ${metricsDeleted} metrics deleted`);
      } else {
        console.warn(`[Worker] Unknown cron schedule: ${cron}`);
      }
    } catch (error) {
      console.error(`[Worker] Scheduled event failed:`, error);
      // Don't throw - let Worker complete even if there's an error
    }
  },

  /**
   * HTTP request handler - provides API endpoints for monitoring and manual triggers
   */
  async fetch(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for browser access - restrict to our domain only
    const allowedOrigins = [
      'https://hn-archiver.philippd.workers.dev',
      'http://localhost:8787', // Local development
    ];
    const origin = request.headers.get('Origin');
    const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle OPTIONS for CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check endpoint
      if (path === '/health' || path === '/') {
        let dbStatus: 'connected' | 'error' = 'connected';
        let stats: Awaited<ReturnType<typeof getArchiveStats>> | null = null;
        
        try {
          stats = await getArchiveStats(env.DB);
        } catch (e) {
          console.error('[Worker] Health check DB query failed:', e);
          dbStatus = 'error';
        }
        
        const now = getCurrentTimestampMs();
        
        // Determine health status based on last run times and DB status
        let status: HealthResponse['status'] = 'healthy';
        
        if (dbStatus === 'error') {
          status = 'unhealthy';
        } else if (stats) {
          const timeSinceDiscovery = now - stats.last_discovery;
          const timeSinceUpdates = now - stats.last_update_check;
          
          if (timeSinceDiscovery > Config.HEALTH_DEGRADED_DISCOVERY_MS || 
              timeSinceUpdates > Config.HEALTH_DEGRADED_UPDATES_MS) {
            status = 'degraded';
          }
          if (timeSinceDiscovery > Config.HEALTH_UNHEALTHY_DISCOVERY_MS) {
            status = 'unhealthy';
          }
        }
        
        const health: HealthResponse = {
          status,
          timestamp: now,
          database: dbStatus,
          last_run: {
            discovery: stats?.last_discovery || 0,
            updates: stats?.last_update_check || 0,
            backfill: stats?.last_backfill || 0,
          },
        };
        
        return new Response(JSON.stringify(health, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        });
      }

      // Statistics endpoint
      if (path === '/stats') {
        const stats = await getArchiveStats(env.DB);
        const response: StatsResponse = {
          ...stats,
          timestamp: getCurrentTimestampMs(),
        };
        
        return new Response(JSON.stringify(response, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        });
      }

      // ============================================
      // Frontend API Endpoints
      // ============================================

      // Paginated items list
      if (path === '/api/items') {
        const limitParam = parseInt(url.searchParams.get('limit') || '50');
        const offsetParam = parseInt(url.searchParams.get('offset') || '0');
        const limit = Math.min(isNaN(limitParam) ? 50 : limitParam, 100);
        const offset = isNaN(offsetParam) ? 0 : Math.max(0, offsetParam);
        const type = url.searchParams.get('type') || undefined;
        const orderBy = (url.searchParams.get('orderBy') || 'time') as 'time' | 'score' | 'descendants';
        const order = (url.searchParams.get('order') || 'desc') as 'asc' | 'desc';
        const sinceParam = url.searchParams.get('since');
        const sinceParsed = sinceParam ? parseInt(sinceParam) : undefined;
        // Validate since is a reasonable Unix timestamp (after year 2000, not in far future)
        const since = sinceParsed && !isNaN(sinceParsed) && sinceParsed > 946684800 && sinceParsed < Date.now() / 1000 + 86400 
          ? sinceParsed 
          : undefined;

        const result = await getItems(env.DB, { limit, offset, type, orderBy, order, since });
        
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Single item with snapshots
      if (path.startsWith('/api/item/')) {
        const idStr = path.replace('/api/item/', '');
        const itemId = parseInt(idStr);
        
        // Validate item ID is a reasonable number (positive, not exceeding HN's ID space)
        // HN IDs are sequential integers, currently around 42 million as of 2024
        const MAX_REASONABLE_ID = 100_000_000; // 100 million, plenty of headroom
        if (isNaN(itemId) || itemId < 1 || itemId > MAX_REASONABLE_ID) {
          return new Response(JSON.stringify({ error: 'Invalid item ID' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const result = await getItemWithSnapshots(env.DB, itemId);
        
        if (!result.item) {
          return new Response(JSON.stringify({ error: 'Item not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Worker metrics
      if (path === '/api/metrics') {
        const limitParam = parseInt(url.searchParams.get('limit') || '50');
        const limit = Math.min(isNaN(limitParam) ? 50 : limitParam, 100);
        const metrics = await getRecentMetrics(env.DB, limit);
        
        return new Response(JSON.stringify(metrics), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Analytics data
      if (path === '/api/analytics') {
        const [typeDistribution, snapshotReasons, topByScore, topByComments] = await Promise.all([
          getTypeDistribution(env.DB),
          getSnapshotReasons(env.DB),
          getTopItems(env.DB, 'score', 10),
          getTopItems(env.DB, 'descendants', 10),
        ]);
        
        return new Response(JSON.stringify({
          typeDistribution,
          snapshotReasons,
          topByScore,
          topByComments,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Advanced analytics data
      if (path === '/api/advanced-analytics') {
        const [
          detailedStats,
          topAuthors,
          successfulAuthors,
          postsByHour,
          postsByDayOfWeek,
          postsByDate,
          viralPosts,
          topDomains,
        ] = await Promise.all([
          getDetailedStats(env.DB),
          getTopAuthors(env.DB, 15),
          getSuccessfulAuthors(env.DB, 15),
          getPostsByHour(env.DB),
          getPostsByDayOfWeek(env.DB),
          getPostsByDate(env.DB, 30),
          getViralPosts(env.DB, 10),
          getTopDomains(env.DB, 15),
        ]);
        
        return new Response(JSON.stringify({
          detailedStats,
          topAuthors,
          successfulAuthors,
          postsByHour,
          postsByDayOfWeek,
          postsByDate,
          viralPosts,
          topDomains,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // AI analysis statistics
      if (path === '/api/ai-analytics') {
        const aiStats = await getAIAnalysisStats(env.DB);
        
        return new Response(JSON.stringify(aiStats), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Extended AI analytics with performance data
      if (path === '/api/ai-analytics-extended') {
        const [
          basicStats,
          topicPerformance,
          contentTypePerformance,
          sentimentDistribution,
          sentimentByTopic,
          topPostsBySentiment,
        ] = await Promise.all([
          getAIAnalysisStats(env.DB),
          getTopicPerformance(env.DB),
          getContentTypePerformance(env.DB),
          getSentimentDistribution(env.DB),
          getSentimentByTopic(env.DB),
          getTopPostsBySentiment(env.DB, 5),
        ]);
        
        return new Response(JSON.stringify({
          ...basicStats,
          topic_performance: topicPerformance,
          content_type_performance: contentTypePerformance,
          sentiment_distribution: sentimentDistribution,
          sentiment_by_topic: sentimentByTopic,
          top_posts_by_sentiment: topPostsBySentiment,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Embedding analytics endpoint - coverage, topic clusters, similarity matrix
      if (path === '/api/embedding-analytics') {
        const [
          embeddingCoverage,
          topicClusters,
          cachedSimilarity,
        ] = await Promise.all([
          getEmbeddingCoverage(env.DB),
          getTopicClusterStats(env.DB),
          getCachedAnalytics(env.DB, 'topic_similarity_matrix'),
        ]);

        // Get vectorize info if available
        let vectorizeInfo = null;
        if (env.VECTORIZE) {
          try {
            const info = await env.VECTORIZE.describe();
            vectorizeInfo = {
              dimensions: info.dimensions,
              vectorCount: info.vectorCount,
            };
          } catch (e) {
            console.error('[Worker] Failed to get Vectorize info:', e);
          }
        }
        
        return new Response(JSON.stringify({
          embedding_coverage: embeddingCoverage,
          topic_clusters: topicClusters,
          topic_similarity: cachedSimilarity ? {
            matrix: cachedSimilarity.data,
            computed_at: cachedSimilarity.computed_at,
          } : null,
          vectorize: vectorizeInfo,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Compute topic similarity matrix (expensive - run daily via trigger)
      if (path === '/api/compute-topic-similarity') {
        // This endpoint computes and caches topic similarity matrix
        // Should be triggered once daily to stay within Vectorize query limits
        const triggerSecret = env.TRIGGER_SECRET;
        if (triggerSecret) {
          const authHeader = request.headers.get('Authorization');
          if (!authHeader || authHeader !== `Bearer ${triggerSecret}`) {
            return new Response(
              JSON.stringify({ error: 'Unauthorized' }),
              { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }
        }

        if (!env.VECTORIZE) {
          return new Response(JSON.stringify({ error: 'Vectorize not configured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Check budget - this uses many queries
        const limitCheck = await checkUsageLimits(env.DB, 'vectorize_query');
        if (!limitCheck.allowed) {
          return new Response(JSON.stringify({ 
            error: 'Rate limit', 
            message: limitCheck.reason 
          }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        try {
          // Get sample stories per topic (3 per topic to compute average similarity)
          const samplesByTopic = await getSampleStoriesPerTopic(env.DB, 3);
          const topics = Array.from(samplesByTopic.keys());
          
          if (topics.length < 2) {
            return new Response(JSON.stringify({ 
              error: 'Not enough topics with embeddings',
              topics_found: topics.length
            }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }

          // Get embeddings for all sample stories
          const allStoryIds = Array.from(samplesByTopic.values()).flat().map(s => String(s.id));
          const vectors = await env.VECTORIZE.getByIds(allStoryIds);
          const vectorMap = new Map(vectors.map(v => [v.id, v.values]));

          // Compute average embedding per topic
          const topicEmbeddings = new Map<string, number[]>();
          for (const [topic, stories] of samplesByTopic) {
            const embeddings = stories
              .map(s => vectorMap.get(String(s.id)))
              .filter((v): v is number[] => v !== undefined);
            
            if (embeddings.length > 0) {
              // Average the embeddings
              const avg = embeddings[0].map((_, i) => 
                embeddings.reduce((sum, e) => sum + e[i], 0) / embeddings.length
              );
              topicEmbeddings.set(topic, avg);
            }
          }

          // Compute pairwise cosine similarity between topic centroids
          const similarityMatrix: Record<string, Record<string, number>> = {};
          const topicsWithEmbeddings = Array.from(topicEmbeddings.keys());
          
          for (const topic1 of topicsWithEmbeddings) {
            similarityMatrix[topic1] = {};
            const vec1 = topicEmbeddings.get(topic1)!;
            
            for (const topic2 of topicsWithEmbeddings) {
              const vec2 = topicEmbeddings.get(topic2)!;
              // Cosine similarity
              const dotProduct = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
              const mag1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0));
              const mag2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0));
              const similarity = mag1 && mag2 ? dotProduct / (mag1 * mag2) : 0;
              similarityMatrix[topic1][topic2] = Math.round(similarity * 100) / 100;
            }
          }

          // Track query usage (we did 1 getByIds call)
          const today = new Date().toISOString().split('T')[0];
          await incrementUsageCounter(env.DB, `vectorize_queries_${today}`, 1);

          // Cache the result
          await setCachedAnalytics(env.DB, 'topic_similarity_matrix', similarityMatrix);

          return new Response(JSON.stringify({
            success: true,
            topics: topicsWithEmbeddings.length,
            matrix: similarityMatrix,
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });

        } catch (error) {
          console.error('[Worker] Topic similarity computation failed:', error);
          return new Response(JSON.stringify({ 
            error: 'Computation failed',
            message: error instanceof Error ? error.message : String(error),
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }

      // ============================================
      // Similarity Search API
      // ============================================

      // Find similar posts using Vectorize
      if (path.startsWith('/api/similar/')) {
        const idStr = path.replace('/api/similar/', '');
        const itemId = parseInt(idStr);
        
        // Validate item ID
        const MAX_REASONABLE_ID = 100_000_000;
        if (isNaN(itemId) || itemId < 1 || itemId > MAX_REASONABLE_ID) {
          return new Response(JSON.stringify({ error: 'Invalid item ID' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Check if Vectorize is available
        if (!env.VECTORIZE || !env.AI) {
          return new Response(JSON.stringify({ 
            error: 'Similarity search not available',
            message: 'Vectorize or AI binding not configured'
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Require authentication for similarity search (protects Vectorize quota)
        const triggerSecret = env.TRIGGER_SECRET;
        if (triggerSecret) {
          const authHeader = request.headers.get('Authorization');
          if (!authHeader || authHeader !== `Bearer ${triggerSecret}`) {
            return new Response(
              JSON.stringify({ error: 'Unauthorized', message: 'Similarity search requires authentication' }),
              { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }
        }

        // Check budget limits before querying
        const limitCheck = await checkUsageLimits(env.DB, 'vectorize_query');
        if (!limitCheck.allowed) {
          return new Response(JSON.stringify({ 
            error: 'Rate limit exceeded',
            message: limitCheck.reason
          }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Get the source story
        const story = await getStoryForSimilarity(env.DB, itemId);
        if (!story) {
          return new Response(JSON.stringify({ error: 'Story not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const limitParam = parseInt(url.searchParams.get('limit') || '5');
        const limit = Math.min(Math.max(1, isNaN(limitParam) ? 5 : limitParam), 10);

        try {
          let queryVector: number[];
          
          // If the story has an embedding, use queryById (cheaper)
          // Otherwise, generate embedding on the fly
          if (story.embedding_generated_at) {
            // Query by ID - most efficient
            const vectors = await env.VECTORIZE.getByIds([String(itemId)]);
            if (vectors.length === 0 || !vectors[0].values) {
              // Embedding missing from Vectorize, generate on the fly
              const embedding = await generateEmbedding(env.AI, story.title);
              if (!embedding) {
                return new Response(JSON.stringify({ 
                  error: 'Failed to generate embedding',
                  similar: []
                }), {
                  status: 500,
                  headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
              }
              queryVector = embedding;
            } else {
              queryVector = vectors[0].values;
            }
          } else {
            // Generate embedding on the fly for stories without one
            const embedding = await generateEmbedding(env.AI, story.title);
            if (!embedding) {
              return new Response(JSON.stringify({ 
                error: 'Failed to generate embedding',
                similar: []
              }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
            queryVector = embedding;
          }

          // Query for similar vectors (add 1 to exclude self if it's in the index)
          const matches = await env.VECTORIZE.query(queryVector, {
            topK: limit + 1,
            returnMetadata: 'all',
          });

          // Track usage (768 dimensions per query)
          const today = new Date().toISOString().split('T')[0];
          const month = today.slice(0, 7);
          await Promise.all([
            incrementUsageCounter(env.DB, `vectorize_queries_${today}`, 1),
            incrementUsageCounter(env.DB, `vectorize_queries_${month}`, 1),
          ]);

          // Filter out the source story and get top results
          const similarIds = matches.matches
            .filter(m => m.id !== String(itemId))
            .slice(0, limit)
            .map(m => ({
              id: parseInt(m.id),
              score: m.score,
              metadata: m.metadata,
            }));

          // Enrich with full story data from D1
          const storyIds = similarIds.map(s => s.id);
          const stories = await getStoriesByIds(env.DB, storyIds);
          const storyMap = new Map(stories.map(s => [s.id, s]));

          const similar = similarIds.map(match => {
            const storyData = storyMap.get(match.id);
            return {
              id: match.id,
              similarity: match.score,
              title: storyData?.title || (match.metadata?.title as string) || '[unknown]',
              url: storyData?.url || null,
              score: storyData?.score || (match.metadata?.score as number) || 0,
              by: storyData?.by || null,
              time: storyData?.time || 0,
              topic: storyData?.ai_topic || (match.metadata?.topic as string) || null,
            };
          });

          return new Response(JSON.stringify({
            source: {
              id: itemId,
              title: story.title,
            },
            similar,
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });

        } catch (error) {
          console.error('[Worker] Similarity search failed:', error);
          return new Response(JSON.stringify({ 
            error: 'Similarity search failed',
            message: error instanceof Error ? error.message : String(error),
            similar: []
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }

      // Usage statistics for budget monitoring
      if (path === '/api/usage') {
        const usage = await getUsageStats(env.DB);
        
        // Get Vectorize index info if available
        let vectorizeInfo = null;
        if (env.VECTORIZE) {
          try {
            const info = await env.VECTORIZE.describe();
            vectorizeInfo = {
              dimensions: info.dimensions,
              vectorCount: info.vectorCount,
            };
          } catch (e) {
            console.error('[Worker] Failed to get Vectorize info:', e);
          }
        }
        
        return new Response(JSON.stringify({
          usage: {
            vectorize_queries_today: usage.vectorize_queries_today,
            vectorize_queries_month: usage.vectorize_queries_month,
            embeddings_stored: usage.embeddings_stored,
            d1_reads_today: usage.d1_reads_today,
          },
          limits: {
            vectorize_queries_per_day: BudgetLimits.VECTORIZE_QUERIES_PER_DAY,
            vectorize_max_stored: BudgetLimits.VECTORIZE_MAX_STORED_VECTORS,
            embedding_batch_size: BudgetLimits.EMBEDDING_BATCH_SIZE,
          },
          vectorize: vectorizeInfo,
          warnings: [
            usage.vectorize_queries_today > BudgetLimits.VECTORIZE_QUERIES_PER_DAY * 0.8 
              ? `Vectorize queries at ${Math.round(usage.vectorize_queries_today / BudgetLimits.VECTORIZE_QUERIES_PER_DAY * 100)}% of daily limit` 
              : null,
            usage.embeddings_stored > BudgetLimits.VECTORIZE_MAX_STORED_VECTORS * 0.8 
              ? `Stored vectors at ${Math.round(usage.embeddings_stored / BudgetLimits.VECTORIZE_MAX_STORED_VECTORS * 100)}% of limit` 
              : null,
          ].filter(Boolean),
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Manual trigger endpoints (useful for testing)
      // Protected by TRIGGER_SECRET environment variable
      if (path.startsWith('/trigger/')) {
        const triggerSecret = env.TRIGGER_SECRET;
        if (!triggerSecret) {
          console.warn('[Worker] TRIGGER_SECRET not configured - trigger endpoints are unprotected!');
        }
        if (triggerSecret) {
          const authHeader = request.headers.get('Authorization');
          if (!authHeader || authHeader !== `Bearer ${triggerSecret}`) {
            return new Response(
              JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing Authorization header' }),
              {
                status: 401,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              }
            );
          }
        }
        
        // Auth passed (or no secret configured) - handle trigger routes
        if (path === '/trigger/discovery') {
          const result = await runDiscovery(env);
          return new Response(JSON.stringify(result, null, 2), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            status: result.success ? 200 : 500,
          });
        }

        if (path === '/trigger/updates') {
          const result = await runUpdateTracker(env);
          return new Response(JSON.stringify(result, null, 2), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            status: result.success ? 200 : 500,
          });
        }

        if (path === '/trigger/backfill') {
          const result = await runBackfill(env);
          return new Response(JSON.stringify(result, null, 2), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            status: result.success ? 200 : 500,
          });
        }

        // Dedicated AI backfill endpoint - analyzes unanalyzed stories
        if (path === '/trigger/ai-backfill') {
          if (!env.AI) {
            return new Response(JSON.stringify({ error: 'AI binding not configured' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          
          const startTime = getCurrentTimestampMs();
          let itemsAnalyzed = 0;
          let error: string | null = null;
          
          try {
            // Get up to 50 unanalyzed stories
            const unanalyzedStories = await getItemsNeedingAIAnalysis(env.DB, 50);
            
            if (unanalyzedStories.length > 0) {
              const storiesToAnalyze = unanalyzedStories.map(s => ({
                id: s.id,
                type: s.type as 'story',
                title: s.title,
                url: s.url || undefined,
                time: 0,
              }));
              
              const aiResults = await batchAnalyzeStories(env.AI, storiesToAnalyze, 50);
              
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
              }
            }
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          
          const duration = getCurrentTimestampMs() - startTime;
          
          return new Response(JSON.stringify({
            success: error === null,
            items_analyzed: itemsAnalyzed,
            duration_ms: duration,
            error,
          }, null, 2), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            status: error ? 500 : 200,
          });
        }
      }

      // Default response
      return new Response(
        JSON.stringify({
          name: 'HackerNews Archiver',
          version: '1.0.0',
          status: 'running',
          endpoints: {
            health: '/',
            stats: '/stats',
            api_items: '/api/items?limit=50&offset=0&type=story&orderBy=time&order=desc',
            api_item: '/api/item/:id',
            api_similar: '/api/similar/:id?limit=5',
            api_usage: '/api/usage',
            api_metrics: '/api/metrics',
            api_analytics: '/api/analytics',
            api_advanced_analytics: '/api/advanced-analytics',
            api_ai_analytics: '/api/ai-analytics',
            api_ai_analytics_extended: '/api/ai-analytics-extended',
            api_embedding_analytics: '/api/embedding-analytics',
            api_compute_topic_similarity: '/api/compute-topic-similarity (auth required)',
            trigger_discovery: '/trigger/discovery',
            trigger_updates: '/trigger/updates',
            trigger_backfill: '/trigger/backfill',
            trigger_ai_backfill: '/trigger/ai-backfill',
          },
        }, null, 2),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );

    } catch (error) {
      console.error('[Worker] HTTP request failed:', error);
      
      // Don't expose internal error details to clients
      return new Response(
        JSON.stringify({
          error: 'Internal server error',
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }
  },
};
