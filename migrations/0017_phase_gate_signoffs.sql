-- Phase Gate Signoffs
-- Tracks phase gate verification and signoffs for audit trail

CREATE TABLE IF NOT EXISTS phase_gate_signoffs (
  id TEXT PRIMARY KEY,
  phase INTEGER NOT NULL,
  target_phase INTEGER NOT NULL,
  signed_off_by TEXT NOT NULL,
  signed_off_at TEXT NOT NULL,
  gate_result TEXT NOT NULL,  -- JSON blob with full PhaseGateResult
  notes TEXT,

  CHECK (phase IN (1, 2, 3, 4)),
  CHECK (target_phase IN (1, 2, 3, 4)),
  CHECK (target_phase >= phase)
);

CREATE INDEX IF NOT EXISTS idx_phase_gate_signoffs_phase ON phase_gate_signoffs(phase);
CREATE INDEX IF NOT EXISTS idx_phase_gate_signoffs_signed_off_at ON phase_gate_signoffs(signed_off_at);

-- Test results tracking (for gate verification)
CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  test_suite TEXT NOT NULL,
  test_name TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'passed', 'failed', 'skipped'
  duration_ms INTEGER,
  error_message TEXT,
  run_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_test_results_suite ON test_results(test_suite);
CREATE INDEX IF NOT EXISTS idx_test_results_status ON test_results(status);

-- Backtest results tracking
CREATE TABLE IF NOT EXISTS backtest_results (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  backtest_name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  total_trades INTEGER NOT NULL,
  winning_trades INTEGER NOT NULL,
  total_pnl REAL NOT NULL,
  expected_value REAL NOT NULL,
  sharpe_ratio REAL,
  max_drawdown REAL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backtest_results_strategy ON backtest_results(strategy_id);
CREATE INDEX IF NOT EXISTS idx_backtest_results_completed ON backtest_results(completed_at);

-- Weather predictions tracking (for OOS verification)
CREATE TABLE IF NOT EXISTS weather_predictions (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  threshold REAL NOT NULL,
  predicted_prob REAL NOT NULL,
  actual_outcome INTEGER,  -- 1 = above threshold, 0 = below
  prediction_correct INTEGER,  -- 1 if prediction matched outcome
  is_out_of_sample INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_weather_predictions_market ON weather_predictions(market_id);
CREATE INDEX IF NOT EXISTS idx_weather_predictions_resolved ON weather_predictions(resolved);
CREATE INDEX IF NOT EXISTS idx_weather_predictions_oos ON weather_predictions(is_out_of_sample);

-- LLM drift sweep results
CREATE TABLE IF NOT EXISTS llm_drift_sweeps (
  id TEXT PRIMARY KEY,
  prompt_version TEXT NOT NULL,
  prompt_type TEXT NOT NULL,
  test_count INTEGER NOT NULL,
  pass_rate REAL NOT NULL,
  max_delta REAL NOT NULL,
  correlation REAL NOT NULL,
  rank_order_stable INTEGER NOT NULL,
  adversarial_pass_rate REAL NOT NULL,
  deploy_allowed INTEGER NOT NULL,
  failures TEXT,  -- JSON array of failure messages
  sweep_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_llm_drift_sweeps_version ON llm_drift_sweeps(prompt_version);
CREATE INDEX IF NOT EXISTS idx_llm_drift_sweeps_at ON llm_drift_sweeps(sweep_at);

-- Compliance violations tracking
CREATE TABLE IF NOT EXISTS compliance_violations (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  violation_type TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL,  -- 'warning', 'critical'
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_compliance_violations_source ON compliance_violations(source_name);
CREATE INDEX IF NOT EXISTS idx_compliance_violations_resolved ON compliance_violations(resolved_at);
