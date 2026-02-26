/**
 * Paul P - Polymarket Data API Client
 * Base URL: https://data-api.polymarket.com
 * No auth required - public endpoints
 *
 * Provides: leaderboard, profiles, positions, activity
 */

import type { Env } from '../../types/env';
import { Result, Ok, Err } from '../../types/env';
import type {
  DataAPIProfile,
  DataAPIPosition,
  DataAPIActivity,
  DataAPILeaderboardEntry,
  DataAPILeaderboardResponse,
  DataAPIPositionsResponse,
  DataAPIActivityResponse,
  NormalizedPosition,
  NormalizedTrade,
} from './types';
import { storeEvidence } from '../evidence/store';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const SOURCE_NAME = 'polymarket_data';

interface FetchOptions {
  endpoint: string;
  params?: Record<string, string>;
}

/**
 * Fetch from Data API with evidence storage
 */
async function fetchWithEvidence<T>(
  env: Env,
  options: FetchOptions
): Promise<Result<{ data: T; evidenceHash: string }, Error>> {
  const url = new URL(options.endpoint, DATA_API_BASE);

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
        new Error(`Data API error: ${response.status} ${response.statusText}`)
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
 * Fetch leaderboard
 */
export async function fetchLeaderboard(
  env: Env,
  options?: {
    limit?: number;
    cursor?: string;
  }
): Promise<Result<{ entries: DataAPILeaderboardEntry[]; evidenceHash: string; nextCursor?: string }, Error>> {
  const params: Record<string, string> = {};

  if (options?.limit) {
    params['limit'] = String(options.limit);
  }
  if (options?.cursor) {
    params['next_cursor'] = options.cursor;
  }

  const result = await fetchWithEvidence<DataAPILeaderboardResponse>(env, {
    endpoint: '/leaderboard',
    params,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    entries: result.value.data.data,
    evidenceHash: result.value.evidenceHash,
    nextCursor: result.value.data.next_cursor,
  });
}

/**
 * Fetch a profile by proxy wallet
 */
export async function fetchProfile(
  env: Env,
  proxyWallet: string
): Promise<Result<{ profile: DataAPIProfile; evidenceHash: string }, Error>> {
  const result = await fetchWithEvidence<DataAPIProfile>(env, {
    endpoint: `/profiles/${proxyWallet}`,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    profile: result.value.data,
    evidenceHash: result.value.evidenceHash,
  });
}

/**
 * Fetch positions for a profile
 */
export async function fetchPositions(
  env: Env,
  proxyWallet: string,
  options?: {
    limit?: number;
    cursor?: string;
    status?: 'open' | 'closed' | 'all';
  }
): Promise<Result<{ positions: DataAPIPosition[]; evidenceHash: string; nextCursor?: string }, Error>> {
  const params: Record<string, string> = {};

  if (options?.limit) {
    params['limit'] = String(options.limit);
  }
  if (options?.cursor) {
    params['next_cursor'] = options.cursor;
  }
  if (options?.status && options.status !== 'all') {
    params['status'] = options.status;
  }

  const result = await fetchWithEvidence<DataAPIPositionsResponse>(env, {
    endpoint: `/profiles/${proxyWallet}/positions`,
    params,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    positions: result.value.data.data,
    evidenceHash: result.value.evidenceHash,
    nextCursor: result.value.data.next_cursor,
  });
}

/**
 * Fetch activity for a profile
 */
export async function fetchActivity(
  env: Env,
  proxyWallet: string,
  options?: {
    limit?: number;
    cursor?: string;
  }
): Promise<Result<{ activities: DataAPIActivity[]; evidenceHash: string; nextCursor?: string }, Error>> {
  const params: Record<string, string> = {};

  if (options?.limit) {
    params['limit'] = String(options.limit);
  }
  if (options?.cursor) {
    params['next_cursor'] = options.cursor;
  }

  const result = await fetchWithEvidence<DataAPIActivityResponse>(env, {
    endpoint: `/profiles/${proxyWallet}/activity`,
    params,
  });

  if (!result.ok) {
    return Err(result.error);
  }

  return Ok({
    activities: result.value.data.data,
    evidenceHash: result.value.evidenceHash,
    nextCursor: result.value.data.next_cursor,
  });
}

/**
 * Normalize a Data API position to internal representation
 */
export function normalizePosition(pos: DataAPIPosition, evidenceHash: string): NormalizedPosition {
  return {
    id: pos.id,
    proxyWallet: pos.proxy_wallet,
    conditionId: pos.condition_id,
    tokenId: pos.token_id,
    marketSlug: pos.market_slug,
    side: pos.outcome.toUpperCase() === 'YES' ? 'YES' : 'NO',
    status: pos.resolved ? 'resolved' : pos.closed_at ? 'closed' : 'open',

    avgEntryPrice: pos.avg_price,
    totalSize: pos.size,
    totalCostUsd: pos.initial_value,
    firstTradeAt: pos.created_at,

    currentPrice: pos.cur_price,
    unrealizedPnl: pos.unrealized_pnl,

    realizedPnl: pos.realized_pnl,

    evidenceHash,
  };
}

/**
 * Normalize a Data API activity to internal trade representation
 */
export function normalizeActivity(activity: DataAPIActivity, evidenceHash: string): NormalizedTrade {
  return {
    id: activity.id,
    proxyWallet: activity.proxy_wallet,
    conditionId: activity.condition_id,
    tokenId: '', // Not provided in activity API
    side: activity.action.toUpperCase() as 'BUY' | 'SELL',
    outcomeSide: activity.outcome.toUpperCase() === 'YES' ? 'YES' : 'NO',
    price: activity.price,
    size: activity.size,
    timestamp: activity.timestamp,

    evidenceHash,
  };
}

/**
 * Fetch all positions for a profile (handles pagination)
 */
export async function fetchAllPositions(
  env: Env,
  proxyWallet: string,
  maxPositions = 1000
): Promise<Result<{ positions: NormalizedPosition[]; evidenceHashes: string[] }, Error>> {
  const positions: NormalizedPosition[] = [];
  const evidenceHashes: string[] = [];
  let cursor: string | undefined;

  while (positions.length < maxPositions) {
    const result = await fetchPositions(env, proxyWallet, {
      limit: 100,
      cursor,
    });

    if (!result.ok) {
      return Err(result.error);
    }

    evidenceHashes.push(result.value.evidenceHash);

    for (const pos of result.value.positions) {
      positions.push(normalizePosition(pos, result.value.evidenceHash));
    }

    cursor = result.value.nextCursor;
    if (!cursor) {
      break;
    }
  }

  return Ok({ positions, evidenceHashes });
}

/**
 * Fetch top N accounts from leaderboard
 */
export async function fetchTopAccounts(
  env: Env,
  count = 100
): Promise<Result<{ accounts: DataAPILeaderboardEntry[]; evidenceHashes: string[] }, Error>> {
  const accounts: DataAPILeaderboardEntry[] = [];
  const evidenceHashes: string[] = [];
  let cursor: string | undefined;

  while (accounts.length < count) {
    const result = await fetchLeaderboard(env, {
      limit: Math.min(100, count - accounts.length),
      cursor,
    });

    if (!result.ok) {
      return Err(result.error);
    }

    evidenceHashes.push(result.value.evidenceHash);
    accounts.push(...result.value.entries);

    cursor = result.value.nextCursor;
    if (!cursor) {
      break;
    }
  }

  return Ok({ accounts, evidenceHashes });
}
