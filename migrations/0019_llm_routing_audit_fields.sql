-- Paul P Migration 0019: LLM Routing Audit Indexes
-- NOTE:
-- - Audit columns are included in 0018 base schema for new deployments.
-- - Existing deployments that already have these columns should remain valid.
-- - This migration is index-only to stay idempotent across mixed historical states.

CREATE INDEX IF NOT EXISTS idx_routing_decisions_strategy_id
  ON llm_routing_decisions(strategy_id);

-- ============================================================
-- Index for finding overridden decisions
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_routing_decisions_override_used
  ON llm_routing_decisions(override_used);
