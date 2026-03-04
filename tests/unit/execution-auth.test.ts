import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/types/env';
import { executionRoutes } from '../../src/routes/execution';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'Paul P',
    ADMIN_TOKEN: 'admin-token',
    ...overrides,
  } as Env;
}

describe('execution route auth middleware', () => {
  it('rejects request without auth headers', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode'),
      env
    );

    expect(response.status).toBe(401);
  });

  it('allows bearer token auth', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/unknown', {
        headers: {
          authorization: 'Bearer admin-token',
        },
      }),
      env
    );

    // Auth passes; route is missing so Hono returns 404
    expect(response.status).toBe(404);
  });

  it('rejects Cloudflare Access email header without JWT assertion', async () => {
    const env = createEnv();

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: {
          'cf-access-authenticated-user-email': 'operator@example.com',
        },
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('returns 500 when CF Access headers present but env vars missing (fail-closed)', async () => {
    const env = createEnv({
      // CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUDIENCE not set
    });

    const response = await executionRoutes.fetch(
      new Request('http://localhost/kalshi/mode', {
        headers: {
          'cf-access-authenticated-user-email': 'user@example.com',
          'cf-access-jwt-assertion': 'any-jwt-value',
        },
      }),
      env
    );

    expect(response.status).toBe(500);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe('Server Configuration Error');
    expect(body.message).toContain('CF Access JWT validation not configured');
  });

  it('enforces admin IP allowlist when configured', async () => {
    const env = createEnv({
      ADMIN_ALLOWED_IPS: '203.0.113.10',
    });

    const denied = await executionRoutes.fetch(
      new Request('http://localhost/unknown', {
        headers: {
          authorization: 'Bearer admin-token',
          'cf-connecting-ip': '198.51.100.20',
        },
      }),
      env
    );
    expect(denied.status).toBe(403);

    const allowed = await executionRoutes.fetch(
      new Request('http://localhost/unknown', {
        headers: {
          authorization: 'Bearer admin-token',
          'cf-connecting-ip': '203.0.113.10',
        },
      }),
      env
    );
    expect(allowed.status).toBe(404);
  });
});
