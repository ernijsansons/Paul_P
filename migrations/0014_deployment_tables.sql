-- Paul P Deployment Tables Schema
-- Migration: 0014_deployment_tables.sql
-- Tables: paper_positions, invariant_test_results, capital_allocation, deployment_events
-- Also adds mode column to execution_policies

-- ============================================================
-- PAPER POSITIONS - Paper trading position tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL CHECK(strategy IN ('bonding', 'weather', 'xv_signal', 'smart_money', 'resolution')),
  market_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('YES', 'NO')),

  -- Entry metrics
  entry_price REAL NOT NULL,
  size REAL NOT NULL,
  entry_at TEXT NOT NULL,

  -- Current state
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'resolved')),
  current_price REAL,

  -- Exit/resolution
  exit_price REAL,
  exit_at TEXT,
  resolved_outcome TEXT CHECK(resolved_outcome IN ('YES', 'NO', 'VOID')),

  -- PnL tracking
  realized_pnl REAL DEFAULT 0,
  unrealized_pnl REAL DEFAULT 0,

  -- CLV metrics
  closing_line_price REAL,
  clv REAL, -- closing_line_price - entry_price

  -- Drawdown tracking
  peak_value REAL,
  drawdown REAL DEFAULT 0,

  -- Evidence
  signal_id TEXT,
  order_id TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_strategy ON paper_positions(strategy);
CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions(status);
CREATE INDEX IF NOT EXISTS idx_paper_positions_market ON paper_positions(market_id);

-- ============================================================
-- INVARIANT TEST RESULTS - Track invariant validation tests
-- ============================================================
CREATE TABLE IF NOT EXISTS invariant_test_results (
  id TEXT PRIMARY KEY,
  invariant_id TEXT NOT NULL,
  invariant_name TEXT NOT NULL,

  -- Test execution
  test_type TEXT NOT NULL CHECK(test_type IN ('unit', 'integration', 'regression', 'stress')),
  passed INTEGER NOT NULL DEFAULT 0,

  -- Test details
  input_json TEXT,
  expected_result TEXT,
  actual_result TEXT,
  error_message TEXT,

  -- Timing
  execution_time_ms INTEGER,
  tested_at TEXT NOT NULL,

  -- Context
  test_suite TEXT,
  test_name TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invariant_tests_invariant ON invariant_test_results(invariant_id);
CREATE INDEX IF NOT EXISTS idx_invariant_tests_passed ON invariant_test_results(passed);
CREATE INDEX IF NOT EXISTS idx_invariant_tests_tested ON invariant_test_results(tested_at);

-- ============================================================
-- CAPITAL ALLOCATION - Live capital allocation per strategy
-- ============================================================
CREATE TABLE IF NOT EXISTS capital_allocation (
  strategy TEXT PRIMARY KEY CHECK(strategy IN ('bonding', 'weather', 'xv_signal', 'smart_money', 'resolution')),
  capital REAL NOT NULL DEFAULT 0,
  max_position_pct REAL NOT NULL DEFAULT 5,
  current_deployed REAL DEFAULT 0,
  available REAL DEFAULT 0,

  -- Allocation status
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT,
  disabled_at TEXT,
  disable_reason TEXT,

  -- Approval
  approved_by TEXT,
  approved_at TEXT,

  allocated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- DEPLOYMENT EVENTS - Track deployment lifecycle events
-- ============================================================
CREATE TABLE IF NOT EXISTS deployment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'VALIDATION_STARTED',
    'VALIDATION_PASSED',
    'VALIDATION_FAILED',
    'HUMAN_APPROVAL_REQUESTED',
    'HUMAN_APPROVAL_GRANTED',
    'HUMAN_APPROVAL_REJECTED',
    'DEPLOYMENT_STARTED',
    'STRATEGY_DEPLOYED',
    'DEPLOYMENT_COMPLETED',
    'DEPLOYMENT_FAILED',
    'DEPLOYMENT_REJECTED',
    'STRATEGY_DISABLED',
    'CAPITAL_ALLOCATED',
    'MODE_CHANGED'
  )),
  payload TEXT NOT NULL DEFAULT '{}', -- JSON

  -- Actor
  actor TEXT, -- user/system that triggered event

  -- Related entities
  strategy TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deployment_events_type ON deployment_events(event_type);
CREATE INDEX IF NOT EXISTS idx_deployment_events_strategy ON deployment_events(strategy);
CREATE INDEX IF NOT EXISTS idx_deployment_events_created ON deployment_events(created_at);

-- ============================================================
-- HISTORICAL METRICS - Strategy historical performance
-- ============================================================
CREATE TABLE IF NOT EXISTS historical_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,

  -- Performance metrics
  total_positions INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,
  avg_clv REAL,
  sharpe_ratio REAL,
  max_drawdown REAL,
  profit_factor REAL,
  total_pnl REAL,

  -- Computed at
  computed_at TEXT NOT NULL,

  UNIQUE(strategy, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_historical_strategy ON historical_metrics(strategy);
CREATE INDEX IF NOT EXISTS idx_historical_period ON historical_metrics(period_start, period_end);

-- ============================================================
-- ADD MODE TO EXECUTION_POLICIES (if not exists)
-- Using a separate table for mode since SQLite doesn't support IF NOT EXISTS for columns
-- ============================================================
CREATE TABLE IF NOT EXISTS strategy_execution_mode (
  strategy TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'PAPER' CHECK(mode IN ('PAPER', 'LIVE', 'DISABLED')),
  changed_at TEXT DEFAULT (datetime('now')),
  changed_by TEXT,
  reason TEXT
);

-- Initialize modes for all strategies
INSERT OR IGNORE INTO strategy_execution_mode (strategy, mode) VALUES ('bonding', 'PAPER');
INSERT OR IGNORE INTO strategy_execution_mode (strategy, mode) VALUES ('weather', 'PAPER');
INSERT OR IGNORE INTO strategy_execution_mode (strategy, mode) VALUES ('xv_signal', 'DISABLED');
INSERT OR IGNORE INTO strategy_execution_mode (strategy, mode) VALUES ('smart_money', 'DISABLED');
INSERT OR IGNORE INTO strategy_execution_mode (strategy, mode) VALUES ('resolution', 'DISABLED');
