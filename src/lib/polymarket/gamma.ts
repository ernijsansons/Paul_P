/**
 * Paul P - Polymarket Gamma API Client
 * Base URL: https://gamma-api.polymarket.com
 * No auth required - public endpoints
 *
 * CRITICAL: All responses must be stored as evidence blobs BEFORE parsing
 */

import type { Env } from '../../types/env';
import { Result, Ok, Err } from '../../types/env';
import type {
  GammaMarket,
  GammaEvent,
  GammaEventsResponse,
  NormalizedMarket,
} from './types';

// Re-export types for consumers
export type { NormalizedMarket } from './types';
import { storeEvidence } from '../evidence/store';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const SOURCE_NAME = 'polymarket_gamma';

interface FetchOptions {
  endpoint: string;
  params?: Record<string, string>;
}

/**
 * Fetch from Gamma API with evidence storage
 * Stores raw response BEFORE parsing (evidence-first architecture)
 */
async function fetchWithEvidence<T>(
  env: Env,
  options: FetchOptions
): Promise<Result<{ data: T; evidenceHash: string }, Error>> {
  const url = new URL(options.endpoint, GAMMA_API_BASE);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    console.log(`[GammaAPI] Fetching ${url.toString()}`);
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Paul-P/1.0',
      },
    });
    console.log(`[GammaAPI] Response status: ${response.status}`);

    if (!response.ok) {
      return Err(
        new Error(`Gamma API error: ${response.status} ${response.statusText}`)
      );
    }

    // Get raw bytes BEFORE parsing
    const rawBytes = await response.arrayBuffer();

    // Store evidence FIRST
    const evidenceResult = await storeEvidence(env, {
      source: SOURCE_NAME,
      endpoint: url.pathname + url.search,
      rawBytes,
      fetchedAt: new Date().toISOString(),
    });

    if (!evidenceResult.ok) {
      return Err(new Error(`Failed to store evidence: ${evidenceResult.error.message}`));
    }

    // NOW parse the response
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
 * Fetch all markets from Gamma API
 * Note: Gamma API returns a flat array, not a wrapped response object
 */
export async function fetchMarkets(
  env: Env,
  options?: {
    limit?: number;
    cursor?: string;
    active?: boolean;
  }
): Promise<Result<{ markets: GammaMarket[]; evidenceHash: string; nextCursor?: string }, Error>> {
  const params: Record<string, string> = {};

  if (options?.limit) {
    params['limit'] = String(options.limit);
  }
  if (options?.cursor) {
    params['next_cursor'] = options.cursor;
  }
  if (options?.active !== undefined) {
    params['active'] = String(options.active);
  }

  // Gamma API returns a flat array of markets, not a wrapped response
  const result = await fetchWithEvidence<GammaMarket[]>(env, {
    endpoint: '/markets',
    params,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  // The response is a flat array - no cursor pagination in Gamma API
  return Ok({
    markets: result.value.data,
    evidenceHash: result.value.evidenceHash,
    nextCursor: undefined, // Gamma API doesn't use cursor pagination for /markets
  });
}

/**
 * Fetch a single market by condition ID
 */
export async function fetchMarket(
  env: Env,
  conditionId: string
): Promise<Result<{ market: GammaMarket; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<GammaMarket>(env, {
    endpoint: `/markets/${conditionId}`,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    market: result.value.data,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Fetch events from Gamma API
 */
export async function fetchEvents(
  env: Env,
  options?: {
    limit?: number;
    cursor?: string;
  }
): Promise<Result<{ events: GammaEvent[]; evidenceHash: string; nextCursor?: string }, Error>> {
  const params: Record<string, string> = {};

  if (options?.limit) {
    params['limit'] = String(options.limit);
  }
  if (options?.cursor) {
    params['next_cursor'] = options.cursor;
  }

  const result = await fetchWithEvidence<GammaEventsResponse>(env, {
    endpoint: '/events',
    params,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    events: result.value.data.data,
    evidenceHash: result.value.evidenceHash,
    nextCursor: result.value.data.next_cursor,
  });
}

/**
 * Fetch a single event by ID
 */
export async function fetchEvent(
  env: Env,
  eventId: string
): Promise<Result<{ event: GammaEvent; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<GammaEvent>(env, {
    endpoint: `/events/${eventId}`,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    event: result.value.data,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Normalize a Gamma market to internal representation
 * Note: Gamma API uses camelCase field names
 */
export function normalizeGammaMarket(market: GammaMarket, evidenceHash: string): NormalizedMarket {
  // Parse outcome prices - API returns JSON stringified array
  let yesPrice = 0.5;
  let noPrice = 0.5;

  try {
    const prices = JSON.parse(market.outcomePrices) as string[];
    if (prices.length >= 2) {
      yesPrice = parseFloat(prices[0] ?? '0.5');
      noPrice = parseFloat(prices[1] ?? '0.5');
    }
  } catch {
    // Default to 50/50 if parsing fails
  }

  // Find resolution outcome from tokens (if available)
  let resolutionOutcome: 'YES' | 'NO' | 'VOID' | undefined;
  const isResolved = market.archived ?? false;
  if (isResolved && market.tokens) {
    const winningToken = market.tokens.find((t) => t.winner);
    if (winningToken) {
      resolutionOutcome = winningToken.outcome.toUpperCase() === 'YES' ? 'YES' : 'NO';
    }
  }

  // API uses camelCase: conditionId, endDate, resolutionSource, etc.
  return {
    conditionId: market.conditionId,
    question: market.question,
    description: market.description ?? '',
    resolutionSource: market.resolutionSource ?? market.resolution_source ?? '',
    resolutionCriteria: market.resolution_criteria ?? '',
    endDate: market.endDateIso ?? market.endDate ?? '',

    isActive: market.active,
    isClosed: market.closed,
    isResolved,
    resolutionOutcome,

    yesPrice,
    noPrice,
    midPrice: (yesPrice + (1 - noPrice)) / 2,
    // Spread must be clamped to [0, 1] for D1 CHECK constraint
    // Formula: yesPrice - (1 - noPrice) can be negative when prices are at extremes
    spread: Math.max(0, Math.min(1, Math.abs(yesPrice - (1 - noPrice)))),

    volumeUsd: market.volumeNum ?? (parseFloat(market.volume) || 0),
    volume24hUsd: market.volume24hr ?? 0,
    liquidityUsd: market.liquidityNum ?? (parseFloat(market.liquidity) || 0),

    category: market.category,
    tags: market.tags ?? [],
    series: market.slug,

    evidenceHash,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch and normalize all active markets
 */
export async function fetchAllActiveMarkets(
  env: Env,
  maxMarkets = 1000
): Promise<Result<{ markets: NormalizedMarket[]; evidenceHashes: string[] }, Error>> {
  const markets: NormalizedMarket[] = [];
  const evidenceHashes: string[] = [];
  let cursor: string | undefined;

  while (markets.length < maxMarkets) {
    const result = await fetchMarkets(env, {
      limit: 100,
      cursor,
      active: true,
    });

    if (!result.ok) {
      return Err(result.error);
    }

    evidenceHashes.push(result.value.evidenceHash);

    for (const market of result.value.markets) {
      markets.push(normalizeGammaMarket(market, result.value.evidenceHash));
    }

    cursor = result.value.nextCursor;
    if (!cursor) {
      break;
    }
  }

  return Ok({ markets, evidenceHashes });
}
