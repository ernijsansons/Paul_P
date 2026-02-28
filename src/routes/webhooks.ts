/**
 * Paul P - Webhook Routes
 * External triggers and event handlers
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

function getBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

// Manual trigger routes must always be authenticated.
webhookRoutes.use('/trigger/*', async (c, next) => {
  const expectedToken = c.env.WEBHOOK_TRIGGER_TOKEN ?? c.env.ADMIN_TOKEN;
  if (!expectedToken) {
    return c.json({
      error: 'Configuration error',
      message: 'WEBHOOK_TRIGGER_TOKEN (or ADMIN_TOKEN fallback) is not configured',
    }, 503);
  }

  const providedToken = getBearerToken(c.req.header('authorization'));
  if (!providedToken || providedToken !== expectedToken) {
    return c.json({ error: 'Unauthorized', message: 'Invalid webhook trigger token' }, 401);
  }

  return next();
});

// Kalshi relay ingress must be protected by shared secret.
webhookRoutes.use('/kalshi/events', async (c, next) => {
  const expectedSecret = c.env.KALSHI_WEBHOOK_SECRET ?? c.env.WEBHOOK_SHARED_SECRET;
  if (!expectedSecret) {
    return c.json({
      error: 'Configuration error',
      message: 'KALSHI_WEBHOOK_SECRET (or WEBHOOK_SHARED_SECRET fallback) is not configured',
    }, 503);
  }

  const providedSecret =
    c.req.header('x-kalshi-webhook-secret')
    ?? c.req.header('x-webhook-secret');

  if (!providedSecret || providedSecret !== expectedSecret) {
    return c.json({ error: 'Unauthorized', message: 'Invalid Kalshi webhook secret' }, 401);
  }

  return next();
});

/**
 * Kalshi WebSocket relay endpoint
 * Used by external WebSocket listener to push order/fill events
 */
webhookRoutes.post('/kalshi/events', async (c) => {
  const body = await c.req.json<{
    event_type: string;
    payload: unknown;
  }>();

  console.log(`Received Kalshi event: ${body.event_type}`);

  // Route to appropriate handler based on event type
  switch (body.event_type) {
    case 'order_update':
      // Forward to KalshiExecAgent
      const execId = c.env.KALSHI_EXEC.idFromName('singleton');
      const exec = c.env.KALSHI_EXEC.get(execId);
      await exec.fetch('http://internal/event/order-update', {
        method: 'POST',
        body: JSON.stringify(body.payload),
      });
      break;

    case 'fill':
      // Forward to ReconciliationAgent
      const reconId = c.env.RECONCILIATION.idFromName('singleton');
      const recon = c.env.RECONCILIATION.get(reconId);
      await recon.fetch('http://internal/event/fill', {
        method: 'POST',
        body: JSON.stringify(body.payload),
      });
      break;

    case 'market_update':
      // Forward to MarketDataAgent
      const mdaId = c.env.MARKET_DATA_AGENT.idFromName('singleton');
      const mda = c.env.MARKET_DATA_AGENT.get(mdaId);
      await mda.fetch('http://internal/event/market-update', {
        method: 'POST',
        body: JSON.stringify(body.payload),
      });
      break;

    default:
      console.warn(`Unknown Kalshi event type: ${body.event_type}`);
  }

  return c.json({ received: true });
});

/**
 * Manual trigger for ingestion
 */
webhookRoutes.post('/trigger/ingest', async (c) => {
  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  const response = await orchestrator.fetch('http://internal/trigger/ingest', {
    method: 'POST',
  });

  const result = await response.json();
  return c.json(result);
});

/**
 * Manual trigger for reconciliation
 */
webhookRoutes.post('/trigger/reconcile', async (c) => {
  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  const response = await orchestrator.fetch('http://internal/trigger/reconcile', {
    method: 'POST',
  });

  const result = await response.json();
  return c.json(result);
});

/**
 * External alert endpoint (e.g., from monitoring)
 */
webhookRoutes.post('/alert', async (c) => {
  const body = await c.req.json<{
    severity: 'info' | 'warning' | 'critical';
    source: string;
    message: string;
    context?: Record<string, unknown>;
  }>();

  // Log the alert
  console.log(`Alert [${body.severity}] from ${body.source}: ${body.message}`);

  // If critical, trigger circuit breaker check
  if (body.severity === 'critical') {
    const riskId = c.env.RISK_GOVERNOR.idFromName('singleton');
    const risk = c.env.RISK_GOVERNOR.get(riskId);
    await risk.fetch('http://internal/alert/critical', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  return c.json({ received: true });
});
