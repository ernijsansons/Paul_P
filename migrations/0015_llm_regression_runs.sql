-- Paul P LLM Regression Runs (P-21)
-- Migration: 0015_llm_regression_runs.sql
-- Stores regression test suite execution results for historical tracking

CREATE TABLE IF NOT EXISTS llm_regression_runs (
  run_id TEXT PRIMARY KEY,
  prompt_version TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  total_tests INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  pass_rate REAL NOT NULL,
  by_category TEXT NOT NULL, -- JSON: { category: { passed: N, failed: N } }
  execution_time_ms INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_regression_runs_prompt ON llm_regression_runs(prompt_version);
CREATE INDEX idx_regression_runs_timestamp ON llm_regression_runs(timestamp);
