/**
 * Execution Routes Tests
 *
 * Runtime tests that verify /exec/* routes behavior including:
 * - Authentication enforcement (401 without auth, 200 with valid auth)
 * - DO stub forwarding
 * - Error handling
 */

import { describe, expect, it, vi } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import type { Env } from '../../../src/types/env';
import { executionRoutes } from '../../../src/routes/execution';

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
  // Default KALSHI_EXEC mock
  const kalshiExec = createNamespace(async (url) => {
    if (url.pathname === '/mode') {
      return Response.json({ mode: 'PAPER', strategy: 'bonding' });
    }
    if (url.pathname === '/status') {
      return Response.json({
        mode: 'PAPER',
        strategy: 'bonding',
        ordersExecuted: 0,
        ordersRejected: 0,
      });
    }
    if (url.pathname === '/mode/reload') {
      return Response.json({ reloaded: true, mode: 'LIVE' });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  });

  // Default IBKR_EXEC mock
  const ibkrExec = createNamespace(async (url) => {
    if (url.pathname === '/mode') {
      return Response.json({ mode: 'PAPER', strategy: 'ibkr-default' });
    }
    if (url.pathname === '/status') {
      return Response.json({
        mode: 'PAPER',
        strategy: 'ibkr-default',
        ordersExecuted: 0,
      });
    }
    if (url.pathname === '/mode/reload') {
      return Response.json({ reloaded: true, mode: 'PAPER' });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  });

  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'Paul P',
    ADMIN_TOKEN: 'test-admin-token',
    DB: testEnv.DB,
    DB_ANCHOR: testEnv.DB_ANCHOR,
    R2_AUDIT: testEnv.R2_AUDIT,
    R2_EVIDENCE: testEnv.R2_EVIDENCE,
    KV_CACHE: testEnv.KV_CACHE,
    KALSHI_EXEC: kalshiExec.namespace as unknown as Env['KALSHI_EXEC'],
    IBKR_EXEC: ibkrExec.namespace as unknown as Env['IBKR_EXEC'],
    ...overrides,
  } as Env;
}

// ============================================================
// AUTHENTICATION TESTS
// ============================================================

describe('Execution Routes - Authentication', () => {
  it('returns 401 when no auth header provided', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode'),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe('Unauthorized');
    expect(body.message).toContain('Authentication required');
  });

  it('returns 401 when invalid bearer token provided', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: { authorization: 'Bearer wrong-token' },
      }),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 200 when valid bearer token provided', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ mode: string }>();
    expect(body.mode).toBe('PAPER');
  });

  it('returns 401 when CF Access user has no JWT', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: {
          'cf-access-authenticated-user-email': 'user@example.com',
        },
      }),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.message).toContain('JWT assertion is required');
  });

  it('returns 500 (fail-closed) when CF Access headers present but JWT validation not configured', async () => {
    // SECURITY FIX: CF Access now fails closed when CF_ACCESS_TEAM_DOMAIN/AUDIENCE not configured
    const env = createEnv();
    // Note: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUDIENCE not set

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: {
          'cf-access-authenticated-user-email': 'user@example.com',
          'cf-access-jwt-assertion': 'valid-jwt-token',
        },
      }),
      env
    );

    // Fail-closed: returns 500 when JWT validation cannot be performed
    expect(response.status).toBe(500);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe('Server Configuration Error');
    expect(body.message).toContain('CF Access JWT validation not configured');
  });

  it('returns 500 (fail-closed) when CF Access headers present regardless of allowlist', async () => {
    // SECURITY FIX: JWT validation check happens before email allowlist check
    const env = createEnv({
      ADMIN_ALLOWED_EMAILS: 'allowed@example.com',
      // Note: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUDIENCE not set
    });

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: {
          'cf-access-authenticated-user-email': 'notallowed@example.com',
          'cf-access-jwt-assertion': 'valid-jwt-token',
        },
      }),
      env
    );

    // Fail-closed: returns 500 when JWT validation cannot be performed
    // (even if user would be rejected by allowlist, fail-closed takes precedence)
    expect(response.status).toBe(500);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe('Server Configuration Error');
  });
});

// ============================================================
// KALSHI ENDPOINT TESTS
// ============================================================

describe('Execution Routes - Kalshi Endpoints', () => {
  it('GET /kalshi/mode returns execution mode from DO', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ mode: string; strategy: string }>();
    expect(body.mode).toBe('PAPER');
    expect(body.strategy).toBe('bonding');
  });

  it('GET /kalshi/status returns full status from DO', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/status', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      mode: string;
      strategy: string;
      ordersExecuted: number;
    }>();
    expect(body.mode).toBe('PAPER');
    expect(body.ordersExecuted).toBe(0);
  });

  it('POST /kalshi/mode/reload triggers mode refresh', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode/reload', {
        method: 'POST',
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ reloaded: boolean; mode: string }>();
    expect(body.reloaded).toBe(true);
    expect(body.mode).toBe('LIVE');
  });

  it('forwards request to correct DO singleton', async () => {
    const kalshiExec = createNamespace(async () => {
      return Response.json({ mode: 'LIVE' });
    });

    const env = createEnv({
      KALSHI_EXEC: kalshiExec.namespace as unknown as Env['KALSHI_EXEC'],
    });

    await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(kalshiExec.namespace.idFromName).toHaveBeenCalledWith('singleton');
    expect(kalshiExec.fetch).toHaveBeenCalled();
  });
});

// ============================================================
// IBKR ENDPOINT TESTS
// ============================================================

describe('Execution Routes - IBKR Endpoints', () => {
  it('GET /ibkr/mode returns execution mode from DO', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/ibkr/mode', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ mode: string }>();
    expect(body.mode).toBe('PAPER');
  });

  it('GET /ibkr/status returns full status from DO', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/ibkr/status', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ mode: string; ordersExecuted: number }>();
    expect(body.mode).toBe('PAPER');
    expect(body.ordersExecuted).toBe(0);
  });

  it('POST /ibkr/mode/reload triggers mode refresh', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/ibkr/mode/reload', {
        method: 'POST',
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ reloaded: boolean }>();
    expect(body.reloaded).toBe(true);
  });
});

// ============================================================
// ERROR HANDLING TESTS
// ============================================================

describe('Execution Routes - Error Handling', () => {
  it('returns 500 when DO throws error', async () => {
    const kalshiExec = createNamespace(async () => {
      throw new Error('DO connection failed');
    });

    const env = createEnv({
      KALSHI_EXEC: kalshiExec.namespace as unknown as Env['KALSHI_EXEC'],
    });

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(500);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe('Failed to get Kalshi execution mode');
    expect(body.message).toBe('DO connection failed');
  });

  it('returns 404 for unknown routes', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/unknown/route', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
      env
    );

    expect(response.status).toBe(404);
  });
});
