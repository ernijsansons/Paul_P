-- Paul P Closing Line & Price Semantics Schema
-- Migration: 0013_closing_line_price_semantics.sql
-- P-16: Price semantics normalization
-- P-17: Robust closing line estimation

-- ============================================================
-- PRICE OBSERVATIONS - Real-time price data for closing line
-- ============================================================
-- Separate from price_history (OHLCV candles) - this stores raw observations
CREATE TABLE IF NOT EXISTS price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  venue TEXT NOT NULL CHECK(venue IN ('polymarket', 'kalshi')),
  timestamp INTEGER NOT NULL, -- Unix timestamp ms

  -- Core price data
  mid_price REAL NOT NULL CHECK(mid_price >= 0 AND mid_price <= 1),

  -- Depth data for P-17 quality scoring
  depth_yes REAL NOT NULL DEFAULT 0, -- USD depth on YES side
  depth_no REAL NOT NULL DEFAULT 0,  -- USD depth on NO side
  spread REAL NOT NULL DEFAULT 0 CHECK(spread >= 0 AND spread <= 1),

  -- Optional volume
  volume REAL DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),

  UNIQUE(market_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_price_obs_market ON price_observations(market_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_price_obs_venue ON price_observations(venue, timestamp);

-- ============================================================
-- CLOSING LINE RESULTS - P-17 robust closing line estimates
-- ============================================================
CREATE TABLE IF NOT EXISTS closing_line_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,

  -- Closing line estimate
  closing_line_price REAL NOT NULL CHECK(closing_line_price >= 0 AND closing_line_price <= 1),

  -- Quality scoring (P-17)
  quality_score REAL NOT NULL CHECK(quality_score >= 0 AND quality_score <= 1),
  is_valid INTEGER NOT NULL DEFAULT 0, -- 1 if quality_score >= 0.5
  method TEXT NOT NULL, -- 'T-60min', 'T-5min', 'last-trade', etc.

  -- Component scores
  depth_score REAL NOT NULL DEFAULT 0,
  spread_score REAL NOT NULL DEFAULT 0,
  sample_score REAL NOT NULL DEFAULT 0,
  stability_score REAL NOT NULL DEFAULT 0,

  -- Statistics
  observation_count INTEGER NOT NULL DEFAULT 0,
  valid_observation_count INTEGER NOT NULL DEFAULT 0,
  avg_depth REAL DEFAULT 0,
  avg_spread REAL DEFAULT 0,
  price_std_dev REAL DEFAULT 0,

  computed_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_closing_line_market ON closing_line_results(market_id);
CREATE INDEX IF NOT EXISTS idx_closing_line_valid ON closing_line_results(is_valid, quality_score);

-- ============================================================
-- NORMALIZED PRICES - P-16 canonical price layer
-- ============================================================
CREATE TABLE IF NOT EXISTS normalized_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  venue TEXT NOT NULL CHECK(venue IN ('polymarket', 'kalshi')),

  -- Normalized probabilities
  p_yes REAL NOT NULL CHECK(p_yes >= 0 AND p_yes <= 1),
  p_no REAL NOT NULL CHECK(p_no >= 0 AND p_no <= 1),
  p_mid REAL NOT NULL CHECK(p_mid >= 0 AND p_mid <= 1),

  -- Market quality indicators
  spread REAL NOT NULL DEFAULT 0, -- Effective spread
  vig REAL NOT NULL DEFAULT 0, -- Overround/vigorish

  -- CLV computation hint
  clv_basis TEXT NOT NULL CHECK(clv_basis IN ('p_mid', 'p_yes', 'last_trade')),

  -- Validity
  is_valid INTEGER NOT NULL DEFAULT 0,

  -- Market mechanics type
  mechanics TEXT NOT NULL CHECK(mechanics IN (
    'binary_token',
    'orderbook_binary',
    'multi_outcome',
    'fee_adjusted',
    'void_risk'
  )),

  -- Warnings/anomalies
  warnings TEXT, -- JSON array

  computed_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_normalized_market ON normalized_prices(market_id, venue);
CREATE INDEX IF NOT EXISTS idx_normalized_valid ON normalized_prices(is_valid, computed_at);

-- ============================================================
-- MARKET CLASS ASSIGNMENTS - Links markets to CLV window types
-- ============================================================
CREATE TABLE IF NOT EXISTS market_class_assignments (
  market_id TEXT PRIMARY KEY,
  market_class TEXT NOT NULL CHECK(market_class IN (
    'political',  -- T-60 minutes
    'sports',     -- Last trade
    'weather',    -- T-5 minutes
    'mentions',   -- T-30 seconds
    'crypto'      -- T-60 seconds
  )),
  assigned_by TEXT NOT NULL CHECK(assigned_by IN ('auto', 'manual', 'llm')),
  confidence REAL DEFAULT 1.0,
  assigned_at TEXT DEFAULT (datetime('now'))
);
