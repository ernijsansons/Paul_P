-- Paul P LLM Governance Schema (P-07, P-21)
-- Migration: 0005_llm_governance.sql
-- Tables: llm_scoring_runs, llm_regression_tests, llm_drift_sweeps

-- ============================================================
-- LLM SCORING RUNS - Track every LLM invocation
-- ============================================================
CREATE TABLE llm_scoring_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL CHECK(run_type IN (
    'ambiguity_score',
    'resolution_analysis',
    'equivalence_assessment',
    'rule_interpretation'
  )),
  target_entity_type TEXT NOT NULL, -- 'market', 'market_pair'
  target_entity_id TEXT NOT NULL,

  -- Prompt governance
  prompt_template_version TEXT NOT NULL, -- semver: '1.0.0', '1.1.0'
  prompt_template_hash TEXT NOT NULL, -- SHA-256 of exact prompt text
  model_id TEXT NOT NULL, -- 'claude-sonnet-4-20250514', etc.

  -- Input
  input_text TEXT NOT NULL, -- exact text sent to LLM
  input_hash TEXT NOT NULL, -- SHA-256 of input for dedup

  -- Structured output
  output_json TEXT NOT NULL, -- JSON: must include 'score', 'reasoning', 'cited_passages'
  output_score REAL, -- extracted numeric score for fast queries
  cited_rule_passages TEXT, -- JSON array of exact passages from resolution criteria

  -- Quality
  confidence REAL, -- LLM self-reported confidence 0-1
  flagged_for_human_review INTEGER DEFAULT 0,
  human_override_score REAL, -- if human disagrees
  human_override_reason TEXT,

  -- Regression tracking
  regression_test_id TEXT, -- FK to regression test suite

  -- Cost
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_llm_runs_target ON llm_scoring_runs(target_entity_type, target_entity_id);
CREATE INDEX idx_llm_runs_prompt_version ON llm_scoring_runs(prompt_template_version);
CREATE INDEX idx_llm_runs_model ON llm_scoring_runs(model_id);
CREATE INDEX idx_llm_runs_flagged ON llm_scoring_runs(flagged_for_human_review) WHERE flagged_for_human_review = 1;

-- ============================================================
-- LLM REGRESSION TESTS - Gold corpus for prompt validation
-- ============================================================
CREATE TABLE llm_regression_tests (
  id TEXT PRIMARY KEY,
  prompt_template_version TEXT NOT NULL,
  run_type TEXT NOT NULL,

  -- Test case
  test_input TEXT NOT NULL, -- known resolution criteria text
  expected_score_min REAL NOT NULL, -- acceptable range
  expected_score_max REAL NOT NULL,
  expected_key_passages TEXT, -- JSON array of passages that must be cited

  -- (P-21) Test case classification
  test_category TEXT NOT NULL DEFAULT 'standard' CHECK(test_category IN (
    'standard',               -- normal resolution criteria
    'edge_case',              -- tricky wording, unusual structure
    'historically_disputed',  -- markets that actually had disputes
    'ambiguous_phrasing',     -- deliberately ambiguous language
    'prompt_injection',       -- adversarial input attempting to manipulate
    'cross_language'          -- non-English or mixed-language criteria
  )),

  -- Test context
  test_description TEXT,
  expected_reasoning_keywords TEXT, -- JSON array of expected keywords in reasoning

  -- Results
  actual_score REAL,
  actual_passages TEXT,
  passed INTEGER, -- 0 or 1

  run_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_regression_tests_version ON llm_regression_tests(prompt_template_version);
CREATE INDEX idx_regression_tests_category ON llm_regression_tests(test_category);
CREATE INDEX idx_regression_tests_passed ON llm_regression_tests(passed);

-- ============================================================
-- LLM DRIFT SWEEPS - Monitor stability across versions (P-21)
-- ============================================================
CREATE TABLE llm_drift_sweeps (
  id TEXT PRIMARY KEY,
  sweep_type TEXT NOT NULL CHECK(sweep_type IN (
    'prompt_version_change',
    'model_version_change',
    'nightly_stability'
  )),

  -- Comparison
  baseline_prompt_version TEXT NOT NULL,
  baseline_model_id TEXT NOT NULL,
  candidate_prompt_version TEXT NOT NULL,
  candidate_model_id TEXT NOT NULL,

  -- Results
  gold_set_size INTEGER NOT NULL, -- number of test cases in gold set
  mean_score_delta REAL, -- mean absolute difference in scores
  max_score_delta REAL, -- worst case delta
  rank_order_changes INTEGER, -- how many items changed rank
  prompt_injection_pass_rate REAL, -- % of injection attempts correctly rejected

  -- Thresholds
  mean_delta_threshold REAL NOT NULL DEFAULT 0.10,
  max_delta_threshold REAL NOT NULL DEFAULT 0.25,
  injection_pass_threshold REAL NOT NULL DEFAULT 1.0, -- must be 100%

  -- Decision
  passed INTEGER, -- 0 or 1
  blocked_deployment INTEGER DEFAULT 0,
  failure_reasons TEXT, -- JSON array of specific failures

  run_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_drift_sweeps_type ON llm_drift_sweeps(sweep_type);
CREATE INDEX idx_drift_sweeps_passed ON llm_drift_sweeps(passed);
CREATE INDEX idx_drift_sweeps_blocked ON llm_drift_sweeps(blocked_deployment) WHERE blocked_deployment = 1;
