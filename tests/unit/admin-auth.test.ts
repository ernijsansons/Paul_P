import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/types/env';
import { adminRoutes } from '../../src/routes/admin';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'Paul P',
    ADMIN_TOKEN: 'admin-token',
    ...overrides,
  } as Env;
}

describe('admin route auth middleware', () => {
  it('rejects Cloudflare Access email header without JWT assertion', async () => {
    const env = createEnv();
    const response = await adminRoutes.fetch(
      new Request('http://localhost/unknown', {
        headers: {
          'cf-access-authenticated-user-email': 'operator@example.com',
        },
      }),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.json<{ message: string }>();
    expect(body.message).toContain('JWT assertion');
  });

  it('enforces Access email allowlist when configured', async () => {
    const env = createEnv({
      ADMIN_ALLOWED_EMAILS: 'approved@example.com',
    });

    const response = await adminRoutes.fetch(
      new Request('http://localhost/unknown', {
        headers: {
          'cf-access-authenticated-user-email': 'blocked@example.com',
          'cf-access-jwt-assertion': 'jwt-token',
        },
      }),
      env
    );

    expect(response.status).toBe(403);
  });

  it('allows bearer token auth and continues routing', async () => {
    const env = createEnv();

    const response = await adminRoutes.fetch(
      new Request('http://localhost/unknown', {
        headers: {
          authorization: 'Bearer admin-token',
        },
      }),
      env
    );

    // Auth passes; route is missing so Hono returns 404.
    expect(response.status).toBe(404);
  });

  it('requires Turnstile token on mutating admin routes when configured', async () => {
    const env = createEnv({
      ADMIN_TURNSTILE_SECRET: 'turnstile-secret',
    });

    const response = await adminRoutes.fetch(
      new Request('http://localhost/reconcile', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
        },
      }),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.json<{ message: string }>();
    expect(body.message).toContain('Turnstile token required');
  });

  it('enforces admin IP allowlist when configured', async () => {
    const env = createEnv({
      ADMIN_ALLOWED_IPS: '203.0.113.10',
    });

    const denied = await adminRoutes.fetch(
      new Request('http://localhost/unknown', {
        headers: {
          authorization: 'Bearer admin-token',
          'cf-connecting-ip': '198.51.100.20',
        },
      }),
      env
    );
    expect(denied.status).toBe(403);

    const allowed = await adminRoutes.fetch(
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
