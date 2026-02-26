-- Paul P Execution Policy Schema (P-05)
-- Migration: 0006_execution_policy.sql
-- Tables: execution_policies

-- ============================================================
-- EXECUTION POLICIES - Per-strategy execution rules
-- ============================================================
CREATE TABLE execution_policies (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  venue TEXT NOT NULL CHECK(venue IN ('kalshi', 'ibkr')),
  version INTEGER NOT NULL DEFAULT 1,

  -- Order type rules
  default_order_type TEXT NOT NULL CHECK(default_order_type IN ('limit', 'market')),
  allow_market_orders INTEGER NOT NULL DEFAULT 0, -- 0 = limit only

  -- Limit price rules
  limit_price_method TEXT NOT NULL CHECK(limit_price_method IN (
    'mid_minus_edge',       -- place at mid - (edge_threshold / 2)
    'best_bid_improve',     -- improve best bid by 1 tick
    'model_fair_value',     -- place at model-implied fair value
    'aggressive_cross'      -- cross spread when urgency is high
  )),

  -- Pre-trade microstructure checks
  max_spread_to_trade REAL NOT NULL, -- do not trade if spread > this (e.g., 0.08 = 8 cents)
  min_depth_to_trade REAL NOT NULL, -- do not trade if depth < this USD amount
  max_vpin_to_trade REAL NOT NULL DEFAULT 0.6, -- pause if VPIN > this (flow toxicity)
  max_slippage_budget REAL NOT NULL, -- max acceptable slippage per order in cents

  -- Cancel/replace rules
  stale_order_timeout_sec INTEGER NOT NULL DEFAULT 300, -- cancel unfilled orders after N seconds
  cancel_on_price_move REAL NOT NULL DEFAULT 0.03, -- cancel if market moves > N cents since signal

  -- Partial fill handling
  min_fill_pct REAL NOT NULL DEFAULT 0.5, -- cancel remainder if fill < 50% after timeout
  allow_resubmit INTEGER NOT NULL DEFAULT 1,
  max_resubmits INTEGER NOT NULL DEFAULT 2,

  -- Rate limit respect
  max_orders_per_minute INTEGER NOT NULL DEFAULT 10,
  max_cancels_per_minute INTEGER NOT NULL DEFAULT 20,

  -- VPIN adjustments (P-25)
  vpin_normal_threshold REAL DEFAULT 0.3, -- VPIN < this = normal
  vpin_elevated_edge_multiplier REAL DEFAULT 1.5, -- widen edge requirement by 50% when elevated

  -- Active
  is_active INTEGER NOT NULL DEFAULT 1,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_execution_policies_strategy ON execution_policies(strategy_id);
CREATE INDEX idx_execution_policies_venue ON execution_policies(venue);
CREATE INDEX idx_execution_policies_active ON execution_policies(is_active) WHERE is_active = 1;

-- ============================================================
-- EXECUTION REPORTS - Realized vs expected execution quality
-- ============================================================
CREATE TABLE execution_reports (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  venue TEXT NOT NULL,

  -- Execution quality metrics
  signal_price REAL NOT NULL,
  expected_fill_price REAL NOT NULL, -- based on limit_price_method
  actual_fill_price REAL NOT NULL,

  -- Slippage analysis
  expected_slippage REAL NOT NULL,
  realized_slippage REAL NOT NULL,
  slippage_vs_budget REAL, -- realized / budget (>1.0 = exceeded)

  -- Timing
  signal_to_submit_ms INTEGER,
  submit_to_ack_ms INTEGER,
  ack_to_fill_ms INTEGER,
  total_latency_ms INTEGER,

  -- Market impact
  price_impact_bps REAL, -- basis points movement caused
  queue_priority_estimate REAL, -- 0-1, where in queue

  -- Fill quality
  fill_rate REAL NOT NULL, -- filled_qty / requested_qty
  partial_fills_count INTEGER DEFAULT 0,

  -- Pre-trade check state
  spread_at_check REAL,
  depth_at_check REAL,
  vpin_at_check REAL,

  -- Verdict
  execution_grade TEXT CHECK(execution_grade IN (
    'EXCELLENT',   -- better than expected
    'GOOD',        -- within slippage budget
    'ACCEPTABLE',  -- slightly exceeded budget
    'POOR',        -- significantly exceeded budget
    'FAILED'       -- did not fill or major issues
  )),

  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_execution_reports_order ON execution_reports(order_id);
CREATE INDEX idx_execution_reports_strategy ON execution_reports(strategy_id);
CREATE INDEX idx_execution_reports_grade ON execution_reports(execution_grade);
