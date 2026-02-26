-- Paul P Sources Table (P-12)
-- Migration: 0016_sources_table.sql
-- Evidence source tracking for raw API responses and data provenance

-- ============================================================
-- SOURCES - Evidence source tracking
-- Tracks raw evidence storage for all ingested data
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, -- hash-based deterministic ID
  source_type TEXT NOT NULL CHECK(source_type IN (
    'api_response',     -- raw API response blob
    'orderbook',        -- orderbook snapshot
    'market_data',      -- market listing data
    'account_data',     -- account/position data
    'leaderboard',      -- leaderboard snapshot
    'websocket',        -- WebSocket message
    'on_chain'          -- blockchain query result
  )),

  source_url TEXT,           -- API endpoint URL
  source_vendor TEXT,        -- 'polymarket', 'kalshi', etc.
  quality TEXT CHECK(quality IN ('raw', 'parsed', 'validated')),

  -- Evidence linkage
  evidence_hash TEXT NOT NULL,     -- SHA-256 of stored content
  evidence_blob_key TEXT NOT NULL, -- R2 object key

  -- Timing
  fetched_at TEXT NOT NULL,  -- when data was fetched
  expires_at TEXT,           -- when data becomes stale

  -- Context
  metadata TEXT,  -- JSON: additional context
  lineage TEXT,   -- JSON: upstream dependencies

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_sources_type ON sources(source_type);
CREATE INDEX idx_sources_vendor ON sources(source_vendor);
CREATE INDEX idx_sources_hash ON sources(evidence_hash);
CREATE INDEX idx_sources_fetched ON sources(fetched_at);
