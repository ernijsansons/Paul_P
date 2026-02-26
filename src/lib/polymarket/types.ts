/**
 * Paul P - Polymarket API Types
 * Type definitions for Polymarket Gamma, CLOB, and Data APIs
 */

// ============================================================
// GAMMA API TYPES (gamma-api.polymarket.com)
// ============================================================

export interface GammaMarket {
  id: string;
  condition_id: string;
  question: string;
  description: string;
  end_date_iso: string;
  resolution_source: string;
  resolution_criteria?: string;

  // Token data
  tokens: GammaToken[];

  // Status
  active: boolean;
  closed: boolean;
  resolved: boolean;

  // Pricing
  outcome_prices: string; // JSON stringified array

  // Volume
  volume: string;
  volume_24h: string;
  liquidity: string;

  // Classification
  tags?: string[];
  series?: string;
  category?: string;

  // Timestamps
  created_at: string;
  updated_at: string;
}

export interface GammaToken {
  token_id: string;
  outcome: string; // 'Yes' or 'No'
  price: number;
  winner?: boolean;
}

export interface GammaEvent {
  id: string;
  title: string;
  description: string;
  markets: GammaMarket[];
  slug: string;
  start_date: string;
  end_date: string;
  image?: string;
}

export interface GammaMarketsResponse {
  data: GammaMarket[];
  next_cursor?: string;
}

export interface GammaEventsResponse {
  data: GammaEvent[];
  next_cursor?: string;
}

// ============================================================
// CLOB API TYPES (clob.polymarket.com)
// ============================================================

export interface CLOBOrderbook {
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
  bids: CLOBOrderbookLevel[];
  asks: CLOBOrderbookLevel[];
}

export interface CLOBOrderbookLevel {
  price: string;
  size: string;
}

export interface CLOBMidpoint {
  mid: string;
  timestamp: string;
}

export interface CLOBPrice {
  price: string;
  timestamp: string;
}

export interface CLOBTrade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  fee_rate_bps: string;
  timestamp: string;
  transaction_hash?: string;
}

export interface CLOBTradesResponse {
  data: CLOBTrade[];
  next_cursor?: string;
}

// ============================================================
// DATA API TYPES (data-api.polymarket.com)
// ============================================================

export interface DataAPIProfile {
  id: string;
  proxy_wallet: string;
  username?: string;
  profile_image?: string;
  x_username?: string;
  pnl: number;
  volume: number;
  rank?: number;
  markets_traded: number;
  win_count: number;
  loss_count: number;
  created_at: string;
}

export interface DataAPIPosition {
  id: string;
  proxy_wallet: string;
  condition_id: string;
  token_id: string;
  market_slug: string;
  outcome: string; // 'Yes' or 'No'
  size: number;
  avg_price: number;
  initial_value: number;
  current_value: number;
  realized_pnl: number;
  unrealized_pnl: number;
  cur_price: number;
  created_at: string;
  closed_at?: string;
  resolved?: boolean;
}

export interface DataAPIActivity {
  id: string;
  proxy_wallet: string;
  condition_id: string;
  market_slug: string;
  action: 'buy' | 'sell';
  outcome: string;
  size: number;
  price: number;
  timestamp: string;
}

export interface DataAPILeaderboardEntry {
  proxy_wallet: string;
  username?: string;
  pnl: number;
  volume: number;
  rank: number;
}

export interface DataAPILeaderboardResponse {
  data: DataAPILeaderboardEntry[];
  next_cursor?: string;
}

export interface DataAPIPositionsResponse {
  data: DataAPIPosition[];
  next_cursor?: string;
}

export interface DataAPIActivityResponse {
  data: DataAPIActivity[];
  next_cursor?: string;
}

// ============================================================
// INTERNAL NORMALIZED TYPES
// ============================================================

export interface NormalizedMarket {
  conditionId: string;
  question: string;
  description: string;
  resolutionSource: string;
  resolutionCriteria: string;
  endDate: string;

  // Status
  isActive: boolean;
  isClosed: boolean;
  isResolved: boolean;
  resolutionOutcome?: 'YES' | 'NO' | 'VOID';

  // Pricing (normalized)
  yesPrice: number;
  noPrice: number;
  midPrice: number;
  spread: number;

  // Volume
  volumeUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;

  // Classification
  category?: string;
  tags: string[];
  series?: string;

  // Evidence
  evidenceHash?: string;

  // Timestamps
  fetchedAt: string;
}

export interface NormalizedPosition {
  id: string;
  proxyWallet: string;
  conditionId: string;
  tokenId: string;
  marketSlug: string;
  side: 'YES' | 'NO';
  status: 'open' | 'closed' | 'resolved';

  // Entry
  avgEntryPrice: number;
  totalSize: number;
  totalCostUsd: number;
  firstTradeAt: string;

  // Current state
  currentPrice: number;
  unrealizedPnl: number;

  // Resolution (if closed/resolved)
  realizedPnl?: number;
  exitPrice?: number;

  // Evidence
  evidenceHash?: string;
}

export interface NormalizedTrade {
  id: string;
  proxyWallet: string;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  outcomeSide: 'YES' | 'NO';
  price: number;
  size: number;
  timestamp: string;

  // Context
  midPriceAtTrade?: number;
  spreadAtTrade?: number;

  // Evidence
  evidenceHash?: string;
}
