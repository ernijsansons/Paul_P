/**
 * Execution Routes - Bridge to Kalshi/IBKR Execution Agent DOs
 *
 * Exposes execution agent internal endpoints via HTTP for external monitoring
 * and verification (e.g., confirming execution mode is LIVE before deployment).
 *
 * SECURITY: All /exec routes require authentication.
 * Auth methods supported (same as /admin):
 * 1. Bearer token: Authorization: Bearer <ADMIN_TOKEN>
 * 2. Cloudflare Access headers:
 *    - cf-access-authenticated-user-email
 *    - cf-access-jwt-assertion
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../types/env';
import { validateCFAccessJWT } from '../lib/security';

type Variables = {
  execUser: string;
};

export const executionRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
type ExecContext = Context<{ Bindings: Env; Variables: Variables }>;

// ============================================================
// AUTH HELPERS (shared pattern with admin.ts)
// ============================================================

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
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function checkIpAllowlist(c: ExecContext): { ok: boolean; reason?: string } {
  const allowedIps = parseAllowlist(c.env.ADMIN_ALLOWED_IPS);
  if (allowedIps.size === 0) {
    return { ok: true };
  }

  const clientIp = c.req.header('cf-connecting-ip')?.trim();
  if (!clientIp) {
    return { ok: false, reason: 'Client IP unavailable for allowlist check' };
  }

  // SECURITY FIX: Normalize IP to lowercase for case-insensitive comparison
  // (IPv6 addresses may arrive in mixed case, e.g., "2001:DB8::1" vs "2001:db8::1")
  if (!allowedIps.has(clientIp.toLowerCase())) {
    return { ok: false, reason: 'Client IP is not in allowlist' };
  }

  return { ok: true };
}

// ============================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================

/**
 * Authentication middleware for /exec routes
 * Requires either:
 * - Valid ADMIN_TOKEN in Authorization header
 * - Cloudflare Access authenticated user (via cf-access headers)
 */
executionRoutes.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization');
  const bearerToken = getBearerToken(authHeader);
  const cfAccessUser = c.req.header('cf-access-authenticated-user-email');
  const cfAccessJwt = c.req.header('cf-access-jwt-assertion');
  const adminToken = c.env.ADMIN_TOKEN;

  // Bearer token authentication
  if (adminToken && bearerToken === adminToken) {
    const ipCheck = checkIpAllowlist(c);
    if (!ipCheck.ok) {
      return c.json({ error: 'Forbidden', message: ipCheck.reason }, 403);
    }

    c.set('execUser', 'api-token-user');
    return next();
  }

  // Cloudflare Access authentication
  if (cfAccessUser) {
    if (!cfAccessJwt) {
      return c.json({
        error: 'Unauthorized',
        message: 'Cloudflare Access JWT assertion is required',
      }, 401);
    }

    // SECURITY FIX: Validate JWT signature, not just presence
    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
    const audience = c.env.CF_ACCESS_AUDIENCE;

    // SECURITY FIX: Fail-closed when CF Access headers present but env vars missing
    if (!teamDomain || !audience) {
      console.error('CF Access headers present but CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUDIENCE not configured');
      return c.json({
        error: 'Server Configuration Error',
        message: 'CF Access JWT validation not configured. Contact administrator.',
      }, 500);
    }

    // Validate the JWT cryptographically
    const validation = await validateCFAccessJWT(cfAccessJwt, teamDomain, audience);
    if (!validation.valid) {
      return c.json({
        error: 'Unauthorized',
        message: `JWT validation failed: ${validation.error}`,
      }, 401);
    }

    // Verify email matches JWT claims
    if (validation.claims.email.toLowerCase() !== cfAccessUser.toLowerCase()) {
      return c.json({
        error: 'Unauthorized',
        message: 'Email header does not match JWT claims',
      }, 401);
    }

    const allowedEmails = parseAllowlist(c.env.ADMIN_ALLOWED_EMAILS);
    if (allowedEmails.size > 0 && !allowedEmails.has(cfAccessUser.toLowerCase())) {
      return c.json({
        error: 'Forbidden',
        message: 'Authenticated user is not allowed for exec access',
      }, 403);
    }

    // IP allowlist check (same as admin routes)
    const ipCheck = checkIpAllowlist(c);
    if (!ipCheck.ok) {
      return c.json({ error: 'Forbidden', message: ipCheck.reason }, 403);
    }

    c.set('execUser', cfAccessUser);
    return next();
  }

  // No valid auth provided
  return c.json({
    error: 'Unauthorized',
    message: 'Authentication required. Provide Authorization: Bearer <token> or Cloudflare Access headers.',
  }, 401);
});

// ============================================================
// KALSHI EXECUTION AGENT ROUTES
// ============================================================

/**
 * GET /exec/kalshi/mode
 * Returns current execution mode of Kalshi execution agent.
 * Used to verify LIVE mode before deployment.
 */
executionRoutes.get('/kalshi/mode', async (c) => {
  try {
    const objectId = c.env.KALSHI_EXEC.idFromName('singleton');
    const stub = c.env.KALSHI_EXEC.get(objectId);
    const response = await stub.fetch('http://internal/mode');

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: 'Failed to get Kalshi execution mode',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

/**
 * GET /exec/kalshi/status
 * Returns full status of Kalshi execution agent including stats and mode.
 */
executionRoutes.get('/kalshi/status', async (c) => {
  try {
    const objectId = c.env.KALSHI_EXEC.idFromName('singleton');
    const stub = c.env.KALSHI_EXEC.get(objectId);
    const response = await stub.fetch('http://internal/status');

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: 'Failed to get Kalshi execution status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

/**
 * POST /exec/kalshi/mode/reload
 * Triggers the Kalshi execution agent to reload its mode from D1.
 */
executionRoutes.post('/kalshi/mode/reload', async (c) => {
  try {
    const objectId = c.env.KALSHI_EXEC.idFromName('singleton');
    const stub = c.env.KALSHI_EXEC.get(objectId);
    const response = await stub.fetch('http://internal/mode/reload', { method: 'POST' });

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: 'Failed to reload Kalshi execution mode',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

// ============================================================
// IBKR EXECUTION AGENT ROUTES
// ============================================================

/**
 * GET /exec/ibkr/mode
 * Returns current execution mode of IBKR execution agent.
 */
executionRoutes.get('/ibkr/mode', async (c) => {
  try {
    const objectId = c.env.IBKR_EXEC.idFromName('singleton');
    const stub = c.env.IBKR_EXEC.get(objectId);
    const response = await stub.fetch('http://internal/mode');

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: 'Failed to get IBKR execution mode',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

/**
 * GET /exec/ibkr/status
 * Returns full status of IBKR execution agent.
 */
executionRoutes.get('/ibkr/status', async (c) => {
  try {
    const objectId = c.env.IBKR_EXEC.idFromName('singleton');
    const stub = c.env.IBKR_EXEC.get(objectId);
    const response = await stub.fetch('http://internal/status');

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: 'Failed to get IBKR execution status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

/**
 * POST /exec/ibkr/mode/reload
 * Triggers the IBKR execution agent to reload its mode from D1.
 */
executionRoutes.post('/ibkr/mode/reload', async (c) => {
  try {
    const objectId = c.env.IBKR_EXEC.idFromName('singleton');
    const stub = c.env.IBKR_EXEC.get(objectId);
    const response = await stub.fetch('http://internal/mode/reload', { method: 'POST' });

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: 'Failed to reload IBKR execution mode',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});
