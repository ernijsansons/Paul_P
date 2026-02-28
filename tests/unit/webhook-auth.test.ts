import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/types/env';
import { webhookRoutes } from '../../src/routes/webhooks';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'Paul P',
    ...overrides,
  } as Env;
}

describe('webhook route auth middleware', () => {
  it('requires bearer token for trigger routes', async () => {
    const env = createEnv({
      WEBHOOK_TRIGGER_TOKEN: 'trigger-secret',
    });

    const response = await webhookRoutes.fetch(
      new Request('http://localhost/trigger/ingest', {
        method: 'POST',
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('allows authenticated trigger requests through middleware', async () => {
    const env = createEnv({
      WEBHOOK_TRIGGER_TOKEN: 'trigger-secret',
    });

    const response = await webhookRoutes.fetch(
      new Request('http://localhost/trigger/not-real', {
        method: 'POST',
        headers: {
          authorization: 'Bearer trigger-secret',
        },
      }),
      env
    );

    // Auth passes; route is missing so Hono returns 404.
    expect(response.status).toBe(404);
  });

  it('requires shared secret for Kalshi events route', async () => {
    const env = createEnv({
      KALSHI_WEBHOOK_SECRET: 'kalshi-secret',
    });

    const response = await webhookRoutes.fetch(
      new Request('http://localhost/kalshi/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ event_type: 'order_update', payload: {} }),
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('accepts valid Kalshi secret and processes unknown events safely', async () => {
    const env = createEnv({
      KALSHI_WEBHOOK_SECRET: 'kalshi-secret',
    });

    const response = await webhookRoutes.fetch(
      new Request('http://localhost/kalshi/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kalshi-webhook-secret': 'kalshi-secret',
        },
        body: JSON.stringify({ event_type: 'unknown_type', payload: {} }),
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ received: boolean }>();
    expect(body.received).toBe(true);
  });
});
