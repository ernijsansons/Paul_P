-- Paul P Initial Schema
-- Migration: 0001_initial_schema.sql
-- Tables: accounts, positions, markets, trades, audit_log

-- ============================================================
-- ACCOUNTS TABLE
-- ============================================================
CREATE TABLE accounts (
  proxy_wallet TEXT PRIMARY KEY,
  username TEXT,
  x_username TEXT,
  profile_image_url TEXT,
  first_seen_at TEXT NOT NULL, -- ISO 8601
  total_pnl_usd REAL DEFAULT 0,
  total_volume_usd REAL DEFAULT 0,
  total_positions INTEGER DEFAULT 0,
  active_positions INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  skill_score REAL, -- 0-100, computed
  strategy_classification TEXT, -- JSON array of labels
  wallet_cluster_id TEXT, -- links multi-wallet entities
  last_synced_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_accounts_skill ON accounts(skill_score);
CREATE INDEX idx_accounts_cluster ON accounts(wallet_cluster_id);

-- ============================================================
-- POSITIONS TABLE
-- CLV Convention: CLV = closing_line_price - entry_price
-- POSITIVE CLV = edge (entered at better price than closing consensus)
-- ============================================================
CREATE TABLE positions (
  id TEXT PRIMARY KEY, -- deterministic: hash(proxy_wallet + condition_id + side)
  proxy_wallet TEXT NOT NULL REFERENCES accounts(proxy_wallet),
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  market_slug TEXT,
  market_question TEXT,
  side TEXT NOT NULL CHECK(side IN ('YES', 'NO')),
  status TEXT NOT NULL CHECK(status IN ('open', 'closed', 'resolved')),

  -- Entry metrics
  first_trade_at TEXT,
  last_trade_at TEXT,
  avg_entry_price REAL NOT NULL,
  total_size REAL NOT NULL, -- in shares
  total_cost_usd REAL NOT NULL,

  -- Market context at entry
  market_volume_at_entry REAL,
  market_spread_at_entry REAL,
  market_depth_at_entry REAL, -- depth proxy at 2% from mid
  entry_timing_pct REAL, -- 0.0 (market open) to 1.0 (near close)

  -- Resolution metrics (for closed/resolved)
  resolution_price REAL, -- 0.0 or 1.0 for resolved
  exit_price REAL, -- for positions sold before resolution
  realized_pnl REAL,

  -- CLV metrics (P-01: unified sign convention - POSITIVE = edge)
  closing_line_price REAL, -- last mid before resolution halt (per market-class CL definition)
  closing_line_method TEXT, -- which CL definition: 'T-60min', 'last-trade', 'T-5min', etc.
  closing_line_quality_score REAL, -- (P-17) 0.0 to 1.0
  clv REAL, -- closing_line_price - avg_entry_price. POSITIVE = edge
  clv_cents REAL, -- clv * 100 for display
  clv_valid INTEGER DEFAULT 1, -- (P-17) 0 if closing_line_quality_score < 0.5

  -- Holding period
  holding_period_hours REAL,

  -- Fees
  estimated_fees_usd REAL DEFAULT 0,

  -- Evidence linkage (P-12)
  evidence_hash TEXT, -- SHA-256 of raw API response

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_positions_wallet ON positions(proxy_wallet);
CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_positions_condition ON positions(condition_id);
CREATE INDEX idx_positions_clv ON positions(clv_cents);

-- ============================================================
-- MARKETS TABLE
-- ============================================================
CREATE TABLE markets (
  condition_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  description TEXT,
  resolution_source TEXT,
  resolution_criteria TEXT, -- RAW text critical for ambiguity scoring
  end_date TEXT,
  resolved_at TEXT,
  resolution_outcome TEXT, -- 'YES', 'NO', 'VOID', 'AMBIGUOUS'

  -- Price tracking (required by ingestion clients)
  last_yes_price REAL, -- current YES token price
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'halted', 'resolved', 'voided')),

  -- Liquidity features
  total_volume_usd REAL,
  peak_volume_24h REAL,
  avg_spread REAL,
  depth_proxy_usd REAL, -- estimated depth at 2% from mid

  -- Classification
  category TEXT, -- politics, sports, crypto, weather, mentions
  market_class TEXT, -- for CL definition: 'political', 'sports', 'weather', 'mentions', 'crypto'
  ambiguity_score REAL, -- 0 (clear) to 1.0 (high dispute risk)
  ambiguity_scoring_run_id TEXT, -- FK to llm_scoring_runs
  has_dispute_history INTEGER DEFAULT 0,

  -- Timing features
  duration_hours REAL,
  news_shock_flag INTEGER DEFAULT 0,

  tags TEXT, -- JSON array
  series TEXT,

  -- Venue tracking
  venue TEXT, -- 'polymarket', 'kalshi', etc.

  -- Evidence linkage (P-12)
  evidence_hash TEXT, -- SHA-256 of raw Gamma API response

  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_markets_category ON markets(category);
CREATE INDEX idx_markets_ambiguity ON markets(ambiguity_score);
CREATE INDEX idx_markets_status ON markets(status);
CREATE INDEX idx_markets_venue ON markets(venue);

-- ============================================================
-- TRADES TABLE
-- ============================================================
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  proxy_wallet TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL, -- BUY or SELL
  outcome_side TEXT NOT NULL, -- YES or NO
  price REAL NOT NULL,
  size REAL NOT NULL,
  timestamp TEXT NOT NULL, -- ISO 8601

  -- Venue tracking (required by ingestion)
  venue TEXT, -- 'polymarket', 'kalshi', etc.
  market_id TEXT, -- venue-specific market identifier

  -- Market context at trade time
  mid_price_at_trade REAL,
  spread_at_trade REAL,
  volume_24h_at_trade REAL,

  -- Evidence linkage (P-12)
  evidence_hash TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_trades_wallet ON trades(proxy_wallet);
CREATE INDEX idx_trades_timestamp ON trades(timestamp);
CREATE INDEX idx_trades_condition ON trades(condition_id);
CREATE INDEX idx_trades_venue ON trades(venue);
CREATE INDEX idx_trades_market_id ON trades(market_id);

-- ============================================================
-- AUDIT LOG TABLE
-- ============================================================
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL, -- 'data_sync', 'score_computed', 'strategy_classified', etc.
  entity_type TEXT, -- 'account', 'position', 'market'
  entity_id TEXT,
  payload TEXT, -- JSON
  evidence_hash TEXT, -- SHA-256 of raw source data
  r2_evidence_key TEXT, -- (P-12) key to raw response blob in R2
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_log_type ON audit_log(event_type);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
