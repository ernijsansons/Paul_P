/**
 * Paul P - Kalshi API Types
 * Type definitions for Kalshi Trade API v2
 */

// ============================================================
// MARKET TYPES
// ============================================================

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  open_time: string;
  close_time: string;
  expiration_time: string;
  settlement_time: string;
  status: 'active' | 'closed' | 'settled';
  result: 'yes' | 'no' | null;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  previous_yes_bid: number;
  previous_yes_ask: number;
  previous_price: number;
  volume: number;
  volume_24h: number;
  liquidity: number;
  open_interest: number;
  dollar_volume: number;
  dollar_volume_24h: number;
  dollar_open_interest: number;
  cap_strike: number;
  floor_strike: number;
  settlement_value: number | null;
  category: string;
  series_ticker: string;
  rules_primary: string;
  rules_secondary: string;
  expected_expiration_time: string;
  can_close_early: boolean;
  settlement_timer_seconds: number;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string | null;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  sub_title: string;
  title: string;
  mutually_exclusive: boolean;
  markets: KalshiMarket[];
  category: string;
}

export interface KalshiEventsResponse {
  events: KalshiEvent[];
  cursor: string | null;
}

// ============================================================
// ORDERBOOK TYPES
// ============================================================

export interface KalshiOrderbook {
  ticker: string;
  yes: KalshiOrderbookSide;
  no: KalshiOrderbookSide;
}

export interface KalshiOrderbookSide {
  [price: string]: number; // price -> quantity
}

export interface KalshiOrderbookResponse {
  orderbook: KalshiOrderbook;
}

// ============================================================
// TRADE TYPES
// ============================================================

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  yes_price: number;
  no_price: number;
  count: number;
  taker_side: 'yes' | 'no';
  created_time: string;
}

export interface KalshiTradesResponse {
  trades: KalshiTrade[];
  cursor: string | null;
}

// ============================================================
// CANDLESTICK TYPES
// ============================================================

export interface KalshiCandlestick {
  ticker: string;
  period_interval: number;
  end_period_ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  yes_open_interest: number;
  no_open_interest: number;
}

export interface KalshiCandlesticksResponse {
  candlesticks: KalshiCandlestick[];
  cursor: string | null;
}

// ============================================================
// ORDER TYPES (Authenticated)
// ============================================================

export interface KalshiOrderRequest {
  ticker: string;
  client_order_id: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  type: 'limit' | 'market';
  yes_price?: number; // Required for limit orders
  no_price?: number;
  expiration_ts?: number;
  sell_position_floor?: number;
  buy_max_cost?: number;
}

export interface KalshiOrder {
  order_id: string;
  client_order_id: string;
  user_id: string;
  ticker: string;
  status: 'pending' | 'open' | 'closed' | 'filled' | 'cancelled';
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  type: 'limit' | 'market';
  yes_price: number;
  no_price: number;
  created_time: string;
  expiration_time: string | null;
  order_count: number;
  place_count: number;
  decrease_count: number;
  remaining_count: number;
  filled_count: number;
  filled_price: number | null;
  time_in_force: string;
}

export interface KalshiOrderResponse {
  order: KalshiOrder;
}

export interface KalshiOrdersResponse {
  orders: KalshiOrder[];
  cursor: string | null;
}

// ============================================================
// POSITION TYPES (Authenticated)
// ============================================================

export interface KalshiPosition {
  ticker: string;
  event_ticker: string;
  market_title: string;
  yes_contracts: number;
  no_contracts: number;
  average_yes_entry_price: number;
  average_no_entry_price: number;
  total_traded: number;
  realized_pnl: number;
  unrealized_pnl: number;
  resting_orders_count: number;
}

export interface KalshiPositionsResponse {
  market_positions: KalshiPosition[];
  cursor: string | null;
}

export interface KalshiPortfolioBalance {
  balance: number;
  portfolio_value: number;
  total_deposited: number;
  total_withdrawn: number;
}

// ============================================================
// FILL TYPES
// ============================================================

export interface KalshiFill {
  trade_id: string;
  order_id: string;
  ticker: string;
  is_taker: boolean;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  yes_price: number;
  no_price: number;
  created_time: string;
}

export interface KalshiFillsResponse {
  fills: KalshiFill[];
  cursor: string | null;
}

// ============================================================
// NORMALIZED INTERNAL TYPES
// ============================================================

export interface NormalizedKalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  rulesText: string;

  // Status
  status: 'active' | 'closed' | 'settled';
  result?: 'YES' | 'NO';

  // Pricing (all in cents, 1-99)
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;

  // Derived pricing
  midPrice: number;
  spread: number;

  // Volume
  volume24h: number;
  dollarVolume24h: number;
  openInterest: number;

  // Timing
  closeTime: string;
  settlementTime: string;

  // Category
  category: string;
  seriesTicker: string;

  // Evidence
  evidenceHash?: string;
  fetchedAt: string;
}
