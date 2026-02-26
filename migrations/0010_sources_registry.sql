-- Paul P Sources Registry Schema (P-15)
-- Migration: 0010_sources_registry.sql
-- Tables: sources_registry

-- ============================================================
-- SOURCES REGISTRY - FACT provenance tracking
-- Rule: No FACT label without a traceable evidence pointer
-- ============================================================
CREATE TABLE sources_registry (
  citation_id TEXT PRIMARY KEY, -- 'SR-001', 'SR-002', etc.
  claim_text TEXT NOT NULL, -- the specific factual claim

  source_type TEXT NOT NULL CHECK(source_type IN (
    'api_response',    -- raw API response blob
    'paper_snapshot',  -- academic paper PDF
    'article_snapshot', -- blog/news article HTML
    'screenshot',      -- X post, forum, etc.
    'computation',     -- derived from stored evidence via code
    'on_chain'         -- blockchain query result
  )),

  source_url TEXT, -- original URL (may be dead)
  source_title TEXT,
  source_author TEXT,
  publication_date TEXT,
  retrieved_at TEXT NOT NULL,

  -- Evidence linkage
  evidence_hash TEXT, -- SHA-256 of stored snapshot/blob
  r2_key TEXT, -- R2 object key for stored snapshot
  computation_code_ref TEXT, -- for 'computation' type: git commit + file path
  input_evidence_hashes TEXT, -- for 'computation': JSON array of input evidence hashes

  -- Freshness
  verified_current_at TEXT, -- last date claim was re-verified
  expires_at TEXT, -- when claim should be re-checked
  auto_reverify_days INTEGER, -- how often to auto-reverify

  -- Confidence
  confidence_level TEXT CHECK(confidence_level IN (
    'high',       -- primary source, verified
    'medium',     -- secondary source, plausible
    'low'         -- third-party, unverified
  )),

  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active',     -- claim is current and verified
    'expired',    -- needs reverification
    'retracted',  -- claim was found to be incorrect
    'unverified'  -- not yet verified
  )),

  -- Review
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_sources_status ON sources_registry(status);
CREATE INDEX idx_sources_type ON sources_registry(source_type);
CREATE INDEX idx_sources_expires ON sources_registry(expires_at);
