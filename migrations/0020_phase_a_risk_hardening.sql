-- Phase A Risk Hardening - Stop-Loss, Take-Profit, Time-Based Exit
-- Migration: 0020_phase_a_risk_hardening.sql
-- Purpose: Add per-position guardrails and circuit breaker enhancements

-- ============================================================
-- POSITIONS TABLE ENHANCEMENTS - Stop-Loss, Take-Profit, Exits
-- ============================================================

-- Add stop-loss and take-profit tracking columns
ALTER TABLE positions ADD COLUMN stop_loss_price REAL;  -- Hard -3% stop at entry_price * 0.97
ALTER TABLE positions ADD COLUMN take_profit_price REAL;  -- +50% profit target at entry_price * 1.50
ALTER TABLE positions ADD COLUMN max_holding_hours INTEGER DEFAULT 168;  -- 7 days = 168 hours
ALTER TABLE positions ADD COLUMN was_stopped_out INTEGER DEFAULT 0;  -- 1 if exited on stop-loss
ALTER TABLE positions ADD COLUMN was_take_profit INTEGER DEFAULT 0;  -- 1 if exited on take-profit
ALTER TABLE positions ADD COLUMN was_time_exit INTEGER DEFAULT 0;  -- 1 if exited due to time
ALTER TABLE positions ADD COLUMN stop_loss_triggered_at TEXT;  -- Timestamp when stop was hit
ALTER TABLE positions ADD COLUMN take_profit_triggered_at TEXT;
ALTER TABLE positions ADD COLUMN time_exit_triggered_at TEXT;
ALTER TABLE positions ADD COLUMN current_price REAL;  -- Last market price (updated real-time)
ALTER TABLE positions ADD COLUMN current_price_at TEXT;  -- Timestamp of price update
ALTER TABLE positions ADD COLUMN unrealized_pnl REAL DEFAULT 0;  -- Current P&L if closed at current_price

-- ============================================================
-- CIRCUIT BREAKER ENHANCEMENTS
-- ============================================================

-- NOTE: circuit_breaker_history is managed by RiskGovernorAgent's Durable Object SQLite,
-- not D1. The halt_duration_minutes and auto_recovery_at columns are defined there.
-- See src/agents/RiskGovernorAgent.ts initLocalTables()

-- ============================================================
-- POSITION MONITORING TABLE
-- ============================================================
-- Tracks per-position stop-loss, take-profit, and time-based exit checks

CREATE TABLE IF NOT EXISTS position_monitor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT NOT NULL REFERENCES positions(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('STOP_CHECK', 'TP_CHECK', 'TIME_CHECK', 'PRICE_UPDATE', 'POSITION_EXIT')),

  -- Context at check time
  market_price REAL NOT NULL,
  stop_loss_price REAL,
  take_profit_price REAL,
  holding_hours REAL NOT NULL,
  max_holding_hours INTEGER NOT NULL,

  -- Result
  triggered INTEGER NOT NULL DEFAULT 0,  -- 1 if condition met, 0 otherwise
  trigger_reason TEXT,  -- 'stop_hit', 'tp_hit', 'time_exceeded', etc.

  -- Action
  action_taken TEXT,  -- 'exit_submitted', 'exit_executed', 'awaiting_execution'

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_position_monitor_position ON position_monitor_events(position_id);
CREATE INDEX idx_position_monitor_type ON position_monitor_events(event_type);
CREATE INDEX idx_position_monitor_triggered ON position_monitor_events(triggered);

-- ============================================================
-- TAIL CONCENTRATION TRACKING
-- ============================================================
-- Monitor barbell tail leg concentration (Herfindahl < 0.3 enforcement)

CREATE TABLE IF NOT EXISTS tail_concentration_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_at TEXT NOT NULL,

  -- Tail portfolio metrics
  tail_portfolio_size REAL NOT NULL,
  tail_position_count INTEGER NOT NULL,
  tail_market_ids TEXT,  -- JSON array of market IDs in tail
  tail_herfindahl REAL NOT NULL,  -- concentration measure 0-1
  tail_max_position_pct REAL NOT NULL,  -- largest tail position % of total

  -- Enforcement results
  is_compliant INTEGER NOT NULL,  -- 1 if Herfindahl < 0.3
  violations TEXT,  -- JSON array of violated constraints
  rebalance_recommended INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_tail_concentration_compliant ON tail_concentration_snapshots(is_compliant);
CREATE INDEX idx_tail_concentration_snapshot_at ON tail_concentration_snapshots(snapshot_at);

-- ============================================================
-- SLIPPAGE TRACKING FOR KILL SWITCH
-- ============================================================
-- Track realized vs expected slippage to trigger market halt

CREATE TABLE IF NOT EXISTS slippage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  market_id TEXT NOT NULL,

  -- Slippage metrics
  expected_slippage REAL NOT NULL,  -- Predicted at order submission
  realized_slippage REAL NOT NULL,  -- Actual at fill
  slippage_ratio REAL NOT NULL,  -- realized / expected

  -- Market context
  market_depth_at_submission REAL,
  market_spread_at_submission REAL,
  order_size REAL NOT NULL,

  -- Kill switch evaluation
  exceeds_kill_threshold INTEGER DEFAULT 0,  -- 1 if ratio > 0.5 (50% of edge)
  kill_threshold_pct REAL DEFAULT 50.0,  -- 50% of edge

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_slippage_market ON slippage_history(market_id);
CREATE INDEX idx_slippage_exceeds_threshold ON slippage_history(exceeds_kill_threshold);

-- ============================================================
-- TIGHTENED RISK LIMITS TABLE (replaces hardcoded defaults)
-- ============================================================

CREATE TABLE IF NOT EXISTS phase_a_risk_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton table

  -- Position Limits
  max_position_pct REAL DEFAULT 5.0,
  max_concentration_pct REAL DEFAULT 10.0,
  max_market_exposure_pct REAL DEFAULT 15.0,
  max_category_exposure_pct REAL DEFAULT 30.0,

  -- Loss Limits
  max_daily_loss_pct REAL DEFAULT 3.0,
  max_drawdown_pct REAL DEFAULT 10.0,
  max_weekly_loss_pct REAL DEFAULT 7.0,

  -- Market Quality (TIGHTENED)
  min_liquidity REAL DEFAULT 500.0,  -- was 5000, now 500 for $250 account
  max_vpin REAL DEFAULT 0.5,  -- was 0.6, tightened to 0.5
  max_spread REAL DEFAULT 0.005,  -- was 0.10 (10%), now 0.005 (0.5%)
  min_time_to_settlement_hours INTEGER DEFAULT 24,

  -- Execution Safety
  max_ambiguity_score REAL DEFAULT 0.4,
  max_price_staleness_seconds INTEGER DEFAULT 60,
  max_order_size REAL DEFAULT 10000.0,
  min_order_size REAL DEFAULT 10.0,

  -- Per-Position Guardrails
  stop_loss_pct REAL DEFAULT -3.0,  -- -3% from entry
  take_profit_pct REAL DEFAULT 50.0,  -- +50% from entry
  max_holding_hours INTEGER DEFAULT 168,  -- 7 days

  -- Circuit Breaker
  halt_timeout_minutes INTEGER DEFAULT 60,  -- Auto-exit HALT after 60 min
  caution_position_scaling REAL DEFAULT 0.5,  -- Halve positions in CAUTION

  -- Tail Concentration
  max_tail_herfindahl REAL DEFAULT 0.3,  -- Herfindahl < 0.3
  max_tail_position_pct REAL DEFAULT 10.0,  -- Max 10% per tail position

  -- Slippage Kill Switch
  slippage_kill_threshold_pct REAL DEFAULT 50.0,  -- 50% of edge

  updated_at TEXT DEFAULT (datetime('now'))
);

-- Insert default values
INSERT OR IGNORE INTO phase_a_risk_limits (id) VALUES (1);

-- ============================================================
-- VERSION TRACKING
-- ============================================================

INSERT INTO audit_log (id, event_type, entity_type, payload, timestamp)
VALUES (
  'migration_0020_' || datetime('now', 'localtime'),
  'schema_migration',
  'system',
  '{"migration": "0020_phase_a_risk_hardening", "changes": ["positions stop/tp columns", "position_monitor_events table", "tail_concentration_snapshots", "slippage_history", "phase_a_risk_limits singleton"]}',
  datetime('now')
);
