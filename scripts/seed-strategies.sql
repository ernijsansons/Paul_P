-- Paul P Strategy Seed Data
-- Initializes bonding and weather strategies for paper trading

-- Insert bonding-barbell strategy
INSERT OR REPLACE INTO strategies (
  id,
  name,
  strategy_type,
  spec_version,
  spec_hash,
  config_json,
  max_capital_allocation_usd,
  current_allocation_usd,
  max_position_pct,
  status,
  model_valid,
  created_at,
  updated_at
) VALUES (
  'bonding-barbell-v1',
  'Bonding Barbell Strategy',
  'bonding_barbell',
  '1.0.0',
  'placeholder_hash_bonding',
  '{
    "bond_min_probability": 0.93,
    "bond_max_probability": 0.99,
    "tail_max_price": 0.07,
    "min_liquidity_usd": 5000,
    "max_spread": 0.10,
    "kelly_fraction": 0.25,
    "bond_allocation_pct": 0.90,
    "tail_allocation_pct": 0.10
  }',
  500.0,
  0.0,
  0.03,
  'paper',
  1,
  datetime('now'),
  datetime('now')
);

-- Insert weather-series strategy
INSERT OR REPLACE INTO strategies (
  id,
  name,
  strategy_type,
  spec_version,
  spec_hash,
  config_json,
  max_capital_allocation_usd,
  current_allocation_usd,
  max_position_pct,
  status,
  model_valid,
  created_at,
  updated_at
) VALUES (
  'weather-econ-series-v1',
  'Weather & Economic Series Strategy',
  'weather_series',
  '1.0.0',
  'placeholder_hash_weather',
  '{
    "min_model_edge": 0.05,
    "min_confidence": 0.90,
    "min_hours_to_settlement": 24,
    "max_position_pct": 0.02,
    "max_series_exposure_pct": 0.10
  }',
  300.0,
  0.0,
  0.02,
  'paper',
  1,
  datetime('now'),
  datetime('now')
);

-- Verify strategy_execution_mode entries exist
INSERT OR IGNORE INTO strategy_execution_mode (strategy, mode) VALUES ('bonding', 'PAPER');
INSERT OR IGNORE INTO strategy_execution_mode (strategy, mode) VALUES ('weather', 'PAPER');

-- Create initial portfolio snapshot
INSERT OR IGNORE INTO portfolio_snapshots (
  id,
  snapshot_at,
  total_equity_usd,
  total_cash_usd,
  total_position_value_usd,
  unrealized_pnl_usd,
  realized_pnl_day_usd,
  strategy_allocations,
  gross_exposure_usd,
  net_exposure_usd,
  max_single_position_pct,
  created_at
) VALUES (
  'initial-snapshot',
  datetime('now'),
  800.0,
  800.0,
  0.0,
  0.0,
  0.0,
  '{"bonding-barbell-v1": {"equity": 500, "pnl": 0, "positions": 0}, "weather-econ-series-v1": {"equity": 300, "pnl": 0, "positions": 0}}',
  0.0,
  0.0,
  0.0,
  datetime('now')
);

-- Note: circuit_breaker_state is managed by RiskGovernorAgent Durable Object
