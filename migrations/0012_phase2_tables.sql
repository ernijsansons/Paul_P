-- Paul P Phase 2 Schema (VPIN, Skill, Scoring, Sources)
-- Migration: 0012_phase2_tables.sql
-- Tables: vpin_snapshots, skill_scores, account_metrics, leaderboard_entries, midpoints, sources
--
-- NOTE: llm_scoring_runs moved to 0005_llm_governance.sql
-- NOTE: market_pairs moved to 0004_market_pairing.sql
-- NOTE: price_history (OHLCV) in 0002_market_enrichment.sql

-- ============================================================
-- VPIN SNAPSHOTS TABLE (P-25: Flow toxicity)
-- ============================================================
CREATE TABLE IF NOT EXISTS vpin_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  vpin REAL NOT NULL CHECK(vpin >= 0 AND vpin <= 1),
  flow_classification TEXT NOT NULL CHECK(flow_classification IN ('normal', 'elevated', 'toxic')),
  edge_multiplier REAL NOT NULL,
  should_pause INTEGER NOT NULL,
  bucket_count INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vpin_market ON vpin_snapshots(market_id);
CREATE INDEX IF NOT EXISTS idx_vpin_classification ON vpin_snapshots(flow_classification);
CREATE INDEX IF NOT EXISTS idx_vpin_computed ON vpin_snapshots(computed_at);

-- ============================================================
-- SKILL SCORES TABLE (8-factor rubric)
-- ============================================================
CREATE TABLE IF NOT EXISTS skill_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  total_score REAL NOT NULL CHECK(total_score >= 0 AND total_score <= 100),
  tier TEXT NOT NULL CHECK(tier IN ('elite', 'skilled', 'competent', 'noise', 'losing')),
  factors TEXT NOT NULL, -- JSON with 8-factor breakdown
  computed_at TEXT NOT NULL,
  included_clv INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_skill_account ON skill_scores(account_id, venue);
CREATE INDEX IF NOT EXISTS idx_skill_tier ON skill_scores(tier);
CREATE INDEX IF NOT EXISTS idx_skill_computed ON skill_scores(computed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_account_venue_latest ON skill_scores(account_id, venue, computed_at);

-- ============================================================
-- ACCOUNT METRICS TABLE (raw metrics for skill scoring)
-- ============================================================
CREATE TABLE IF NOT EXISTS account_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  total_positions INTEGER NOT NULL DEFAULT 0,
  total_pnl REAL NOT NULL DEFAULT 0,
  total_fees REAL NOT NULL DEFAULT 0,
  portfolio_value REAL NOT NULL DEFAULT 0,
  account_created_at INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  UNIQUE(account_id, venue)
);

CREATE INDEX IF NOT EXISTS idx_metrics_account ON account_metrics(account_id);
CREATE INDEX IF NOT EXISTS idx_metrics_venue ON account_metrics(venue);

-- ============================================================
-- LEADERBOARD ENTRIES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  rank INTEGER NOT NULL,
  profit REAL NOT NULL,
  volume REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(account_id, venue, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_account ON leaderboard_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_venue ON leaderboard_entries(venue);
CREATE INDEX IF NOT EXISTS idx_leaderboard_rank ON leaderboard_entries(rank);
CREATE INDEX IF NOT EXISTS idx_leaderboard_fetched ON leaderboard_entries(fetched_at);

-- ============================================================
-- MIDPOINTS TABLE (for VPIN computation)
-- ============================================================
CREATE TABLE IF NOT EXISTS midpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  price REAL NOT NULL CHECK(price >= 0 AND price <= 1),
  timestamp INTEGER NOT NULL,
  UNIQUE(market_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_midpoints_market ON midpoints(market_id);
CREATE INDEX IF NOT EXISTS idx_midpoints_timestamp ON midpoints(timestamp);

-- ============================================================
-- SOURCES TABLE (P-12: FACT provenance for computed facts)
-- Note: sources_registry (0010) is for documentation citations
-- This table is for runtime evidence tracking during ingestion
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('api_response', 'websocket_message', 'webhook_payload', 'manual_entry', 'computed')),
  source_url TEXT NOT NULL,
  source_vendor TEXT NOT NULL,
  quality TEXT NOT NULL CHECK(quality IN ('authoritative', 'primary', 'secondary', 'tertiary')),
  evidence_hash TEXT NOT NULL,
  evidence_blob_key TEXT, -- R2 key
  fetched_at TEXT NOT NULL,
  expires_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON
  lineage TEXT, -- JSON array of parent source IDs
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_vendor ON sources(source_vendor);
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(source_type);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(evidence_hash);
CREATE INDEX IF NOT EXISTS idx_sources_quality ON sources(quality);
CREATE INDEX IF NOT EXISTS idx_sources_created ON sources(created_at);
CREATE INDEX IF NOT EXISTS idx_sources_expires ON sources(expires_at);

-- ============================================================
-- ALTER TRADES TABLE (add venue and market_id if not exist)
-- ============================================================
-- Note: These columns may already exist from previous migrations
-- SQLite doesn't have IF NOT EXISTS for ALTER TABLE, so we handle
-- errors gracefully at runtime. Consider using a migration tool.

-- Attempt to add venue column (will fail silently if exists in D1)
-- ALTER TABLE trades ADD COLUMN venue TEXT;
-- ALTER TABLE trades ADD COLUMN market_id TEXT;

-- Instead, we ensure indexes exist (IF NOT EXISTS is supported)
CREATE INDEX IF NOT EXISTS idx_trades_venue ON trades(venue);
CREATE INDEX IF NOT EXISTS idx_trades_market_id ON trades(market_id);
