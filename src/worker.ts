/**
 * Main Worker Entry Point
 * Routes cron triggers and HTTP requests to appropriate handlers
 * Provides monitoring and health check endpoints
 */

import type { WorkerEnv, StatsResponse, HealthResponse } from './types';
import { Config } from './types';
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
} from './db';
import { getCurrentTimestampMs } from './utils';
import { batchAnalyzeStories } from './ai-analysis';

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

    // CORS headers for browser access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

      // Manual trigger endpoints (useful for testing)
      // Protected by optional TRIGGER_SECRET environment variable
      if (path.startsWith('/trigger/')) {
        const triggerSecret = (env as any).TRIGGER_SECRET;
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
            api_metrics: '/api/metrics',
            api_analytics: '/api/analytics',
            api_advanced_analytics: '/api/advanced-analytics',
            api_ai_analytics: '/api/ai-analytics',
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
      
      return new Response(
        JSON.stringify({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error),
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
