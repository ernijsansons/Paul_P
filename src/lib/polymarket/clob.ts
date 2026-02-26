/**
 * Paul P - Polymarket CLOB API Client
 * Base URL: https://clob.polymarket.com
 * No auth required - public endpoints
 *
 * Provides: orderbook depth, midpoints, spreads, trade history
 */

import type { Env } from '../../types/env';
import { Result, Ok, Err } from '../../types/env';
import type {
  CLOBOrderbook,
  CLOBMidpoint,
  CLOBPrice,
  CLOBTrade,
  CLOBTradesResponse,
} from './types';
import { storeEvidence } from '../evidence/store';

const CLOB_API_BASE = 'https://clob.polymarket.com';
const SOURCE_NAME = 'polymarket_clob';

interface FetchOptions {
  endpoint: string;
  params?: Record<string, string>;
}

/**
 * Fetch from CLOB API with evidence storage
 */
async function fetchWithEvidence<T>(
  env: Env,
  options: FetchOptions
): Promise<Result<{ data: T; evidenceHash: string }, Error>> {
  const url = new URL(options.endpoint, CLOB_API_BASE);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Paul-P/1.0',
      },
    });

    if (!response.ok) {
      return Err(
        new Error(`CLOB API error: ${response.status} ${response.statusText}`)
      );
    }

    const rawBytes = await response.arrayBuffer();

    const evidenceResult = await storeEvidence(env, {
      source: SOURCE_NAME,
      endpoint: url.pathname + url.search,
      rawBytes,
      fetchedAt: new Date().toISOString(),
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

/**
 * Fetch orderbook for a token/market
 */
export async function fetchOrderbook(
  env: Env,
  tokenId: string
): Promise<Result<{ orderbook: CLOBOrderbook; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<CLOBOrderbook>(env, {
    endpoint: '/book',
    params: { token_id: tokenId },
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    orderbook: result.value.data,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Fetch midpoint price for a token
 */
export async function fetchMidpoint(
  env: Env,
  tokenId: string
): Promise<Result<{ midpoint: CLOBMidpoint; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<CLOBMidpoint>(env, {
    endpoint: '/midpoint',
    params: { token_id: tokenId },
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    midpoint: result.value.data,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Fetch last trade price for a token
 */
export async function fetchPrice(
  env: Env,
  tokenId: string
): Promise<Result<{ price: CLOBPrice; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<CLOBPrice>(env, {
    endpoint: '/price',
    params: { token_id: tokenId },
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    price: result.value.data,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Fetch recent trades for a market
 */
export async function fetchTrades(
  env: Env,
  marketId: string,
  options?: {
    limit?: number;
    cursor?: string;
  }
): Promise<Result<{ trades: CLOBTrade[]; evidenceHash: string; nextCursor?: string }, Error>> {
  const params: Record<string, string> = {
    market: marketId,
  };

  if (options?.limit) {
    params['limit'] = String(options.limit);
  }
  if (options?.cursor) {
    params['next_cursor'] = options.cursor;
  }

  const result = await fetchWithEvidence<CLOBTradesResponse>(env, {
    endpoint: '/trades',
    params,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    trades: result.value.data.data,
    evidenceHash: result.value.evidenceHash,
    nextCursor: result.value.data.next_cursor,
  });
}

/**
 * Parse orderbook and compute depth at various levels
 */
export interface OrderbookMetrics {
  bestBidYes: number;
  bestAskYes: number;
  midPrice: number;
  spread: number;
  spreadPct: number;
  depth1Pct: number; // Total depth within 1% of mid
  depth2Pct: number;
  depth5Pct: number;
  totalBidDepth: number;
  totalAskDepth: number;
}

export function computeOrderbookMetrics(orderbook: CLOBOrderbook): OrderbookMetrics {
  const bids = orderbook.bids.map((b) => ({
    price: parseFloat(b.price),
    size: parseFloat(b.size),
  }));

  const asks = orderbook.asks.map((a) => ({
    price: parseFloat(a.price),
    size: parseFloat(a.size),
  }));

  // Best prices
  const bestBidYes = bids[0]?.price ?? 0;
  const bestAskYes = asks[0]?.price ?? 1;

  // Midpoint and spread
  const midPrice = (bestBidYes + bestAskYes) / 2;
  const spread = bestAskYes - bestBidYes;
  const spreadPct = midPrice > 0 ? spread / midPrice : 0;

  // Compute depth at various levels
  const computeDepthWithinPct = (pct: number): number => {
    const lowerBound = midPrice * (1 - pct);
    const upperBound = midPrice * (1 + pct);

    let depth = 0;

    for (const bid of bids) {
      if (bid.price >= lowerBound) {
        depth += bid.size * bid.price;
      }
    }

    for (const ask of asks) {
      if (ask.price <= upperBound) {
        depth += ask.size * ask.price;
      }
    }

    return depth;
  };

  const totalBidDepth = bids.reduce((sum, b) => sum + b.size * b.price, 0);
  const totalAskDepth = asks.reduce((sum, a) => sum + a.size * a.price, 0);

  return {
    bestBidYes,
    bestAskYes,
    midPrice,
    spread,
    spreadPct,
    depth1Pct: computeDepthWithinPct(0.01),
    depth2Pct: computeDepthWithinPct(0.02),
    depth5Pct: computeDepthWithinPct(0.05),
    totalBidDepth,
    totalAskDepth,
  };
}

/**
 * Fetch orderbook and compute metrics in one call
 */
export async function fetchOrderbookWithMetrics(
  env: Env,
  tokenId: string
): Promise<Result<{ orderbook: CLOBOrderbook; metrics: OrderbookMetrics; evidenceHash: string }, Error>> {
  const result = await fetchOrderbook(env, tokenId);

  if (!result.ok) {
    return Err(result.error);
  }

  const metrics = computeOrderbookMetrics(result.value.orderbook);

  return Ok({
    orderbook: result.value.orderbook,
    metrics,
    evidenceHash: result.value.evidenceHash,
  });
}
