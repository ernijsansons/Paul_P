-- Paul P Evidence Store Schema (P-12)
-- Migration: 0008_evidence_store.sql
-- Tables: evidence_blobs

-- ============================================================
-- EVIDENCE BLOBS - Raw API response tracking
-- Store raw response BEFORE parsing (evidence-first architecture)
-- ============================================================
CREATE TABLE evidence_blobs (
  evidence_hash TEXT PRIMARY KEY, -- SHA-256 of raw response bytes
  r2_key TEXT NOT NULL, -- R2 object key: 'evidence/{source}/{YYYY-MM-DD}/{hash}.gz'

  source TEXT NOT NULL, -- 'kalshi_api', 'polymarket_gamma', 'polymarket_clob', 'polymarket_data', 'noaa', 'fred'
  endpoint TEXT NOT NULL, -- exact API endpoint called

  -- Request context
  request_method TEXT DEFAULT 'GET',
  request_params TEXT, -- JSON of query params or body hash

  -- Response metadata
  fetched_at TEXT NOT NULL,
  response_status INTEGER, -- HTTP status code
  response_size_bytes INTEGER,
  content_type TEXT DEFAULT 'application/json',
  compression TEXT DEFAULT 'gzip',

  -- Verification
  verified_at TEXT, -- when blob was verified to exist in R2
  verification_passed INTEGER DEFAULT 1,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_evidence_source ON evidence_blobs(source, fetched_at);
CREATE INDEX idx_evidence_endpoint ON evidence_blobs(endpoint);

-- ============================================================
-- EVIDENCE USAGE - Track which records reference which evidence
-- ============================================================
CREATE TABLE evidence_usage (
  id TEXT PRIMARY KEY,
  evidence_hash TEXT NOT NULL REFERENCES evidence_blobs(evidence_hash),

  -- What was derived from this evidence
  derived_entity_type TEXT NOT NULL, -- 'position', 'trade', 'market', 'account'
  derived_entity_id TEXT NOT NULL,

  -- Derivation details
  extraction_path TEXT, -- JSONPath or description of how data was extracted
  extracted_at TEXT NOT NULL,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_evidence_usage_hash ON evidence_usage(evidence_hash);
CREATE INDEX idx_evidence_usage_entity ON evidence_usage(derived_entity_type, derived_entity_id);
