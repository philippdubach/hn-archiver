/**
 * Main Worker Entry Point
 * Routes cron triggers and HTTP requests to appropriate handlers
 * Provides monitoring and health check endpoints
 */

import type { WorkerEnv, StatsResponse, HealthResponse } from './types';
import { runDiscovery } from './workers/discovery';
import { runUpdateTracker } from './workers/update-tracker';
import { runBackfill } from './workers/backfill';
import { getArchiveStats, cleanupOldErrors, cleanupOldMetrics } from './db';
import { getCurrentTimestampMs } from './utils';

/**
 * Scheduled event handler - routes cron triggers to appropriate workers
 */
export default {
  async scheduled(
    event: ScheduledEvent,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    const cron = event.cron;
    console.log(`[Worker] Scheduled event triggered: ${cron}`);
    
    try {
      // Route to appropriate worker based on cron schedule
      if (cron === '*/5 * * * *') {
        // Discovery worker - every 5 minutes
        const result = await runDiscovery(env);
        console.log(`[Worker] Discovery completed:`, result);
      } else if (cron === '*/10 * * * *') {
        // Update tracker - every 10 minutes
        const result = await runUpdateTracker(env);
        console.log(`[Worker] Update tracker completed:`, result);
      } else if (cron === '0 */6 * * *') {
        // Backfill worker - every 6 hours
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
    ctx: ExecutionContext
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
        const stats = await getArchiveStats(env.DB);
        const now = getCurrentTimestampMs();
        
        // Determine health status based on last run times
        const timeSinceDiscovery = now - stats.last_discovery;
        const timeSinceUpdates = now - stats.last_update_check;
        
        let status: HealthResponse['status'] = 'healthy';
        if (timeSinceDiscovery > 10 * 60 * 1000 || timeSinceUpdates > 20 * 60 * 1000) {
          status = 'degraded';
        }
        if (timeSinceDiscovery > 30 * 60 * 1000) {
          status = 'unhealthy';
        }
        
        const health: HealthResponse = {
          status,
          timestamp: now,
          database: 'connected',
          last_run: {
            discovery: stats.last_discovery,
            updates: stats.last_update_check,
            backfill: stats.last_backfill,
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

      // Manual trigger endpoints (useful for testing)
      if (path === '/trigger/discovery') {
        const result = await runDiscovery(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
          status: result.success ? 200 : 500,
        });
      }

      if (path === '/trigger/updates') {
        const result = await runUpdateTracker(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
          status: result.success ? 200 : 500,
        });
      }

      if (path === '/trigger/backfill') {
        const result = await runBackfill(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
          status: result.success ? 200 : 500,
        });
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
            trigger_discovery: '/trigger/discovery',
            trigger_updates: '/trigger/updates',
            trigger_backfill: '/trigger/backfill',
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
