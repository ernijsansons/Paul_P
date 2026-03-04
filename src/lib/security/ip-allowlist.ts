/**
 * IP Allowlist Security Module
 *
 * Provides shared IP allowlist checking for admin, dashboard, and execution routes.
 */

import type { Context } from 'hono';

/**
 * Parse a comma-separated allowlist string into a Set
 */
export function parseAllowlist(raw: string | undefined): Set<string> {
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

/**
 * Check if client IP is in the allowlist
 *
 * @param c - Hono context with Env bindings containing ADMIN_ALLOWED_IPS
 * @returns { ok: true } if allowed, { ok: false, reason: string } if blocked
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function checkIpAllowlist(c: Context<any>): { ok: boolean; reason?: string } {
  const allowedIps = parseAllowlist(c.env?.ADMIN_ALLOWED_IPS);

  // If no allowlist configured, allow all IPs
  if (allowedIps.size === 0) {
    return { ok: true };
  }

  const clientIp = c.req.header('cf-connecting-ip')?.trim();

  if (!clientIp) {
    return { ok: false, reason: 'Client IP unavailable for allowlist check' };
  }

  if (!allowedIps.has(clientIp.toLowerCase())) {
    return { ok: false, reason: 'Client IP is not in allowlist' };
  }

  return { ok: true };
}
