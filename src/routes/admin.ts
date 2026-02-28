/**
 * Paul P - Admin Routes
 * Protected admin API for strategy control and manual gates
 *
 * SECURITY: All admin routes require authentication.
 * Set ADMIN_TOKEN secret via: wrangler secret put ADMIN_TOKEN
 *
 * Auth methods supported:
 * 1. Bearer token: Authorization: Bearer <ADMIN_TOKEN>
 * 2. Cloudflare Access headers:
 *    - cf-access-authenticated-user-email
 *    - cf-access-jwt-assertion
 *
 * Optional hardening:
 * - ADMIN_ALLOWED_EMAILS: comma-separated email allowlist for Access users
 * - ADMIN_ALLOWED_IPS: comma-separated IP allowlist for admin ingress
 * - ADMIN_TURNSTILE_SECRET: require valid Turnstile token for mutating requests
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../types/env';
import { hasRecentDriftBlock } from '../lib/llm/drift-sweeps';

type Variables = {
  adminUser: string;
};

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
type AdminContext = Context<{ Bindings: Env; Variables: Variables }>;

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface TurnstileVerifyResponse {
  success: boolean;
  ['error-codes']?: string[];
}

type TradeVenue = 'kalshi' | 'ibkr';

type TradeRecord = Record<string, unknown> & {
  created_at?: string;
  status?: string;
  execution_mode?: string;
  venue?: TradeVenue;
};

function toTradeRecord(value: unknown): TradeRecord {
  if (value && typeof value === 'object') {
    return { ...(value as Record<string, unknown>) };
  }
  return { raw: value };
}

function getBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function checkAdminIpAllowlist(c: AdminContext): { ok: boolean; reason?: string } {
  const allowedIps = parseAllowlist(c.env.ADMIN_ALLOWED_IPS);
  if (allowedIps.size === 0) {
    return { ok: true };
  }

  const clientIp = c.req.header('cf-connecting-ip')?.trim();
  if (!clientIp) {
    return { ok: false, reason: 'Client IP unavailable for allowlist check' };
  }

  if (!allowedIps.has(clientIp)) {
    return { ok: false, reason: 'Client IP is not in admin allowlist' };
  }

  return { ok: true };
}

async function verifyTurnstileIfRequired(c: AdminContext): Promise<{ ok: boolean; reason?: string }> {
  if (!STATE_CHANGING_METHODS.has(c.req.method)) {
    return { ok: true };
  }

  const turnstileSecret = c.env.ADMIN_TURNSTILE_SECRET;
  if (!turnstileSecret) {
    return { ok: true };
  }

  const token =
    c.req.header('cf-turnstile-response')
    ?? c.req.header('x-turnstile-token');

  if (!token) {
    return { ok: false, reason: 'Turnstile token required for mutating admin requests' };
  }

  const body = new URLSearchParams({
    secret: turnstileSecret,
    response: token,
  });

  const clientIp = c.req.header('cf-connecting-ip');
  if (clientIp) {
    body.set('remoteip', clientIp);
  }

  try {
    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        body,
      }
    );

    if (!response.ok) {
      return { ok: false, reason: 'Turnstile verification service unavailable' };
    }

    const result = await response.json<TurnstileVerifyResponse>();
    if (!result.success) {
      const errorCodes = result['error-codes']?.join(', ') ?? 'invalid_token';
      return { ok: false, reason: `Turnstile verification failed (${errorCodes})` };
    }

    return { ok: true };
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return { ok: false, reason: 'Turnstile verification failed' };
  }
}

/**
 * Authentication middleware
 * Requires either:
 * - Valid ADMIN_TOKEN in Authorization header
 * - Cloudflare Access authenticated user (via cf-access headers)
 */
adminRoutes.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization');
  const bearerToken = getBearerToken(authHeader);
  const cfAccessUser = c.req.header('cf-access-authenticated-user-email');
  const cfAccessJwt = c.req.header('cf-access-jwt-assertion');
  const adminToken = c.env.ADMIN_TOKEN;

  // Prefer explicit bearer authentication when configured.
  if (adminToken && bearerToken === adminToken) {
    const ipAllowlist = checkAdminIpAllowlist(c);
    if (!ipAllowlist.ok) {
      return c.json({ error: 'Forbidden', message: ipAllowlist.reason }, 403);
    }

    c.set('adminUser', 'api-token-user');
    const turnstile = await verifyTurnstileIfRequired(c);
    if (!turnstile.ok) {
      return c.json({ error: 'Unauthorized', message: turnstile.reason }, 401);
    }
    return next();
  }

  // Cloudflare Access authentication path.
  if (cfAccessUser) {
    if (!cfAccessJwt) {
      return c.json({
        error: 'Unauthorized',
        message: 'Cloudflare Access JWT assertion is required',
      }, 401);
    }

    const allowedEmails = parseAllowlist(c.env.ADMIN_ALLOWED_EMAILS);
    if (allowedEmails.size > 0 && !allowedEmails.has(cfAccessUser.toLowerCase())) {
      return c.json({
        error: 'Forbidden',
        message: 'Authenticated user is not allowed for admin access',
      }, 403);
    }

    const ipAllowlist = checkAdminIpAllowlist(c);
    if (!ipAllowlist.ok) {
      return c.json({ error: 'Forbidden', message: ipAllowlist.reason }, 403);
    }

    c.set('adminUser', cfAccessUser);
    const turnstile = await verifyTurnstileIfRequired(c);
    if (!turnstile.ok) {
      return c.json({ error: 'Unauthorized', message: turnstile.reason }, 401);
    }
    return next();
  }

  // No valid authentication
  return c.json(
    {
      error: 'Unauthorized',
      message:
        'Admin routes require Authorization bearer token or Cloudflare Access (email + JWT headers)',
    },
    401
  );
});

/**
 * Get system status
 */
adminRoutes.get('/status', async (c) => {
  // Query strategies status
  const strategies = await c.env.DB.prepare(`
    SELECT id, name, strategy_type, status, total_pnl_usd, total_positions,
           win_count, loss_count, model_valid
    FROM strategies
    ORDER BY name
  `).all();

  // Get recent invariant violations
  const violations = await c.env.DB.prepare(`
    SELECT id, invariant_id, invariant_name, severity, triggered_at, resolved
    FROM invariant_violations
    WHERE resolved = 0
    ORDER BY triggered_at DESC
    LIMIT 10
  `).all();

  // Get portfolio snapshot
  const snapshot = await c.env.DB.prepare(`
    SELECT * FROM portfolio_snapshots
    ORDER BY snapshot_at DESC
    LIMIT 1
  `).first();

  return c.json({
    strategies: strategies.results,
    unresolvedViolations: violations.results,
    latestSnapshot: snapshot,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Get strategy details
 */
adminRoutes.get('/strategies/:id', async (c) => {
  const id = c.req.param('id');

  const strategy = await c.env.DB.prepare(`
    SELECT * FROM strategies WHERE id = ?
  `).bind(id).first();

  if (!strategy) {
    return c.json({ error: 'Strategy not found' }, 404);
  }

  const orders = await c.env.DB.prepare(`
    SELECT * FROM orders
    WHERE strategy_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(id).all();

  const policy = await c.env.DB.prepare(`
    SELECT * FROM execution_policies
    WHERE strategy_id = ? AND is_active = 1
  `).bind(id).first();

  return c.json({
    strategy,
    recentOrders: orders.results,
    executionPolicy: policy,
  });
});

/**
 * Get unified trade history from execution agents.
 * Query params:
 * - venue: all | kalshi | ibkr (default: all)
 * - limit: 1..500 (default: 100)
 * - strategy: strategy filter
 * - ticker: Kalshi-only ticker filter
 * - status: order status filter (applied after fetch)
 * - mode: PAPER | LIVE (applied after fetch)
 */
adminRoutes.get('/trades', async (c) => {
  const url = new URL(c.req.url);

  const venue = (url.searchParams.get('venue') ?? 'all').toLowerCase();
  if (!['all', 'kalshi', 'ibkr'].includes(venue)) {
    return c.json({ error: 'Invalid venue. Must be all, kalshi, or ibkr.' }, 400);
  }

  const limitParam = url.searchParams.get('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return c.json({ error: 'Invalid limit. Must be a positive integer.' }, 400);
  }
  const limit = Math.min(parsedLimit, 500);

  const strategy = url.searchParams.get('strategy');
  const ticker = url.searchParams.get('ticker');
  const statusFilter = url.searchParams.get('status')?.toLowerCase();
  const modeFilter = url.searchParams.get('mode')?.toUpperCase();

  if (modeFilter && !['PAPER', 'LIVE'].includes(modeFilter)) {
    return c.json({ error: 'Invalid mode. Must be PAPER or LIVE.' }, 400);
  }

  const venues: TradeVenue[] = venue === 'all' ? ['kalshi', 'ibkr'] : [venue as TradeVenue];

  const results = await Promise.all(
    venues.map(async (sourceVenue) => {
      const namespace = sourceVenue === 'kalshi' ? c.env.KALSHI_EXEC : c.env.IBKR_EXEC;
      const objectId = namespace.idFromName('singleton');
      const stub = namespace.get(objectId);

      const internalUrl = new URL('http://internal/orders/history');
      internalUrl.searchParams.set('limit', String(limit));
      if (strategy) {
        internalUrl.searchParams.set('strategy', strategy);
      }
      if (sourceVenue === 'kalshi' && ticker) {
        internalUrl.searchParams.set('ticker', ticker);
      }

      try {
        const response = await stub.fetch(internalUrl.toString());
        if (!response.ok) {
          return {
            venue: sourceVenue,
            orders: [] as TradeRecord[],
            error: `${sourceVenue} execution agent returned ${response.status}`,
          };
        }

        const payload = await response.json<{ orders?: unknown[]; error?: string }>();
        if (payload.error) {
          return {
            venue: sourceVenue,
            orders: [] as TradeRecord[],
            error: payload.error,
          };
        }

        const orders = (payload.orders ?? []).map((entry) => ({
          ...toTradeRecord(entry),
          venue: sourceVenue,
        }));

        return { venue: sourceVenue, orders };
      } catch (error) {
        return {
          venue: sourceVenue,
          orders: [] as TradeRecord[],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  const errors = results
    .filter((result) => result.error)
    .map((result) => ({
      venue: result.venue,
      message: result.error as string,
    }));

  const filteredTrades = results
    .flatMap((result) => result.orders)
    .filter((trade) => {
      if (statusFilter) {
        if (typeof trade.status !== 'string' || trade.status.toLowerCase() !== statusFilter) {
          return false;
        }
      }
      if (modeFilter) {
        if (typeof trade.execution_mode !== 'string' || trade.execution_mode.toUpperCase() !== modeFilter) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      const aTime = typeof a.created_at === 'string' ? Date.parse(a.created_at) : Number.NaN;
      const bTime = typeof b.created_at === 'string' ? Date.parse(b.created_at) : Number.NaN;

      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return bTime - aTime;
    })
    .slice(0, limit);

  return c.json({
    count: filteredTrades.length,
    trades: filteredTrades,
    filters: {
      venue,
      limit,
      strategy: strategy ?? null,
      ticker: ticker ?? null,
      status: statusFilter ?? null,
      mode: modeFilter ?? null,
    },
    partial: errors.length > 0,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Update strategy status
 */
adminRoutes.post('/strategies/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ status: string }>();

  const validStatuses = ['disabled', 'paper', 'live', 'halted'];
  if (!validStatuses.includes(body.status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  await c.env.DB.prepare(`
    UPDATE strategies
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).bind(body.status, new Date().toISOString(), id).run();

  return c.json({ success: true, newStatus: body.status });
});

/**
 * Approve market pair for cross-venue signals
 */
adminRoutes.post('/pairs/:id/approve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ reviewer: string; notes?: string }>();

  await c.env.DB.prepare(`
    UPDATE market_pairs
    SET status = 'approved',
        human_reviewer = ?,
        human_review_date = ?,
        human_review_notes = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    body.reviewer,
    new Date().toISOString(),
    body.notes ?? null,
    new Date().toISOString(),
    id
  ).run();

  return c.json({ success: true });
});

/**
 * Resolve an invariant violation
 */
adminRoutes.post('/violations/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ resolver: string; notes?: string }>();

  await c.env.DB.prepare(`
    UPDATE invariant_violations
    SET resolved = 1,
        resolved_at = ?,
        resolved_by = ?,
        resolution_notes = ?
    WHERE id = ?
  `).bind(
    new Date().toISOString(),
    body.resolver,
    body.notes ?? null,
    id
  ).run();

  return c.json({ success: true });
});

/**
 * Manual go-live approval (P-18: Two-person approval required)
 *
 * This endpoint validates:
 * 1. Two different approvers
 * 2. No blocked LLM drift sweeps
 * 3. Audit chain intact
 * 4. Valid capital allocation
 *
 * Then updates:
 * - strategies table
 * - strategy_execution_mode table
 * - capital_allocation table
 * - deployment_events audit log
 */
adminRoutes.post('/strategies/:id/go-live', async (c) => {
  const id = c.req.param('id');
  const strategyType = id as 'bonding' | 'weather' | 'xv_signal' | 'smart_money' | 'resolution';
  const body = await c.req.json<{
    approver: string;
    secondApprover: string;
    capitalAllocationUsd: number;
  }>();

  // Verify two-person rule
  if (!body.approver || !body.secondApprover) {
    return c.json({ error: 'Two-person approval required' }, 400);
  }

  if (body.approver === body.secondApprover) {
    return c.json({ error: 'Second approver must be different person' }, 400);
  }

  if (!body.capitalAllocationUsd || body.capitalAllocationUsd <= 0) {
    return c.json({ error: 'Valid capital allocation required' }, 400);
  }

  // Check for blocked LLM drift sweeps (supports both drift schemas)
  const driftBlocked = await hasRecentDriftBlock(c.env, 7);
  if (driftBlocked) {
    return c.json({
      error: 'Deployment blocked by LLM drift sweep',
      message: 'Recent drift sweep flagged deployment. Resolve before go-live.',
    }, 400);
  }

  // Check audit chain integrity
  const chainGaps = await c.env.DB.prepare(`
    SELECT COUNT(*) as gap_count FROM (
      SELECT event_sequence,
             LAG(event_sequence) OVER (ORDER BY event_sequence) as prev_seq
      FROM audit_chain_events
    ) WHERE event_sequence != prev_seq + 1 AND prev_seq IS NOT NULL
  `).first<{ gap_count: number }>();

  if ((chainGaps?.gap_count ?? 1) > 0) {
    return c.json({
      error: 'Audit chain integrity compromised',
      message: 'Resolve audit chain gaps before go-live.',
    }, 400);
  }

  const now = new Date().toISOString();
  const approvedBy = `${body.approver},${body.secondApprover}`;

  // Update strategy status
  await c.env.DB.prepare(`
    UPDATE strategies
    SET status = 'live',
        max_capital_allocation_usd = ?,
        approved_by = ?,
        approved_at = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    body.capitalAllocationUsd,
    approvedBy,
    now,
    now,
    id
  ).run();

  // Update execution mode
  await c.env.DB.prepare(`
    INSERT INTO strategy_execution_mode (strategy, mode, changed_at, changed_by, reason)
    VALUES (?, 'LIVE', ?, ?, 'Go-live approval')
    ON CONFLICT(strategy) DO UPDATE SET
      mode = 'LIVE',
      changed_at = excluded.changed_at,
      changed_by = excluded.changed_by,
      reason = excluded.reason
  `).bind(strategyType, now, approvedBy).run();

  // Allocate capital
  await c.env.DB.prepare(`
    INSERT INTO capital_allocation (strategy, capital, max_position_pct, available, enabled, enabled_at, approved_by, approved_at, allocated_at)
    VALUES (?, ?, 5, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(strategy) DO UPDATE SET
      capital = excluded.capital,
      available = excluded.available,
      enabled = 1,
      enabled_at = excluded.enabled_at,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      updated_at = datetime('now')
  `).bind(strategyType, body.capitalAllocationUsd, body.capitalAllocationUsd, now, approvedBy, now, now).run();

  // Log deployment event
  await c.env.DB.prepare(`
    INSERT INTO deployment_events (event_type, payload, actor, strategy)
    VALUES ('STRATEGY_DEPLOYED', ?, ?, ?)
  `).bind(
    JSON.stringify({
      capitalAllocationUsd: body.capitalAllocationUsd,
      approvers: [body.approver, body.secondApprover],
      timestamp: now,
    }),
    approvedBy,
    strategyType
  ).run();

  return c.json({
    success: true,
    status: 'live',
    strategy: strategyType,
    capital: body.capitalAllocationUsd,
    approvedBy,
    approvedAt: now,
  });
});

/**
 * Circuit breaker state transition (P-06)
 * Allows manual intervention for trading halt/recovery
 */
adminRoutes.post('/circuit-breaker/transition', async (c) => {
  const body = await c.req.json<{
    targetState: 'NORMAL' | 'CAUTION' | 'HALT' | 'RECOVERY';
    reason: string;
  }>();

  const validStates = ['NORMAL', 'CAUTION', 'HALT', 'RECOVERY'];
  if (!validStates.includes(body.targetState)) {
    return c.json({ error: 'Invalid target state' }, 400);
  }

  if (!body.reason) {
    return c.json({ error: 'Reason required for state transition' }, 400);
  }

  // Get Risk Governor to trigger state transition
  const riskGovernorId = c.env.RISK_GOVERNOR.idFromName('singleton');
  const riskGovernor = c.env.RISK_GOVERNOR.get(riskGovernorId);

  const response = await riskGovernor.fetch('http://internal/circuit-breaker/transition', {
    method: 'POST',
    body: JSON.stringify({
      targetState: body.targetState,
      reason: body.reason,
      triggeredBy: c.get('adminUser') ?? 'admin',
    }),
  });

  const result = await response.json<{ previousState?: string; newState?: string; reason?: string; error?: string }>();

  if (result.error || !result.newState) {
    return c.json({ error: result.error ?? 'Transition failed' }, 400);
  }

  return c.json({
    success: true,
    previousState: result.previousState,
    newState: result.newState,
    reason: body.reason,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Trigger position reconciliation
 */
adminRoutes.post('/reconcile', async (c) => {
  const reconciliationId = c.env.RECONCILIATION.idFromName('singleton');
  const reconciliation = c.env.RECONCILIATION.get(reconciliationId);

  const response = await reconciliation.fetch('http://internal/reconcile', {
    method: 'POST',
  });

  const result = await response.json<{
    success: boolean;
    positionsChecked?: number;
    driftDetected?: number;
    error?: string;
  }>();

  return c.json({
    ...result,
    triggeredBy: c.get('adminUser') ?? 'admin',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Get audit chain status
 */
adminRoutes.get('/audit/status', async (c) => {
  const latestAnchor = await c.env.DB_ANCHOR.prepare(`
    SELECT * FROM audit_chain_anchors
    ORDER BY anchor_timestamp DESC
    LIMIT 1
  `).first();

  const eventCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM audit_chain_events
  `).first<{ count: number }>();

  const unsyncedCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM audit_chain_events WHERE r2_synced = 0
  `).first<{ count: number }>();

  return c.json({
    latestAnchor,
    totalEvents: eventCount?.count ?? 0,
    unsyncedEvents: unsyncedCount?.count ?? 0,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Phase Gate Verification Endpoints
 * Verify and signoff on phase transitions
 */
import {
  checkPhaseGate,
  recordPhaseGateSignoff,
  getLatestPhaseSignoff,
  getAllPhaseSignoffs,
  type Phase,
} from '../lib/gates/phase-gate-checker';

/**
 * Verify phase gate criteria
 * GET /admin/gates/verify/:phase
 */
adminRoutes.get('/gates/verify/:phase', async (c) => {
  const phaseParam = c.req.param('phase');
  const phase = parseInt(phaseParam, 10) as Phase;

  if (![1, 2, 3, 4].includes(phase)) {
    return c.json({ error: 'Invalid phase. Must be 1, 2, 3, or 4' }, 400);
  }

  try {
    const result = await checkPhaseGate(c.env, phase);

    return c.json({
      ...result,
      checkedBy: c.get('adminUser') ?? 'admin',
    });
  } catch (error) {
    return c.json({
      error: 'Gate check failed',
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

/**
 * Sign off on a phase gate (record approval)
 * POST /admin/gates/signoff/:phase
 */
adminRoutes.post('/gates/signoff/:phase', async (c) => {
  const phaseParam = c.req.param('phase');
  const phase = parseInt(phaseParam, 10) as Phase;
  const body = await c.req.json<{ notes?: string; force?: boolean }>();

  if (![1, 2, 3, 4].includes(phase)) {
    return c.json({ error: 'Invalid phase. Must be 1, 2, 3, or 4' }, 400);
  }

  try {
    // First verify the gate
    const gateResult = await checkPhaseGate(c.env, phase);

    // Check if gate passes (unless force flag is set)
    if (!gateResult.passed && !body.force) {
      return c.json({
        error: 'Gate verification failed',
        message: 'Cannot sign off on failed gate. Use force=true to override.',
        gateResult,
      }, 400);
    }

    // Record signoff
    const signoff = await recordPhaseGateSignoff(
      c.env,
      phase,
      (phase + 1) as Phase,
      c.get('adminUser') ?? 'admin',
      gateResult,
      body.notes
    );

    return c.json({
      success: true,
      signoff,
      warning: !gateResult.passed ? 'FORCED: Gate was signed off despite failing criteria' : undefined,
    });
  } catch (error) {
    return c.json({
      error: 'Signoff failed',
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

/**
 * Get latest signoff for a phase
 * GET /admin/gates/signoff/:phase
 */
adminRoutes.get('/gates/signoff/:phase', async (c) => {
  const phaseParam = c.req.param('phase');
  const phase = parseInt(phaseParam, 10) as Phase;

  if (![1, 2, 3, 4].includes(phase)) {
    return c.json({ error: 'Invalid phase. Must be 1, 2, 3, or 4' }, 400);
  }

  const signoff = await getLatestPhaseSignoff(c.env, phase);

  if (!signoff) {
    return c.json({ message: `No signoff found for phase ${phase}` }, 404);
  }

  return c.json(signoff);
});

/**
 * Get all phase signoffs (for audit)
 * GET /admin/gates/signoffs
 */
adminRoutes.get('/gates/signoffs', async (c) => {
  const signoffs = await getAllPhaseSignoffs(c.env);

  return c.json({
    count: signoffs.length,
    signoffs,
  });
});

/**
 * Get phase gate criteria definitions
 * GET /admin/gates/criteria/:phase
 */
adminRoutes.get('/gates/criteria/:phase', async (c) => {
  const phaseParam = c.req.param('phase');
  const phase = parseInt(phaseParam, 10) as Phase;

  if (![1, 2, 3, 4].includes(phase)) {
    return c.json({ error: 'Invalid phase. Must be 1, 2, 3, or 4' }, 400);
  }

  const {
    PHASE_1_TO_2_CRITERIA,
    PHASE_2_TO_3_CRITERIA,
    PHASE_3_TO_4_CRITERIA,
    PHASE_4_LIVE_CRITERIA,
  } = await import('../lib/gates/phase-gate-checker');

  let criteria;
  switch (phase) {
    case 1:
      criteria = PHASE_1_TO_2_CRITERIA;
      break;
    case 2:
      criteria = PHASE_2_TO_3_CRITERIA;
      break;
    case 3:
      criteria = PHASE_3_TO_4_CRITERIA;
      break;
    case 4:
      criteria = PHASE_4_LIVE_CRITERIA;
      break;
  }

  return c.json({
    phase,
    targetPhase: phase < 4 ? phase + 1 : 4,
    criteriaCount: criteria.length,
    requiredCount: criteria.filter(c => c.required).length,
    criteria,
  });
});

// ============================================================
// ORCHESTRATOR TRIGGER ENDPOINTS (MANUAL PIPELINE CONTROL)
// ============================================================

/**
 * POST /orchestrator/trigger/ingest
 * Manually trigger market data ingestion (normally runs every 15 min)
 */
adminRoutes.post('/orchestrator/trigger/ingest', async (c: AdminContext) => {
  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  const result = await orchestrator.fetch('http://internal/trigger/ingest', {
    method: 'POST',
  });

  const data = await result.json();
  return c.json({
    success: true,
    trigger: 'ingest',
    triggeredBy: c.get('adminUser') ?? 'admin',
    timestamp: new Date().toISOString(),
    result: data,
  });
});

/**
 * POST /orchestrator/trigger/scan
 * Manually trigger signal scanning (normally runs every 10 min)
 */
adminRoutes.post('/orchestrator/trigger/scan', async (c: AdminContext) => {
  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  const result = await orchestrator.fetch('http://internal/trigger/scan', {
    method: 'POST',
  });

  const data = await result.json();
  return c.json({
    success: true,
    trigger: 'scan',
    triggeredBy: c.get('adminUser') ?? 'admin',
    timestamp: new Date().toISOString(),
    result: data,
  });
});

/**
 * POST /orchestrator/trigger/execute
 * Manually trigger signal execution (normally runs every 10 min offset by 2)
 */
adminRoutes.post('/orchestrator/trigger/execute', async (c: AdminContext) => {
  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  const result = await orchestrator.fetch('http://internal/trigger/execute', {
    method: 'POST',
  });

  const data = await result.json();
  return c.json({
    success: true,
    trigger: 'execute',
    triggeredBy: c.get('adminUser') ?? 'admin',
    timestamp: new Date().toISOString(),
    result: data,
  });
});

/**
 * POST /orchestrator/trigger/reconcile
 * Manually trigger reconciliation (normally runs every 5 min)
 */
adminRoutes.post('/orchestrator/trigger/reconcile', async (c: AdminContext) => {
  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  const result = await orchestrator.fetch('http://internal/trigger/reconcile', {
    method: 'POST',
  });

  const data = await result.json();
  return c.json({
    success: true,
    trigger: 'reconcile',
    triggeredBy: c.get('adminUser') ?? 'admin',
    timestamp: new Date().toISOString(),
    result: data,
  });
});

/**
 * GET /orchestrator/orders
 * Get order lifecycle from orchestrator DO
 */
adminRoutes.get('/orchestrator/orders', async (c: AdminContext) => {
  const orchestratorId = c.env.PAUL_P_ORCHESTRATOR.idFromName('singleton');
  const orchestrator = c.env.PAUL_P_ORCHESTRATOR.get(orchestratorId);

  const result = await orchestrator.fetch('http://internal/workflow/orders', {
    method: 'GET',
  });

  const data = await result.json();
  return c.json(data);
});
