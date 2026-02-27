-- Paul P Migration 0018: LLM Routing Layer
-- Adds tables for routing decisions and budget tracking

-- ============================================================
-- LLM Routing Decisions (audit log)
-- ============================================================
-- Every routing decision is logged for full traceability.
-- Includes model selection, fallback attempts, cost, and latency.

CREATE TABLE IF NOT EXISTS llm_routing_decisions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,                           -- ISO 8601
  run_type TEXT NOT NULL,                            -- LLMRunType
  route_class TEXT NOT NULL,                         -- RouteClass
  selected_model TEXT NOT NULL,                      -- JSON: ModelId
  fallbacks_attempted TEXT NOT NULL,                 -- JSON: ModelId[]
  budget_category TEXT NOT NULL,                     -- BudgetCategory
  projected_cost_usd REAL NOT NULL,                  -- Estimated cost before execution
  actual_cost_usd REAL,                              -- Actual cost after execution
  latency_ms INTEGER,                                -- Execution latency
  success INTEGER NOT NULL CHECK(success IN (0, 1)), -- 0 = failed, 1 = success
  failure_reason TEXT,                               -- Error message if failed
  decision_hash TEXT NOT NULL,                       -- SHA-256 of decision inputs
  strategy_id TEXT,                                  -- Optional strategy linkage
  override_used INTEGER DEFAULT 0 CHECK(override_used IN (0, 1)),
  override_reason TEXT,
  metadata TEXT,                                     -- JSON metadata payload
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_routing_decisions_timestamp
  ON llm_routing_decisions(timestamp);

-- Index for filtering by budget category
CREATE INDEX IF NOT EXISTS idx_routing_decisions_category
  ON llm_routing_decisions(budget_category);

-- Index for filtering by success/failure
CREATE INDEX IF NOT EXISTS idx_routing_decisions_success
  ON llm_routing_decisions(success);

-- Index for filtering by run type
CREATE INDEX IF NOT EXISTS idx_routing_decisions_run_type
  ON llm_routing_decisions(run_type);

-- Index for filtering by route class
CREATE INDEX IF NOT EXISTS idx_routing_decisions_route_class
  ON llm_routing_decisions(route_class);

-- ============================================================
-- LLM Budget Usage Tracking
-- ============================================================
-- Records all LLM spending for budget enforcement.
-- Separate records for daily and monthly periods.

CREATE TABLE IF NOT EXISTS llm_budget_usage (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,                            -- BudgetCategory
  period_start TEXT NOT NULL,                        -- YYYY-MM-DD (daily) or YYYY-MM-01 (monthly)
  period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'monthly')),
  cost_usd REAL NOT NULL,                            -- Cost in USD
  timestamp TEXT NOT NULL,                           -- ISO 8601 when usage was recorded
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for budget queries (category + period lookup)
CREATE INDEX IF NOT EXISTS idx_budget_usage_lookup
  ON llm_budget_usage(category, period_start, period_type);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_budget_usage_timestamp
  ON llm_budget_usage(timestamp);

-- Index for aggregation by category
CREATE INDEX IF NOT EXISTS idx_budget_usage_category
  ON llm_budget_usage(category);

-- ============================================================
-- Views for Budget Monitoring
-- ============================================================

-- Daily budget summary view
CREATE VIEW IF NOT EXISTS v_daily_budget_summary AS
SELECT
  category,
  period_start,
  SUM(cost_usd) as total_cost_usd,
  COUNT(*) as transaction_count
FROM llm_budget_usage
WHERE period_type = 'daily'
GROUP BY category, period_start
ORDER BY period_start DESC, category;

-- Monthly budget summary view
CREATE VIEW IF NOT EXISTS v_monthly_budget_summary AS
SELECT
  category,
  period_start,
  SUM(cost_usd) as total_cost_usd,
  COUNT(*) as transaction_count
FROM llm_budget_usage
WHERE period_type = 'monthly'
GROUP BY category, period_start
ORDER BY period_start DESC, category;

-- Routing success rate by route class (last 7 days)
CREATE VIEW IF NOT EXISTS v_routing_success_rate AS
SELECT
  route_class,
  COUNT(*) as total_decisions,
  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
  ROUND(100.0 * SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate_pct,
  ROUND(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END), 0) as avg_latency_ms,
  ROUND(SUM(COALESCE(actual_cost_usd, 0)), 4) as total_cost_usd
FROM llm_routing_decisions
WHERE timestamp >= datetime('now', '-7 days')
GROUP BY route_class
ORDER BY total_decisions DESC;
