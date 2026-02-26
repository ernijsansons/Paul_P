-- Paul P Market Canonicalization & Pairing Schema (P-04)
-- Migration: 0004_market_pairing.sql
-- Tables: canonical_events, canonical_markets, market_pairs

-- ============================================================
-- CANONICAL EVENTS - Unified event representation across venues
-- ============================================================
CREATE TABLE canonical_events (
  id TEXT PRIMARY KEY, -- human-readable slug: 'us-presidential-election-2028'
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  earliest_market_date TEXT,
  latest_resolution_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_canonical_events_category ON canonical_events(category);

-- ============================================================
-- CANONICAL MARKETS - Venue-specific market within a canonical event
-- ============================================================
CREATE TABLE canonical_markets (
  id TEXT PRIMARY KEY, -- deterministic: hash(canonical_event_id + venue + venue_market_id)
  canonical_event_id TEXT NOT NULL REFERENCES canonical_events(id),
  venue TEXT NOT NULL CHECK(venue IN ('polymarket', 'kalshi', 'robinhood', 'ibkr')),
  venue_market_id TEXT NOT NULL, -- condition_id for Polymarket, ticker for Kalshi
  venue_market_title TEXT,
  resolution_criteria_text TEXT NOT NULL,
  resolution_source TEXT,
  settlement_timing TEXT, -- 'immediate', 'T+1', 'end-of-day', etc.
  void_rules TEXT, -- when/how market can void

  -- (P-16) Market mechanics classification
  market_mechanics TEXT CHECK(market_mechanics IN (
    'binary_token',       -- Standard YES/NO tokens, sum ~ $1.00
    'orderbook_binary',   -- Limit order book, YES+NO may != $1.00
    'multi_outcome',      -- 3+ outcomes
    'fee_adjusted',       -- Venue charges affect effective price
    'void_risk'           -- High probability of void/refund
  )),

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(venue, venue_market_id)
);

CREATE INDEX idx_canonical_markets_event ON canonical_markets(canonical_event_id);
CREATE INDEX idx_canonical_markets_venue ON canonical_markets(venue);

-- ============================================================
-- MARKET PAIRS - Cross-venue market equivalence
-- ============================================================
CREATE TABLE market_pairs (
  id TEXT PRIMARY KEY,
  canonical_event_id TEXT NOT NULL REFERENCES canonical_events(id),
  market_a_id TEXT NOT NULL REFERENCES canonical_markets(id),
  market_b_id TEXT NOT NULL REFERENCES canonical_markets(id),

  -- Equivalence assessment
  equivalence_grade TEXT NOT NULL CHECK(equivalence_grade IN (
    'identical',              -- same resolution source, criteria, timing
    'near_equivalent',        -- minor wording differences, same meaning
    'similar_but_divergent',  -- same event but different resolution criteria
    'not_equivalent'          -- should never be paired for arb
  )),

  -- Detailed divergence analysis
  settlement_rule_similarity REAL NOT NULL, -- 0.0 to 1.0 (LLM + human verified)
  shared_underlying_event INTEGER NOT NULL DEFAULT 1,
  disqualifying_mismatches TEXT, -- JSON array: ['time_window', 'data_source', 'void_rules']

  -- (P-20) Equivalence Proof Checklist - deterministic, stored as JSON
  -- {
  --   "resolution_source_match": true/false,
  --   "timing_window_match": true/false,
  --   "void_rules_match": true/false,
  --   "reference_price_source_match": true/false,
  --   "data_publisher_match": true/false,
  --   "wording_delta": "none|minor|material",
  --   "settlement_timing_delta_hours": 0,
  --   "forbidden_mismatches_found": [],
  --   "notes": "free text explanation"
  -- }
  equivalence_checklist TEXT NOT NULL DEFAULT '{}',

  -- (P-20) Pair lifecycle - expiry and rule change detection
  expires_at TEXT, -- pair must be re-verified after 30 days or on rule change
  rule_text_hash_a TEXT, -- SHA-256 of market A resolution text
  rule_text_hash_b TEXT, -- SHA-256 of market B resolution text

  -- Review chain
  llm_analysis_run_id TEXT, -- FK to llm_scoring_runs
  human_reviewer TEXT,
  human_review_date TEXT,
  human_review_notes TEXT,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN (
    'pending_review',
    'approved',
    'rejected',
    'expired'
  )),

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_market_pairs_event ON market_pairs(canonical_event_id);
CREATE INDEX idx_market_pairs_status ON market_pairs(status);
CREATE INDEX idx_market_pairs_grade ON market_pairs(equivalence_grade);
