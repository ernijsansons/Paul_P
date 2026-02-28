import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types/env';
import { adminRoutes } from '../../src/routes/admin';

type StubHandler = (url: URL) => Response | Promise<Response>;

function createNamespace(handler: StubHandler) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(new URL(rawUrl));
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
  const kalshi = createNamespace(async () => Response.json({ orders: [] }));
  const ibkr = createNamespace(async () => Response.json({ orders: [] }));

  return {
    ENVIRONMENT: 'test',
    SYSTEM_NAME: 'Paul P',
    ADMIN_TOKEN: 'admin-token',
    KALSHI_EXEC: kalshi.namespace as unknown as Env['KALSHI_EXEC'],
    IBKR_EXEC: ibkr.namespace as unknown as Env['IBKR_EXEC'],
    ...overrides,
  } as Env;
}

describe('admin /trades route', () => {
  it('merges and sorts trades from Kalshi and IBKR', async () => {
    const kalshi = createNamespace(async () =>
      Response.json({
        orders: [
          {
            order_id: 'k-1',
            status: 'filled',
            execution_mode: 'PAPER',
            created_at: '2026-02-28T10:00:00.000Z',
          },
          {
            order_id: 'k-2',
            status: 'open',
            execution_mode: 'PAPER',
            created_at: '2026-02-28T08:00:00.000Z',
          },
        ],
      })
    );
    const ibkr = createNamespace(async () =>
      Response.json({
        orders: [
          {
            order_id: 'i-1',
            status: 'filled',
            execution_mode: 'LIVE',
            created_at: '2026-02-28T11:00:00.000Z',
          },
        ],
      })
    );

    const env = createEnv({
      KALSHI_EXEC: kalshi.namespace as unknown as Env['KALSHI_EXEC'],
      IBKR_EXEC: ibkr.namespace as unknown as Env['IBKR_EXEC'],
    });

    const response = await adminRoutes.fetch(
      new Request('http://localhost/trades?limit=10', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      count: number;
      partial: boolean;
      trades: Array<{ order_id: string; venue: string }>;
    }>();

    expect(body.partial).toBe(false);
    expect(body.count).toBe(3);
    expect(body.trades[0]?.order_id).toBe('i-1');
    expect(body.trades[0]?.venue).toBe('ibkr');
    expect(body.trades[1]?.order_id).toBe('k-1');
    expect(kalshi.fetch).toHaveBeenCalledOnce();
    expect(ibkr.fetch).toHaveBeenCalledOnce();
  });

  it('supports venue + strategy + ticker + status + mode filters', async () => {
    const kalshi = createNamespace(async (url) => {
      expect(url.pathname).toBe('/orders/history');
      expect(url.searchParams.get('strategy')).toBe('bonding');
      expect(url.searchParams.get('ticker')).toBe('INX-26FEB28-B5000');
      expect(url.searchParams.get('limit')).toBe('25');

      return Response.json({
        orders: [
          {
            order_id: 'k-filled',
            status: 'filled',
            execution_mode: 'PAPER',
            created_at: '2026-02-28T12:00:00.000Z',
          },
          {
            order_id: 'k-open',
            status: 'open',
            execution_mode: 'PAPER',
            created_at: '2026-02-28T11:00:00.000Z',
          },
          {
            order_id: 'k-live',
            status: 'filled',
            execution_mode: 'LIVE',
            created_at: '2026-02-28T10:00:00.000Z',
          },
        ],
      });
    });

    const ibkr = createNamespace(async () => {
      throw new Error('IBKR should not be called for venue=kalshi');
    });

    const env = createEnv({
      KALSHI_EXEC: kalshi.namespace as unknown as Env['KALSHI_EXEC'],
      IBKR_EXEC: ibkr.namespace as unknown as Env['IBKR_EXEC'],
    });

    const response = await adminRoutes.fetch(
      new Request(
        'http://localhost/trades?venue=kalshi&strategy=bonding&ticker=INX-26FEB28-B5000&status=filled&mode=paper&limit=25',
        {
          headers: { authorization: 'Bearer admin-token' },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      count: number;
      partial: boolean;
      trades: Array<{ order_id: string; venue: string }>;
    }>();

    expect(body.partial).toBe(false);
    expect(body.count).toBe(1);
    expect(body.trades[0]?.order_id).toBe('k-filled');
    expect(body.trades[0]?.venue).toBe('kalshi');
    expect(kalshi.fetch).toHaveBeenCalledOnce();
    expect(ibkr.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid query parameters', async () => {
    const env = createEnv();

    const invalidVenue = await adminRoutes.fetch(
      new Request('http://localhost/trades?venue=bad', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );
    expect(invalidVenue.status).toBe(400);

    const invalidLimit = await adminRoutes.fetch(
      new Request('http://localhost/trades?limit=0', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );
    expect(invalidLimit.status).toBe(400);

    const invalidMode = await adminRoutes.fetch(
      new Request('http://localhost/trades?mode=invalid', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );
    expect(invalidMode.status).toBe(400);
  });

  it('returns partial=true when one venue fails', async () => {
    const kalshi = createNamespace(async () =>
      Response.json({
        orders: [
          {
            order_id: 'k-only',
            status: 'filled',
            execution_mode: 'PAPER',
            created_at: '2026-02-28T12:00:00.000Z',
          },
        ],
      })
    );
    const ibkr = createNamespace(async () => new Response('failure', { status: 500 }));

    const env = createEnv({
      KALSHI_EXEC: kalshi.namespace as unknown as Env['KALSHI_EXEC'],
      IBKR_EXEC: ibkr.namespace as unknown as Env['IBKR_EXEC'],
    });

    const response = await adminRoutes.fetch(
      new Request('http://localhost/trades', {
        headers: { authorization: 'Bearer admin-token' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      count: number;
      partial: boolean;
      errors?: Array<{ venue: string; message: string }>;
      trades: Array<{ order_id: string }>;
    }>();

    expect(body.partial).toBe(true);
    expect(body.count).toBe(1);
    expect(body.trades[0]?.order_id).toBe('k-only');
    expect(body.errors?.some((error) => error.venue === 'ibkr')).toBe(true);
  });
});
