-- Paul P Strategy State Schema
-- Migration: 0003_strategy_state.sql
-- Tables: strategies, orders, portfolio_snapshots, invariant_violations

-- ============================================================
-- STRATEGIES TABLE
-- ============================================================
CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy_type TEXT NOT NULL CHECK(strategy_type IN (
    'bonding_barbell',
    'weather_series',
    'cross_venue_signal',
    'smart_money_convergence',
    'resolution_mispricing'
  )),

  -- Configuration
  spec_version TEXT NOT NULL, -- semver: '1.0.0'
  spec_hash TEXT NOT NULL, -- SHA-256 of strategy spec JSON
  config_json TEXT NOT NULL, -- strategy-specific parameters

  -- Allocation
  max_capital_allocation_usd REAL NOT NULL,
  current_allocation_usd REAL DEFAULT 0,
  max_position_pct REAL NOT NULL DEFAULT 0.03, -- 3% max per position

  -- Status
  status TEXT NOT NULL DEFAULT 'paper' CHECK(status IN (
    'disabled',    -- Not running
    'paper',       -- Paper trading mode
    'live',        -- Live trading
    'halted'       -- Halted by Risk Governor
  )),

  -- Performance tracking
  total_pnl_usd REAL DEFAULT 0,
  total_positions INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  sharpe_ratio REAL,
  max_drawdown_pct REAL,

  -- Model validity (P-09)
  model_last_validated_at TEXT,
  model_validation_score REAL, -- OOS performance metric
  model_valid INTEGER DEFAULT 1, -- 0 = degraded, disable signals

  -- Human approval
  approved_by TEXT,
  approved_at TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_strategies_status ON strategies(status);
CREATE INDEX idx_strategies_type ON strategies(strategy_type);

-- ============================================================
-- ORDERS TABLE - Full order lifecycle tracking
-- ============================================================
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),

  -- Signal origin
  signal_id TEXT NOT NULL, -- unique signal identifier
  signal_generated_at TEXT NOT NULL,
  signal_price REAL NOT NULL, -- market price when signal generated

  -- Order details
  venue TEXT NOT NULL CHECK(venue IN ('kalshi', 'ibkr')),
  venue_market_id TEXT NOT NULL, -- ticker for Kalshi, symbol for IBKR
  side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
  outcome_side TEXT CHECK(outcome_side IN ('YES', 'NO')), -- for prediction markets

  -- Sizing
  quantity INTEGER NOT NULL, -- contracts
  limit_price REAL, -- NULL for market orders
  order_type TEXT NOT NULL CHECK(order_type IN ('limit', 'market')),

  -- State machine (from blueprint Section E3)
  state TEXT NOT NULL DEFAULT 'SIGNAL_GENERATED' CHECK(state IN (
    'SIGNAL_GENERATED',      -- Strategy emitted signal
    'PRE_TRADE_CHECK',       -- Checking spread, depth, VPIN
    'PRE_TRADE_BLOCKED',     -- Failed pre-trade checks
    'RISK_CHECK_PENDING',    -- Awaiting Risk Governor
    'RISK_VETOED',           -- Risk Governor rejected
    'RISK_APPROVED',         -- Risk Governor approved
    'ORDER_SUBMITTED',       -- Sent to venue API
    'ORDER_REJECTED',        -- Venue rejected
    'ORDER_ACKNOWLEDGED',    -- Venue accepted, in book
    'PARTIALLY_FILLED',      -- Some fills received
    'FULLY_FILLED',          -- Complete fill
    'CANCELLED',             -- Cancelled (user or system)
    'PRICE_MOVE_CANCEL',     -- Cancelled due to price movement
    'EXPIRED',               -- Time-in-force expired
    'RECONCILED',            -- Position verified
    'ARCHIVED'               -- Final state
  )),
  state_history TEXT, -- JSON array of {state, timestamp, reason}

  -- Execution
  venue_order_id TEXT, -- ID from venue
  submitted_at TEXT,
  acknowledged_at TEXT,

  -- Fills
  filled_quantity INTEGER DEFAULT 0,
  avg_fill_price REAL,
  fill_history TEXT, -- JSON array of fills

  -- Slippage tracking
  expected_slippage REAL,
  realized_slippage REAL,

  -- Timing
  completed_at TEXT,

  -- Pre-trade check results
  pre_trade_spread REAL,
  pre_trade_depth REAL,
  pre_trade_vpin REAL,
  pre_trade_passed INTEGER,

  -- Risk check results
  risk_check_result TEXT, -- JSON with invariant checks
  risk_vetoed_reason TEXT,

  -- Evidence
  evidence_hash TEXT,

  -- Idempotency
  idempotency_key TEXT UNIQUE,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_orders_strategy ON orders(strategy_id);
CREATE INDEX idx_orders_state ON orders(state);
CREATE INDEX idx_orders_venue ON orders(venue, venue_market_id);
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key);

-- ============================================================
-- PORTFOLIO SNAPSHOTS - Point-in-time portfolio state
-- ============================================================
CREATE TABLE portfolio_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_at TEXT NOT NULL,

  -- Aggregate metrics
  total_equity_usd REAL NOT NULL,
  total_cash_usd REAL NOT NULL,
  total_position_value_usd REAL NOT NULL,
  unrealized_pnl_usd REAL NOT NULL,
  realized_pnl_day_usd REAL NOT NULL,

  -- Per-strategy breakdown
  strategy_allocations TEXT NOT NULL, -- JSON: {strategy_id: {equity, pnl, positions}}

  -- Risk metrics
  gross_exposure_usd REAL NOT NULL,
  net_exposure_usd REAL NOT NULL,
  max_single_position_pct REAL NOT NULL,
  herfindahl_concentration REAL, -- position concentration

  -- Per-venue breakdown
  kalshi_equity_usd REAL,
  ibkr_equity_usd REAL,

  -- Correlation exposure
  event_cluster_exposures TEXT, -- JSON: {cluster_id: exposure_usd}

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_portfolio_snapshots_time ON portfolio_snapshots(snapshot_at);

-- ============================================================
-- INVARIANT VIOLATIONS - Risk Governor tracking
-- ============================================================
CREATE TABLE invariant_violations (
  id TEXT PRIMARY KEY,

  -- Invariant details
  invariant_id TEXT NOT NULL, -- e.g., 'INV-01' through 'INV-17'
  invariant_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('WARNING', 'BLOCK', 'HALT')),

  -- Context
  triggered_by TEXT NOT NULL, -- order_id, strategy_id, or 'system'
  triggered_at TEXT NOT NULL,

  -- Violation details
  threshold_value REAL,
  actual_value REAL,
  description TEXT NOT NULL,
  context_json TEXT, -- additional context

  -- Resolution
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_notes TEXT,

  -- Action taken
  action_taken TEXT CHECK(action_taken IN (
    'ORDER_BLOCKED',
    'ORDER_CANCELLED',
    'STRATEGY_PAUSED',
    'SYSTEM_HALTED',
    'ALERT_ONLY'
  )),

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_violations_invariant ON invariant_violations(invariant_id);
CREATE INDEX idx_violations_severity ON invariant_violations(severity);
CREATE INDEX idx_violations_unresolved ON invariant_violations(resolved) WHERE resolved = 0;
