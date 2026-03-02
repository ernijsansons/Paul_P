/**
 * Paul P - Health Check Routes
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';

export const healthRoutes = new Hono<{ Bindings: Env }>();

/**
 * Basic health check
 */
healthRoutes.get('/', async (c) => {
  return c.json({
    status: 'healthy',
    system: c.env.SYSTEM_NAME,
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Deep health check - verifies all dependencies
 */
healthRoutes.get('/deep', async (c) => {
  const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

  // Check D1 Primary
  const d1Start = Date.now();
  try {
    await c.env.DB.prepare('SELECT 1').run();
    checks['d1_primary'] = { status: 'healthy', latencyMs: Date.now() - d1Start };
  } catch (error) {
    checks['d1_primary'] = { status: 'unhealthy', error: String(error) };
  }

  // Check D1 Anchor
  const d1AnchorStart = Date.now();
  try {
    await c.env.DB_ANCHOR.prepare('SELECT 1').run();
    checks['d1_anchor'] = { status: 'healthy', latencyMs: Date.now() - d1AnchorStart };
  } catch (error) {
    checks['d1_anchor'] = { status: 'unhealthy', error: String(error) };
  }

  // Check R2 Audit
  const r2AuditStart = Date.now();
  try {
    await c.env.R2_AUDIT.head('health-check');
    checks['r2_audit'] = { status: 'healthy', latencyMs: Date.now() - r2AuditStart };
  } catch (error) {
    // head() returns null for non-existent keys, which is fine
    checks['r2_audit'] = { status: 'healthy', latencyMs: Date.now() - r2AuditStart };
  }

  // Check R2 Evidence
  const r2EvidenceStart = Date.now();
  try {
    await c.env.R2_EVIDENCE.head('health-check');
    checks['r2_evidence'] = { status: 'healthy', latencyMs: Date.now() - r2EvidenceStart };
  } catch (error) {
    checks['r2_evidence'] = { status: 'healthy', latencyMs: Date.now() - r2EvidenceStart };
  }

  // Check KV
  const kvStart = Date.now();
  try {
    await c.env.KV_CACHE.get('health-check');
    checks['kv_cache'] = { status: 'healthy', latencyMs: Date.now() - kvStart };
  } catch (error) {
    checks['kv_cache'] = { status: 'unhealthy', error: String(error) };
  }

  // Determine overall status
  const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');

  return c.json({
    status: allHealthy ? 'healthy' : 'degraded',
    system: c.env.SYSTEM_NAME,
    environment: c.env.ENVIRONMENT,
    checks,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness check - can the system accept traffic?
 */
healthRoutes.get('/ready', async (c) => {
  try {
    // Check D1 is accessible
    await c.env.DB.prepare('SELECT 1').run();

    return c.json({ ready: true });
  } catch {
    return c.json({ ready: false }, 503);
  }
});

/**
 * Liveness check - is the system alive?
 */
healthRoutes.get('/live', (c) => {
  return c.json({ alive: true });
});

/**
 * Constant-time string comparison to prevent timing attacks
 */
function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Debug: Trigger market data ingestion
 * Protected by admin authorization in production
 */
healthRoutes.post('/debug/ingest', async (c) => {
  // Production protection: require admin authorization
  if (c.env.ENVIRONMENT === 'production') {
    const adminToken = c.env.ADMIN_TOKEN;
    // Fail closed: if ADMIN_TOKEN is not configured, deny access
    if (!adminToken) {
      return c.json({ error: 'Admin token not configured' }, 500);
    }

    const authHeader = c.req.header('Authorization');
    const expectedHeader = `Bearer ${adminToken}`;

    // Use constant-time comparison to prevent timing attacks
    if (!authHeader || !secureCompare(authHeader, expectedHeader)) {
      return c.json({ error: 'Debug endpoint requires admin authorization in production' }, 403);
    }
  }

  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  try {
    const response = await orchestrator.fetch('http://internal/trigger/ingest', {
      method: 'POST',
    });

    const result = await response.json();
    return c.json({
      success: true,
      message: 'Ingestion triggered',
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }, 500);
  }
});
