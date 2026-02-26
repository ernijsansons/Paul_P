-- Paul P Audit Chain Anchoring Schema (P-08)
-- Migration: 0009_audit_anchoring.sql
-- Tables: audit_chain_anchors

-- ============================================================
-- AUDIT CHAIN ANCHORS - External verification of audit integrity
-- Periodic hash anchoring to secondary D1 database
-- ============================================================
CREATE TABLE audit_chain_anchors (
  id TEXT PRIMARY KEY,
  chain_head_hash TEXT NOT NULL, -- current head of R2 hash chain
  chain_length INTEGER NOT NULL, -- number of events in chain

  -- Anchor details
  anchor_timestamp TEXT NOT NULL,
  anchor_sequence INTEGER NOT NULL, -- incrementing sequence number

  -- Range covered by this anchor
  first_event_id TEXT NOT NULL,
  last_event_id TEXT NOT NULL,
  first_event_timestamp TEXT NOT NULL,
  last_event_timestamp TEXT NOT NULL,

  -- External anchoring
  anchored_to TEXT NOT NULL CHECK(anchored_to IN (
    'd1_secondary',           -- separate D1 database
    'external_notarization',  -- third-party notarization service
    'on_chain'                -- blockchain anchor (optional)
  )),
  external_reference TEXT, -- txid, secondary DB record id, etc.

  -- Verification
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  verification_method TEXT, -- how verification was performed

  -- Integrity checks
  events_in_range_count INTEGER,
  computed_hash_matches INTEGER DEFAULT 1, -- recomputation verification

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_anchors_timestamp ON audit_chain_anchors(anchor_timestamp);
CREATE INDEX idx_anchors_sequence ON audit_chain_anchors(anchor_sequence);
CREATE INDEX idx_anchors_verified ON audit_chain_anchors(verified);

-- ============================================================
-- AUDIT CHAIN EVENTS - Individual audit trail entries
-- Stored in D1 for queryability, mirrored to R2 hash chain
-- ============================================================
CREATE TABLE audit_chain_events (
  id TEXT PRIMARY KEY, -- UUID
  event_sequence INTEGER NOT NULL, -- global sequence number

  timestamp TEXT NOT NULL, -- ISO 8601
  agent TEXT NOT NULL, -- 'strategy-bonding-001', 'risk-governor', etc.
  event_type TEXT NOT NULL, -- 'ORDER_SUBMITTED', 'POSITION_OPENED', etc.

  -- Payload
  payload TEXT NOT NULL, -- JSON
  payload_hash TEXT NOT NULL, -- SHA-256 of payload

  -- Evidence linkage
  evidence_hash TEXT, -- optional: link to evidence blob
  r2_evidence_key TEXT,

  -- Hash chain
  prev_hash TEXT NOT NULL, -- SHA-256 of previous entry
  hash TEXT NOT NULL, -- SHA-256(id + timestamp + agent + event_type + payload_hash + evidence_hash + prev_hash)

  -- R2 sync status
  r2_synced INTEGER DEFAULT 0,
  r2_synced_at TEXT,
  r2_key TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_events_sequence ON audit_chain_events(event_sequence);
CREATE INDEX idx_audit_events_type ON audit_chain_events(event_type);
CREATE INDEX idx_audit_events_agent ON audit_chain_events(agent);
CREATE INDEX idx_audit_events_timestamp ON audit_chain_events(timestamp);
CREATE INDEX idx_audit_events_r2sync ON audit_chain_events(r2_synced) WHERE r2_synced = 0;
