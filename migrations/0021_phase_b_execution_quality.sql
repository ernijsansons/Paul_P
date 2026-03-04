-- Phase B Execution Quality Tracking - Slippage & Execution Grades
-- Migration: 0021_phase_b_execution_quality.sql
-- Purpose: Add execution quality tracking for expected vs realized slippage

-- ============================================================
-- EXECUTION REPORTS TABLE ENHANCEMENT
-- ============================================================
-- NOTE: execution_reports table already exists from migration 0014 with different schema.
-- We add missing columns needed for Phase B execution quality tracking.

-- Add ticker column if it doesn't exist (required for Phase B)
ALTER TABLE execution_reports ADD COLUMN ticker TEXT;

-- Add side column (yes/no)
ALTER TABLE execution_reports ADD COLUMN side TEXT CHECK(side IN ('yes', 'no'));

-- Add limit_price and fill_price columns
ALTER TABLE execution_reports ADD COLUMN limit_price REAL;
ALTER TABLE execution_reports ADD COLUMN fill_price REAL;

-- Add slippage ratio column
ALTER TABLE execution_reports ADD COLUMN slippage_ratio REAL;

-- Add edge analysis columns
ALTER TABLE execution_reports ADD COLUMN edge_percent REAL;
ALTER TABLE execution_reports ADD COLUMN slippage_vs_edge_ratio REAL;

-- Add order context columns
ALTER TABLE execution_reports ADD COLUMN order_size INTEGER;
ALTER TABLE execution_reports ADD COLUMN order_notional REAL;

-- Add market conditions columns
ALTER TABLE execution_reports ADD COLUMN market_depth REAL;
ALTER TABLE execution_reports ADD COLUMN market_spread REAL;
ALTER TABLE execution_reports ADD COLUMN vpin REAL;

-- Add time context columns
ALTER TABLE execution_reports ADD COLUMN time_of_day TEXT;
ALTER TABLE execution_reports ADD COLUMN executed_at TEXT;

-- Create indexes on newly added columns (only if they don't exist)
CREATE INDEX IF NOT EXISTS idx_execution_reports_ticker ON execution_reports(ticker);
CREATE INDEX IF NOT EXISTS idx_execution_reports_kill_switch ON execution_reports(slippage_vs_edge_ratio);
CREATE INDEX IF NOT EXISTS idx_execution_reports_executed ON execution_reports(executed_at);

-- ============================================================
-- EXECUTION SUMMARY - Daily aggregated execution quality metrics
-- ============================================================
-- Summary for dashboards and alerts

CREATE TABLE IF NOT EXISTS execution_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_date TEXT NOT NULL,

  -- Order counts
  total_orders INTEGER NOT NULL DEFAULT 0,
  excellent_count INTEGER NOT NULL DEFAULT 0,
  good_count INTEGER NOT NULL DEFAULT 0,
  acceptable_count INTEGER NOT NULL DEFAULT 0,
  poor_count INTEGER NOT NULL DEFAULT 0,

  -- Slippage stats
  average_slippage REAL NOT NULL DEFAULT 0,
  average_slippage_ratio REAL NOT NULL DEFAULT 0,

  -- Grades
  average_grade_score REAL NOT NULL DEFAULT 0,  -- 4=excellent, 3=good, 2=acceptable, 1=poor

  -- Kill switch (I18)
  kill_switch_triggered INTEGER NOT NULL DEFAULT 0,
  kill_switch_count INTEGER NOT NULL DEFAULT 0,

  -- Time bounds
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,

  -- Computed at
  computed_at TEXT DEFAULT (datetime('now')),

  UNIQUE(summary_date)
);

CREATE INDEX IF NOT EXISTS idx_execution_summary_date ON execution_summary(summary_date);
CREATE INDEX IF NOT EXISTS idx_execution_summary_kill_switch ON execution_summary(kill_switch_triggered);

-- ============================================================
-- MARKET CONDITIONS SNAPSHOT - Record market state at order submission
-- ============================================================
-- Helps diagnose execution issues and understand slippage drivers

CREATE TABLE IF NOT EXISTS market_conditions_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES execution_reports(order_id),
  ticker TEXT NOT NULL,

  -- Pricing
  yes_bid REAL,
  yes_ask REAL,
  no_bid REAL,
  no_ask REAL,

  -- Liquidity
  spread REAL,
  depth_yes REAL,
  depth_no REAL,
  volume_24h REAL,

  -- Market health
  vpin REAL,
  volatility REAL,
  time_to_settlement_hours REAL,

  -- Context
  captured_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_market_conditions_order ON market_conditions_snapshots(order_id);
CREATE INDEX IF NOT EXISTS idx_market_conditions_ticker ON market_conditions_snapshots(ticker);
CREATE INDEX IF NOT EXISTS idx_market_conditions_captured ON market_conditions_snapshots(captured_at);

-- ============================================================
-- VERSION TRACKING
-- ============================================================

INSERT INTO audit_log (id, event_type, entity_type, payload, timestamp)
VALUES (
  'migration_0021_' || datetime('now', 'localtime'),
  'schema_migration',
  'system',
  '{\"migration\": \"0021_phase_b_execution_quality\", \"changes\": [\"execution_reports table\", \"execution_summary table\", \"market_conditions_snapshots table\", \"kill switch metrics for I18\"]}',
  datetime('now')
);
