import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import type { Env } from '../../src/types/env';
import { adminRoutes } from '../../src/routes/admin';

type StubHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function createNamespace(handler: StubHandler) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(new URL(rawUrl), init);
  });

  return {
    namespace: {
      idFromName: vi.fn(() => 'singleton-id'),
      get: vi.fn(() => ({ fetch })),
    },
    fetch,
  };
}

function createEnv(overrides: Partial<Env> = {}): Env {
  // Default RISK_GOVERNOR mock for circuit breaker tests
  const riskGovernor = createNamespace(async (url, init) => {
    if (url.pathname === '/circuit-breaker/transition') {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return Response.json({
        previousState: 'NORMAL',
        newState: body.targetState ?? 'CAUTION',
        reason: body.reason,
      });
    }
    return Response.json({ state: 'NORMAL' });
  });

  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'Paul P',
    ADMIN_TOKEN: 'admin-token',
    // Use real bindings from cloudflare:test for D1, R2, KV
    DB: testEnv.DB,
    DB_ANCHOR: testEnv.DB_ANCHOR,
    R2_AUDIT: testEnv.R2_AUDIT,
    R2_EVIDENCE: testEnv.R2_EVIDENCE,
    KV_CACHE: testEnv.KV_CACHE,
    // Mock DOs that admin routes use
    RISK_GOVERNOR: riskGovernor.namespace as unknown as Env['RISK_GOVERNOR'],
    ...overrides,
  } as Env;
}

// Setup: Create required tables for admin route tests
beforeAll(async () => {
  // Create strategies table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      strategy_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inactive',
      total_pnl_usd REAL DEFAULT 0,
      total_positions INTEGER DEFAULT 0,
      win_count INTEGER DEFAULT 0,
      loss_count INTEGER DEFAULT 0,
      model_valid INTEGER DEFAULT 1,
      max_capital_allocation_usd REAL,
      approved_by TEXT,
      approved_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // Create invariant_violations table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS invariant_violations (
      id TEXT PRIMARY KEY,
      invariant_id TEXT NOT NULL,
      invariant_name TEXT NOT NULL,
      severity TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_notes TEXT
    )
  `).run();

  // Create portfolio_snapshots table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY,
      snapshot_at TEXT NOT NULL,
      total_value REAL DEFAULT 0,
      cash_balance REAL DEFAULT 0,
      positions_value REAL DEFAULT 0
    )
  `).run();

  // Create orders table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      strategy_id TEXT,
      market_id TEXT,
      side TEXT,
      size INTEGER,
      price REAL,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // Create execution_policies table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS execution_policies (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      policy_json TEXT
    )
  `).run();

  // Create circuit_breaker_state table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS circuit_breaker_state (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      state TEXT NOT NULL DEFAULT 'NORMAL',
      last_transition TEXT NOT NULL,
      triggered_by TEXT
    )
  `).run();

  // Create audit_log table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Create phase_gate_signoffs table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS phase_gate_signoffs (
      id TEXT PRIMARY KEY,
      phase INTEGER NOT NULL,
      target_phase INTEGER NOT NULL,
      approver TEXT NOT NULL,
      passed INTEGER NOT NULL,
      criteria_snapshot TEXT,
      notes TEXT,
      signed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Create audit_chain_events table
  await testEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_chain_events (
      id TEXT PRIMARY KEY,
      event_sequence INTEGER,
      r2_synced INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // Create audit_chain_anchors table in DB_ANCHOR
  await testEnv.DB_ANCHOR.prepare(`
    CREATE TABLE IF NOT EXISTS audit_chain_anchors (
      id TEXT PRIMARY KEY,
      anchor_hash TEXT NOT NULL,
      anchor_timestamp TEXT NOT NULL,
      event_count INTEGER DEFAULT 0
    )
  `).run();

  // Initialize circuit breaker state
  await testEnv.DB.prepare(`
    INSERT OR IGNORE INTO circuit_breaker_state (id, state, last_transition)
    VALUES ('singleton', 'NORMAL', datetime('now'))
  `).run();

  // Insert test strategy for status endpoint
  await testEnv.DB.prepare(`
    INSERT OR IGNORE INTO strategies (id, name, strategy_type, status)
    VALUES ('test-strategy', 'Test Strategy', 'bonding', 'active')
  `).run();
});

describe('Admin Endpoints - Status', () => {
  it('GET /status returns system status with strategies', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/status', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      strategies: unknown[];
      unresolvedViolations: unknown[];
      latestSnapshot: unknown;
      timestamp: string;
    }>();

    expect(body.timestamp).toBeTruthy();
    expect(Array.isArray(body.strategies)).toBe(true);
    expect(Array.isArray(body.unresolvedViolations)).toBe(true);
  });
});

describe('Admin Endpoints - Phase Gates', () => {
  it('POST /gates/signoff/:phase requires admin authentication', async () => {
    const env = createEnv();

    const noAuth = await adminRoutes.fetch(
      new Request('http://localhost/gates/signoff/3', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notes: 'All criteria pass' }),
      }),
      env
    );

    expect(noAuth.status).toBe(401);

    const invalidToken = await adminRoutes.fetch(
      new Request('http://localhost/gates/signoff/3', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer invalid-token',
        },
        body: JSON.stringify({ notes: 'All criteria pass' }),
      }),
      env
    );

    expect(invalidToken.status).toBe(401);
  });

  it('rejects invalid phase number', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/gates/verify/999', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain('Invalid phase');
  });

  it('GET /gates/criteria/:phase returns phase criteria list', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/gates/criteria/3', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      phase: number;
      targetPhase: number;
      criteriaCount: number;
      criteria: Array<{ id: string; description: string; required: boolean }>;
    }>();

    expect(body.phase).toBe(3);
    expect(body.targetPhase).toBe(4);
    expect(body.criteria).toBeTruthy();
    expect(body.criteria.length).toBeGreaterThan(0);
    // Actual criteria from phase-gate-checker module
    expect(body.criteriaCount).toBeGreaterThan(0);
  });
});

describe('Admin Endpoints - Circuit Breaker', () => {
  it('POST /circuit-breaker/transition requires valid state', async () => {
    const env = createEnv();

    const invalidState = await adminRoutes.fetch(
      new Request('http://localhost/circuit-breaker/transition', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer admin-token',
        },
        body: JSON.stringify({ targetState: 'INVALID_STATE', reason: 'test' }),
      }),
      env
    );

    expect(invalidState.status).toBe(400);
    const body = await invalidState.json<{ error: string }>();
    expect(body.error).toContain('Invalid');
  });

  it('POST /circuit-breaker/transition requires authentication', async () => {
    const env = createEnv();

    const noAuth = await adminRoutes.fetch(
      new Request('http://localhost/circuit-breaker/transition', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetState: 'CAUTION', reason: 'test' }),
      }),
      env
    );

    expect(noAuth.status).toBe(401);
  });

  it('valid circuit breaker transition succeeds', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/circuit-breaker/transition', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer admin-token',
        },
        body: JSON.stringify({ targetState: 'CAUTION', reason: 'High failure rate detected' }),
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      success: boolean;
      previousState: string;
      newState: string;
      reason: string;
      timestamp: string;
    }>();

    expect(body.success).toBe(true);
    expect(body.newState).toBe('CAUTION');
    expect(body.reason).toBe('High failure rate detected');
    expect(body.timestamp).toBeTruthy();
  });
});

describe('Admin Endpoints - Authentication Layers', () => {
  it('accepts valid Bearer token', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/status', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
  });

  it('rejects invalid Bearer token', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/status', {
        headers: { authorization: 'Bearer wrong-token' },
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('rejects requests without authentication', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/status'),
      env
    );

    expect(response.status).toBe(401);
  });

  it('enforces email allowlist when ADMIN_ALLOWED_EMAILS configured', async () => {
    const env = createEnv({
      ADMIN_ALLOWED_EMAILS: 'admin@example.com,ops@example.com',
    });

    const notInAllowlist = await adminRoutes.fetch(
      new Request('http://localhost/status', {
        headers: {
          'cf-access-authenticated-user-email': 'unauthorized@example.com',
          'cf-access-jwt-assertion': 'mock-jwt-token',
        },
      }),
      env
    );

    expect(notInAllowlist.status).toBe(403);
    const body = await notInAllowlist.json<{ error: string; message: string }>();
    expect(body.message).toContain('not allowed');
  });

  it('allows Cloudflare Access user in allowlist', async () => {
    const env = createEnv({
      ADMIN_ALLOWED_EMAILS: 'admin@example.com,ops@example.com',
    });

    const response = await adminRoutes.fetch(
      new Request('http://localhost/status', {
        headers: {
          'cf-access-authenticated-user-email': 'admin@example.com',
          'cf-access-jwt-assertion': 'mock-jwt-token',
        },
      }),
      env
    );

    expect(response.status).toBe(200);
  });

  it('requires JWT assertion when using CF Access email header', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/status', {
        headers: {
          'cf-access-authenticated-user-email': 'admin@example.com',
        },
      }),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.message).toContain('JWT assertion');
  });
});

describe('Admin Endpoints - Audit Status', () => {
  it('GET /audit/status returns audit chain statistics', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/audit/status', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      latestAnchor: unknown;
      totalEvents: number;
      unsyncedEvents: number;
      timestamp: string;
    }>();

    expect(body.timestamp).toBeTruthy();
    expect(typeof body.totalEvents).toBe('number');
    expect(typeof body.unsyncedEvents).toBe('number');
  });
});
