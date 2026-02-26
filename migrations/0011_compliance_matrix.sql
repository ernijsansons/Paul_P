-- Paul P Compliance Matrix Schema (P-23)
-- Migration: 0011_compliance_matrix.sql
-- Tables: compliance_matrix

-- ============================================================
-- COMPLIANCE MATRIX - Data source usage rules
-- Hard rule: data source with status != 'approved' is blocked from ingestion
-- ============================================================
CREATE TABLE compliance_matrix (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL UNIQUE, -- 'polymarket_gamma_api', 'kalshi_trade_api', etc.

  -- Usage permissions
  allowed_usage TEXT NOT NULL, -- JSON: ['market_data_read', 'price_monitoring', ...]
  prohibited_usage TEXT, -- JSON: ['automated_trading', 'resale', ...]

  -- Rate limits
  rate_limits TEXT, -- JSON: {'requests_per_second': 10, 'daily_cap': null}
  retry_policy TEXT, -- JSON: {'max_retries': 3, 'backoff_base_ms': 1000}

  -- Data handling
  retention_rules TEXT, -- JSON: {'max_cache_duration_hours': 24, 'raw_storage_allowed': true}
  pii_handling TEXT, -- JSON: any PII-specific rules

  -- Attribution
  attribution_required INTEGER DEFAULT 0,
  attribution_text TEXT,

  -- Terms of Service
  tos_url TEXT NOT NULL,
  tos_version TEXT, -- version/date of ToS we reviewed
  tos_snapshot_evidence_hash TEXT, -- SHA-256 of stored ToS snapshot
  tos_snapshot_r2_key TEXT,
  tos_retrieved_at TEXT NOT NULL,
  tos_next_review_date TEXT NOT NULL, -- when to re-check ToS for changes

  -- Scraping policy
  scraping_permitted INTEGER, -- 1 = explicit permission, 0 = prohibited, NULL = ambiguous
  scraping_notes TEXT, -- explanation if ambiguous
  robots_txt_compliant INTEGER DEFAULT 1,

  -- API-specific
  authentication_required INTEGER DEFAULT 0,
  authentication_type TEXT, -- 'api_key', 'oauth', 'rsa_pss', none

  -- Status (CRITICAL: blocked sources cannot be ingested)
  status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN (
    'approved',      -- can be used
    'under_review',  -- temporarily blocked pending review
    'blocked'        -- permanently blocked
  )),
  block_reason TEXT, -- if blocked, why

  -- Review chain
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_compliance_status ON compliance_matrix(status);
CREATE INDEX idx_compliance_tos_review ON compliance_matrix(tos_next_review_date);

-- ============================================================
-- COMPLIANCE EVENTS - Track compliance-related events
-- ============================================================
CREATE TABLE compliance_events (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL REFERENCES compliance_matrix(source_name),

  event_type TEXT NOT NULL CHECK(event_type IN (
    'tos_change_detected',    -- ToS text changed
    'rate_limit_hit',         -- hit rate limit
    'blocked_access',         -- access was blocked
    'api_error',              -- API returned error
    'review_triggered',       -- manual review triggered
    'status_change'           -- compliance status changed
  )),

  event_timestamp TEXT NOT NULL,
  details TEXT, -- JSON with event-specific details

  -- Response
  action_taken TEXT,
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_compliance_events_source ON compliance_events(source_name);
CREATE INDEX idx_compliance_events_type ON compliance_events(event_type);
CREATE INDEX idx_compliance_events_unresolved ON compliance_events(resolved) WHERE resolved = 0;
