/**
 * Paul P - Kalshi Trade API Client
 * Base URL: https://api.elections.kalshi.com/trade-api/v2
 *
 * Public endpoints (no auth): markets, orderbook, trades, candlesticks
 * Trading endpoints (RSA-PSS auth): orders, positions, balance
 */

import type { Env } from '../../types/env';
import { Result, Ok, Err } from '../../types/env';
import type {
  KalshiMarket,
  KalshiMarketsResponse,
  KalshiEvent,
  KalshiEventsResponse,
  KalshiOrderbook,
  KalshiOrderbookResponse,
  KalshiTrade,
  KalshiTradesResponse,
  KalshiCandlestick,
  KalshiCandlesticksResponse,
  KalshiOrder,
  KalshiOrderRequest,
  KalshiOrderResponse,
  KalshiOrdersResponse,
  KalshiPosition,
  KalshiPositionsResponse,
  KalshiPortfolioBalance,
  NormalizedKalshiMarket,
} from './types';

// Re-export types for consumers
export type { NormalizedKalshiMarket } from './types';
import { generateKalshiAuthHeaders, requiresAuth } from './auth';
import { storeEvidence } from '../evidence/store';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const SOURCE_NAME = 'kalshi_api';

interface FetchOptions {
  endpoint: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  params?: Record<string, string>;
  body?: unknown;
}

/**
 * Fetch from Kalshi API with evidence storage
 */
async function fetchWithEvidence<T>(
  env: Env,
  options: FetchOptions
): Promise<Result<{ data: T; evidenceHash: string }, Error>> {
  const url = new URL(options.endpoint, KALSHI_API_BASE);
  const method = options.method ?? 'GET';

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Paul-P/1.0',
  };

  let bodyStr: string | undefined;
  if (options.body) {
    bodyStr = JSON.stringify(options.body);
  }

  // Add auth headers if required
  const fullPath = url.pathname + url.search;
  if (requiresAuth(fullPath)) {
    const authResult = await generateKalshiAuthHeaders(env, method, fullPath, bodyStr);
    if (!authResult.ok) {
      return Err(authResult.error);
    }
    Object.assign(headers, authResult.value);
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return Err(
        new Error(`Kalshi API error: ${response.status} ${response.statusText} - ${errorText}`)
      );
    }

    const rawBytes = await response.arrayBuffer();

    const evidenceResult = await storeEvidence(env, {
      source: SOURCE_NAME,
      endpoint: url.pathname + url.search,
      rawBytes,
      fetchedAt: new Date().toISOString(),
      requestMethod: method,
    });

    if (!evidenceResult.ok) {
      return Err(new Error(`Failed to store evidence: ${evidenceResult.error.message}`));
    }

    const text = new TextDecoder().decode(rawBytes);
    const data = JSON.parse(text) as T;

    return Ok({
      data,
      evidenceHash: evidenceResult.value.evidenceHash,
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================
// PUBLIC ENDPOINTS (No Auth)
// ============================================================

/**
 * Fetch markets
 */
export async function fetchMarkets(
  env: Env,
  options?: {
    limit?: number;
    cursor?: string;
    status?: 'active' | 'closed' | 'settled';
    seriesTicker?: string;
    eventTicker?: string;
  }
): Promise<Result<{ markets: KalshiMarket[]; evidenceHash: string; cursor?: string }, Error>> {
  const params: Record<string, string> = {};

  if (options?.limit) params['limit'] = String(options.limit);
  if (options?.cursor) params['cursor'] = options.cursor;
  if (options?.status) params['status'] = options.status;
  if (options?.seriesTicker) params['series_ticker'] = options.seriesTicker;
  if (options?.eventTicker) params['event_ticker'] = options.eventTicker;

  const result = await fetchWithEvidence<KalshiMarketsResponse>(env, {
    endpoint: '/markets',
    params,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    markets: result.value.data.markets,
    evidenceHash: result.value.evidenceHash,
    cursor: result.value.data.cursor ?? undefined,
  });
}

/**
 * Fetch a single market by ticker
 */
export async function fetchMarket(
  env: Env,
  ticker: string
): Promise<Result<{ market: KalshiMarket; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<{ market: KalshiMarket }>(env, {
    endpoint: `/markets/${ticker}`,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    market: result.value.data.market,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Fetch events
 */
export async function fetchEvents(
  env: Env,
  options?: {
    limit?: number;
    cursor?: string;
    status?: 'active' | 'closed' | 'settled';
    seriesTicker?: string;
  }
): Promise<Result<{ events: KalshiEvent[]; evidenceHash: string; cursor?: string }, Error>> {
  const params: Record<string, string> = {};

  if (options?.limit) params['limit'] = String(options.limit);
  if (options?.cursor) params['cursor'] = options.cursor;
  if (options?.status) params['status'] = options.status;
  if (options?.seriesTicker) params['series_ticker'] = options.seriesTicker;

  const result = await fetchWithEvidence<KalshiEventsResponse>(env, {
    endpoint: '/events',
    params,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    events: result.value.data.events,
    evidenceHash: result.value.evidenceHash,
    cursor: result.value.data.cursor ?? undefined,
  });
}

/**
 * Fetch orderbook for a market
 */
export async function fetchOrderbook(
  env: Env,
  ticker: string,
  depth?: number
): Promise<Result<{ orderbook: KalshiOrderbook; evidenceHash: string }, Error>> {
  const params: Record<string, string> = {};
  if (depth) params['depth'] = String(depth);

  const result = await fetchWithEvidence<KalshiOrderbookResponse>(env, {
    endpoint: `/markets/${ticker}/orderbook`,
    params,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    orderbook: result.value.data.orderbook,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Fetch trades for a market
 */
export async function fetchTrades(
  env: Env,
  ticker: string,
  options?: {
    limit?: number;
    cursor?: string;
  }
): Promise<Result<{ trades: KalshiTrade[]; evidenceHash: string; cursor?: string }, Error>> {
  const params: Record<string, string> = {};
  if (options?.limit) params['limit'] = String(options.limit);
  if (options?.cursor) params['cursor'] = options.cursor;

  const result = await fetchWithEvidence<KalshiTradesResponse>(env, {
    endpoint: `/markets/${ticker}/trades`,
    params,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    trades: result.value.data.trades,
    evidenceHash: result.value.evidenceHash,
    cursor: result.value.data.cursor ?? undefined,
  });
}

/**
 * Fetch candlesticks for a market
 */
export async function fetchCandlesticks(
  env: Env,
  ticker: string,
  options?: {
    periodInterval?: number; // in minutes
    startTs?: number;
    endTs?: number;
  }
): Promise<Result<{ candlesticks: KalshiCandlestick[]; evidenceHash: string }, Error>> {
  const params: Record<string, string> = {};
  if (options?.periodInterval) params['period_interval'] = String(options.periodInterval);
  if (options?.startTs) params['start_ts'] = String(options.startTs);
  if (options?.endTs) params['end_ts'] = String(options.endTs);

  const result = await fetchWithEvidence<KalshiCandlesticksResponse>(env, {
    endpoint: `/markets/${ticker}/candlesticks`,
    params,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    candlesticks: result.value.data.candlesticks,
    evidenceHash: result.value.evidenceHash,
  });
}

// ============================================================
// AUTHENTICATED ENDPOINTS (Trading)
// ============================================================

/**
 * Submit an order
 */
export async function submitOrder(
  env: Env,
  order: KalshiOrderRequest
): Promise<Result<{ order: KalshiOrder; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<KalshiOrderResponse>(env, {
    endpoint: '/portfolio/orders',
    method: 'POST',
    body: order,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    order: result.value.data.order,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Cancel an order
 */
export async function cancelOrder(
  env: Env,
  orderId: string
): Promise<Result<{ order: KalshiOrder; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<KalshiOrderResponse>(env, {
    endpoint: `/portfolio/orders/${orderId}`,
    method: 'DELETE',
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    order: result.value.data.order,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Get open orders
 */
export async function getOrders(
  env: Env,
  options?: {
    ticker?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }
): Promise<Result<{ orders: KalshiOrder[]; evidenceHash: string; cursor?: string }, Error>> {
  const params: Record<string, string> = {};
  if (options?.ticker) params['ticker'] = options.ticker;
  if (options?.status) params['status'] = options.status;
  if (options?.limit) params['limit'] = String(options.limit);
  if (options?.cursor) params['cursor'] = options.cursor;

  const result = await fetchWithEvidence<KalshiOrdersResponse>(env, {
    endpoint: '/portfolio/orders',
    params,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    orders: result.value.data.orders,
    evidenceHash: result.value.evidenceHash,
    cursor: result.value.data.cursor ?? undefined,
  });
}

/**
 * Get positions
 */
export async function getPositions(
  env: Env,
  options?: {
    ticker?: string;
    eventTicker?: string;
    limit?: number;
    cursor?: string;
  }
): Promise<Result<{ positions: KalshiPosition[]; evidenceHash: string; cursor?: string }, Error>> {
  const params: Record<string, string> = {};
  if (options?.ticker) params['ticker'] = options.ticker;
  if (options?.eventTicker) params['event_ticker'] = options.eventTicker;
  if (options?.limit) params['limit'] = String(options.limit);
  if (options?.cursor) params['cursor'] = options.cursor;

  const result = await fetchWithEvidence<KalshiPositionsResponse>(env, {
    endpoint: '/portfolio/positions',
    params,
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    positions: result.value.data.market_positions,
    evidenceHash: result.value.evidenceHash,
    cursor: result.value.data.cursor ?? undefined,
  });
}

/**
 * Get portfolio balance
 */
export async function getBalance(
  env: Env
): Promise<Result<{ balance: KalshiPortfolioBalance; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<KalshiPortfolioBalance>(env, {
    endpoint: '/portfolio/balance',
  });

  if (!result.ok) return Err(result.error);

  return Ok({
    balance: result.value.data,
    evidenceHash: result.value.evidenceHash,
  });
}

// ============================================================
// NORMALIZATION
// ============================================================

/**
 * Normalize a Kalshi market to internal representation
 */
export function normalizeKalshiMarket(market: KalshiMarket, evidenceHash: string): NormalizedKalshiMarket {
  // Kalshi prices are in cents (1-99)
  const yesBid = market.yes_bid / 100;
  const yesAsk = market.yes_ask / 100;
  const noBid = market.no_bid / 100;
  const noAsk = market.no_ask / 100;

  const midPrice = (yesBid + yesAsk) / 2;
  const spread = yesAsk - yesBid;

  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title,
    rulesText: market.rules_primary + (market.rules_secondary ? '\n' + market.rules_secondary : ''),

    status: market.status,
    result: market.result ? (market.result.toUpperCase() as 'YES' | 'NO') : undefined,

    yesBid,
    yesAsk,
    noBid,
    noAsk,
    lastPrice: market.last_price / 100,

    midPrice,
    spread,

    volume24h: market.volume_24h,
    dollarVolume24h: market.dollar_volume_24h,
    openInterest: market.open_interest,

    closeTime: market.close_time,
    settlementTime: market.settlement_time,

    category: market.category,
    seriesTicker: market.series_ticker,

    evidenceHash,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch all active markets with normalization
 */
export async function fetchAllActiveMarkets(
  env: Env,
  maxMarkets = 1000
): Promise<Result<{ markets: NormalizedKalshiMarket[]; evidenceHashes: string[] }, Error>> {
  const markets: NormalizedKalshiMarket[] = [];
  const evidenceHashes: string[] = [];
  let cursor: string | undefined;

  while (markets.length < maxMarkets) {
    const result = await fetchMarkets(env, {
      limit: 100,
      cursor,
      status: 'active',
    });

    if (!result.ok) return Err(result.error);

    evidenceHashes.push(result.value.evidenceHash);

    for (const market of result.value.markets) {
      markets.push(normalizeKalshiMarket(market, result.value.evidenceHash));
    }

    cursor = result.value.cursor;
    if (!cursor) break;
  }

  return Ok({ markets, evidenceHashes });
}
