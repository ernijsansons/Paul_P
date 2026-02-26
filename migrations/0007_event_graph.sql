-- Paul P Event Graph Schema (P-06)
-- Migration: 0007_event_graph.sql
-- Tables: event_graph_nodes, event_graph_edges, correlation_rules

-- ============================================================
-- EVENT GRAPH NODES - Entities in the correlation graph
-- ============================================================
CREATE TABLE event_graph_nodes (
  id TEXT PRIMARY KEY, -- same as canonical_events.id or auto-generated
  node_type TEXT NOT NULL CHECK(node_type IN (
    'event',        -- canonical event
    'topic',        -- topic/category cluster
    'data_source',  -- oracle/data feed
    'time_window'   -- resolution time window
  )),
  label TEXT NOT NULL,
  metadata TEXT, -- JSON for type-specific attributes

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_graph_nodes_type ON event_graph_nodes(node_type);

-- ============================================================
-- EVENT GRAPH EDGES - Relationships between nodes
-- ============================================================
CREATE TABLE event_graph_edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL REFERENCES event_graph_nodes(id),
  target_node_id TEXT NOT NULL REFERENCES event_graph_nodes(id),
  edge_type TEXT NOT NULL CHECK(edge_type IN (
    'belongs_to_event',    -- market -> event
    'tagged_with_topic',   -- event -> topic
    'resolved_by_source',  -- market -> data source
    'occurs_in_window',    -- event -> time window
    'correlated_with',     -- event <-> event (learned or declared)
    'same_series'          -- market <-> market (recurring)
  )),
  weight REAL DEFAULT 1.0, -- correlation strength for 'correlated_with' edges
  source TEXT CHECK(source IN ('declared', 'learned', 'human_approved')),

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_edges_source ON event_graph_edges(source_node_id);
CREATE INDEX idx_edges_target ON event_graph_edges(target_node_id);
CREATE INDEX idx_edges_type ON event_graph_edges(edge_type);

-- ============================================================
-- CORRELATION RULES - Human-approved correlation patterns
-- ============================================================
CREATE TABLE correlation_rules (
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL CHECK(rule_type IN (
    'same_underlying',        -- two markets resolve from same real-world event
    'same_data_source',       -- both resolved by same oracle/data feed
    'same_release_time',      -- both resolve at same data release (e.g., jobs report)
    'same_series',            -- both in same recurring series
    'causal_chain',           -- outcome of A materially affects probability of B
    'portfolio_concentration' -- both in same domain (e.g., all weather markets)
  )),
  description TEXT NOT NULL,
  market_selector TEXT NOT NULL, -- JSON: criteria for matching markets to this rule
  correlation_weight REAL NOT NULL DEFAULT 1.0, -- how strongly correlated (0-1)

  -- Review
  approved_by TEXT,
  approved_at TEXT,

  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_correlation_rules_type ON correlation_rules(rule_type);
CREATE INDEX idx_correlation_rules_active ON correlation_rules(is_active) WHERE is_active = 1;

-- ============================================================
-- CORRELATION CACHE - Precomputed correlation scores
-- ============================================================
CREATE TABLE correlation_cache (
  id TEXT PRIMARY KEY,
  market_a_id TEXT NOT NULL,
  market_b_id TEXT NOT NULL,
  correlation_score REAL NOT NULL, -- 0.0 to 1.0

  -- Source of correlation
  correlation_rules_applied TEXT, -- JSON array of rule IDs
  edge_path TEXT, -- JSON array of edge IDs in the graph path

  -- Validity
  computed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  is_valid INTEGER DEFAULT 1,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_correlation_cache_markets ON correlation_cache(market_a_id, market_b_id);
CREATE INDEX idx_correlation_cache_valid ON correlation_cache(is_valid) WHERE is_valid = 1;
