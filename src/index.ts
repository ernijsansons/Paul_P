/**
 * Paul P - Main Entry Point
 *
 * Autonomous Prediction Market Trading System
 * Built on Cloudflare Workers + Agents SDK v6 + Durable Objects + Workflows
 *
 * System name: Paul P (production name for MoltWorker/OpenClaw)
 */

import { Hono } from 'hono';
import type { Env } from './types/env';

// Import route handlers
import { adminRoutes } from './routes/admin';
import { healthRoutes } from './routes/health';
import { webhookRoutes } from './routes/webhooks';

// Import queue consumers
import { handleIngestionQueue } from './queue/ingestion-consumer';
import { handleSignalQueue } from './queue/signal-consumer';
import { handleOrderQueue } from './queue/order-consumer';
import { handlePairingQueue } from './queue/pairing-consumer';

// Import Durable Object agent classes
export { PaulPOrchestrator } from './agents/PaulPOrchestrator';
export { ResearchAgent } from './agents/ResearchAgent';
export { MarketDataAgent } from './agents/MarketDataAgent';
export { StrategyBondingAgent } from './agents/StrategyBondingAgent';
export { StrategyWeatherAgent } from './agents/StrategyWeatherAgent';
export { StrategyXVSignalAgent } from './agents/StrategyXVSignalAgent';
export { StrategySmartMoneyAgent } from './agents/StrategySmartMoneyAgent';
export { StrategyResolutionAgent } from './agents/StrategyResolutionAgent';
export { RiskGovernorAgent } from './agents/RiskGovernorAgent';
export { KalshiExecAgent } from './agents/KalshiExecAgent';
export { IBKRExecAgent } from './agents/IBKRExecAgent';
export { ReconciliationAgent } from './agents/ReconciliationAgent';
export { AuditReporterAgent } from './agents/AuditReporterAgent';
export { ComplianceAgent } from './agents/ComplianceAgent';

// Export workflow modules (application-level orchestration shims)
export { DataIngestionWorkflow } from './workflows/DataIngestionWorkflow';
export { SignalGenerationWorkflow } from './workflows/SignalGenerationWorkflow';
export { OrderLifecycleWorkflow } from './workflows/OrderLifecycleWorkflow';
export { ReconciliationWorkflow } from './workflows/ReconciliationWorkflow';
export { DailyReportWorkflow } from './workflows/DailyReportWorkflow';
export { StrategyDeploymentWorkflow } from './workflows/StrategyDeploymentWorkflow';
export { MarketPairingWorkflow } from './workflows/MarketPairingWorkflow';

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// System info
app.get('/', (c) => {
  return c.json({
    system: c.env.SYSTEM_NAME,
    version: '1.0.0',
    environment: c.env.ENVIRONMENT,
    status: 'operational',
    timestamp: new Date().toISOString(),
  });
});

// Mount route groups
app.route('/health', healthRoutes);
app.route('/admin', adminRoutes);
app.route('/webhooks', webhookRoutes);

// Error handling
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: 'Internal server error',
      message: err.message,
      timestamp: new Date().toISOString(),
    },
    500
  );
});

// Not found handler
app.notFound((c) => {
  return c.json(
    {
      error: 'Not found',
      path: c.req.path,
      timestamp: new Date().toISOString(),
    },
    404
  );
});

// Export the Hono app for HTTP requests
export default {
  fetch: app.fetch,

  /**
   * Queue consumer handler
   * Routes messages to appropriate consumers based on queue name
   */
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const queueName = batch.queue;

    console.log(`Processing ${batch.messages.length} messages from ${queueName}`);

    switch (queueName) {
      case 'paul-p-ingestion':
        await handleIngestionQueue(batch, env);
        break;

      case 'paul-p-signals':
        await handleSignalQueue(batch, env);
        break;

      case 'paul-p-orders':
        await handleOrderQueue(batch, env);
        break;

      case 'paul-p-pairing':
        await handlePairingQueue(batch, env);
        break;

      default:
        console.error(`Unknown queue: ${queueName}`);
    }
  },

  /**
   * Scheduled (cron) handler
   * Routes cron events to appropriate handlers based on schedule
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronExpression = event.cron;
    console.log(`Cron triggered: ${cronExpression} at ${new Date(event.scheduledTime).toISOString()}`);

    // Get orchestrator DO
    const orchestratorId = env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
    const orchestrator = env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

    switch (cronExpression) {
      case '*/15 * * * *':
        // Every 15 minutes: data ingestion
        ctx.waitUntil(
          orchestrator.fetch('http://internal/cron/ingest', { method: 'POST' })
        );
        break;

      case '*/5 * * * *':
        // Every 5 minutes: reconciliation
        ctx.waitUntil(
          orchestrator.fetch('http://internal/cron/reconcile', { method: 'POST' })
        );
        break;

      case '*/10 * * * *':
        // Every 10 minutes: signal scan
        ctx.waitUntil(
          orchestrator.fetch('http://internal/cron/scan-signals', { method: 'POST' })
        );
        break;

      case '2,12,22,32,42,52 * * * *':
        // Every 10 minutes (offset by 2 min from scan): execute signals
        ctx.waitUntil(
          orchestrator.fetch('http://internal/cron/execute-signals', { method: 'POST' })
        );
        break;

      case '0 * * * *':
        // Hourly: audit chain anchor
        ctx.waitUntil(
          orchestrator.fetch('http://internal/cron/anchor', { method: 'POST' })
        );
        break;

      case '0 23 * * *':
        // Daily at 11 PM UTC: daily report
        ctx.waitUntil(
          orchestrator.fetch('http://internal/cron/daily-report', { method: 'POST' })
        );
        break;

      case '0 3 * * *':
        // Daily at 3 AM UTC: LLM drift sweep
        ctx.waitUntil(
          orchestrator.fetch('http://internal/cron/llm-drift', { method: 'POST' })
        );
        break;

      default:
        console.warn(`Unknown cron expression: ${cronExpression}`);
    }
  },
};
