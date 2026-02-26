-- Paul P Market Enrichment Schema
-- Migration: 0002_market_enrichment.sql
-- Additional market data structures for enhanced analysis

-- ============================================================
-- MARKET SNAPSHOTS - Point-in-time orderbook state
-- ============================================================
CREATE TABLE market_snapshots (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL REFERENCES markets(condition_id),
  snapshot_at TEXT NOT NULL, -- ISO 8601

  -- Best prices
  best_bid_yes REAL,
  best_ask_yes REAL,
  best_bid_no REAL,
  best_ask_no REAL,

  -- Midpoint
  mid_price REAL NOT NULL,
  spread REAL NOT NULL,

  -- Depth at various levels
  depth_1pct_usd REAL, -- total depth within 1% of mid
  depth_2pct_usd REAL,
  depth_5pct_usd REAL,

  -- Volume metrics
  volume_24h REAL,
  trade_count_24h INTEGER,

  -- VPIN computation (P-25)
  vpin_bucket_value REAL, -- |V_buy - V_sell| / (V_buy + V_sell) for this bucket
  vpin_rolling_50 REAL, -- rolling average over 50 buckets

  -- Source
  source TEXT NOT NULL CHECK(source IN ('polymarket_clob', 'kalshi_orderbook')),
  evidence_hash TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_snapshots_condition ON market_snapshots(condition_id, snapshot_at);
CREATE INDEX idx_snapshots_vpin ON market_snapshots(vpin_rolling_50);

-- ============================================================
-- PRICE HISTORY - Aggregated candlestick data
-- ============================================================
CREATE TABLE price_history (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL REFERENCES markets(condition_id),
  interval TEXT NOT NULL CHECK(interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  period_start TEXT NOT NULL, -- ISO 8601
  period_end TEXT NOT NULL,

  -- OHLCV
  open_price REAL NOT NULL,
  high_price REAL NOT NULL,
  low_price REAL NOT NULL,
  close_price REAL NOT NULL,
  volume_usd REAL NOT NULL,
  trade_count INTEGER,

  -- Derived
  vwap REAL, -- Volume-weighted average price

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_price_history_lookup ON price_history(condition_id, interval, period_start);

-- ============================================================
-- MARKET EVENTS - News shocks, resolution events, etc.
-- ============================================================
CREATE TABLE market_events (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL REFERENCES markets(condition_id),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'news_shock',        -- Major news impacting market
    'resolution_hint',   -- Early resolution signal
    'volume_spike',      -- Unusual volume
    'spread_blowout',    -- Liquidity crisis
    'price_gap',         -- >5% price jump
    'halt',              -- Trading halt
    'resolution'         -- Final resolution
  )),
  event_at TEXT NOT NULL,

  -- Context
  price_before REAL,
  price_after REAL,
  volume_in_window REAL,

  -- Description
  description TEXT,
  source TEXT,
  evidence_hash TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_market_events_condition ON market_events(condition_id, event_at);
CREATE INDEX idx_market_events_type ON market_events(event_type);
