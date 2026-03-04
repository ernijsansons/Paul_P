/**
 * Paul P - Backtest Types
 * Core type definitions for the backtesting framework
 */

// ============================================================
// MARKET DATA TYPES
// ============================================================

export interface HistoricalMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  rulesText: string;
  category: string;
  seriesTicker: string;

  // Timing
  openTime: string;
  closeTime: string;
  settlementTime: string;

  // Resolution
  status: 'finalized' | 'settled' | 'voided';
  result: 'yes' | 'no' | 'void' | null;

  // Final prices
  lastPrice: number;
  volume: number;
  openInterest: number;
}

export interface Candlestick {
  endPeriodTs: number; // Unix timestamp
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
  openInterest: number;
  yesBid: number;
  yesAsk: number;
}

export interface MarketSnapshot {
  timestamp: string;
  ticker: string;
  yesBid: number;
  yesAsk: number;
  midPrice: number;
  spread: number;
  volume24h: number;
  depth: number;
}

// ============================================================
// STRATEGY TYPES
// ============================================================

export interface StrategyConfig {
  strategyId: string;
  version: string;
  name: string;

  // Entry criteria
  minProbability?: number;
  maxProbability?: number;
  minEdge?: number;
  maxSpread?: number;
  minLiquidity?: number;

  // Sizing
  kellyFraction: number;
  maxPositionPct: number;

  // Risk limits
  maxDailyLossPct: number;
  maxDrawdownPct: number;
}

export interface Signal {
  signalId: string;
  strategyId: string;
  timestamp: string;
  ticker: string;

  // Direction
  side: 'yes' | 'no';
  action: 'buy' | 'sell';

  // Pricing
  entryPrice: number;
  expectedEdge: number;
  confidence: number;

  // Sizing
  suggestedSize: number; // In contracts
  kellySize: number;
}

// ============================================================
// EXECUTION TYPES
// ============================================================

export interface SimulatedOrder {
  orderId: string;
  signalId: string;
  timestamp: string;
  ticker: string;

  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  orderType: 'limit' | 'market';

  requestedPrice: number;
  requestedSize: number;

  // Fill result
  filled: boolean;
  fillPrice: number | null;
  fillSize: number | null;
  fillTimestamp: string | null;

  // Slippage
  expectedSlippage: number;
  realizedSlippage: number | null;

  // Fees
  fees: number;
}

export interface Position {
  positionId: string;
  ticker: string;
  side: 'yes' | 'no';

  // Entry
  entryTimestamp: string;
  entryPrice: number;
  size: number;
  cost: number;

  // Exit (if closed)
  exitTimestamp: string | null;
  exitPrice: number | null;
  exitReason: 'resolution' | 'stop_loss' | 'take_profit' | 'time_exit' | 'manual' | null;

  // P&L
  realizedPnl: number | null;
  unrealizedPnl: number | null;

  // CLV
  closingLinePrice: number | null;
  clv: number | null;
}

// ============================================================
// FILL SIMULATION TYPES
// ============================================================

export interface FillModel {
  name: string;

  // Parameters
  baseSlippageBps: number;
  sizeImpactFactor: number; // slippage increases with size
  spreadImpactFactor: number;
  vpinImpactFactor: number;

  // Fill probability
  limitFillProbability: number; // Base probability for limit orders
  marketFillProbability: number; // Should be ~1.0

  // Partial fills
  allowPartialFills: boolean;
  partialFillDistribution: 'uniform' | 'exponential';
}

export const DEFAULT_FILL_MODEL: FillModel = {
  name: 'conservative',
  baseSlippageBps: 100, // 1%
  sizeImpactFactor: 0.5,
  spreadImpactFactor: 0.3,
  vpinImpactFactor: 0.2,
  limitFillProbability: 0.5,
  marketFillProbability: 0.95,
  allowPartialFills: false,
  partialFillDistribution: 'uniform',
};

// ============================================================
// BACKTEST CONFIGURATION
// ============================================================

export interface BacktestConfig {
  // Data
  dataPath: string;
  startDate: string;
  endDate: string;

  // Strategy
  strategyConfig: StrategyConfig;

  // Execution
  fillModel: FillModel;
  initialCapital: number;

  // Walk-forward
  walkForward: {
    enabled: boolean;
    trainPct: number; // e.g., 0.6 = 60%
    valPct: number; // e.g., 0.2 = 20%
    oosPct: number; // e.g., 0.2 = 20%
    rollingWindows: number; // Number of OOS periods
  };

  // Fees
  feePerContract: number; // Kalshi: ~$0.0107 per contract
}

export const DEFAULT_BACKTEST_CONFIG: Partial<BacktestConfig> = {
  fillModel: DEFAULT_FILL_MODEL,
  initialCapital: 800,
  walkForward: {
    enabled: true,
    trainPct: 0.6,
    valPct: 0.2,
    oosPct: 0.2,
    rollingWindows: 5,
  },
  feePerContract: 0.0107,
};

// ============================================================
// RESULTS TYPES
// ============================================================

export interface BacktestMetrics {
  // Returns
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  sortinoRatio: number;

  // Risk
  maxDrawdown: number;
  maxDrawdownDuration: number; // Days
  volatility: number;

  // Trading
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;

  // CLV
  avgClv: number;
  clvPositiveRate: number;

  // Execution
  avgSlippage: number;
  totalFees: number;
  fillRate: number;

  // Confidence intervals (Wilson score for win rate, bootstrap for Sharpe)
  winRateCI: { lower: number; upper: number; confidence: number };
  sharpeCI: { lower: number; upper: number; confidence: number };
}

export interface BacktestResult {
  config: BacktestConfig;
  runId: string;
  startedAt: string;
  completedAt: string;

  // Data summary
  marketsAnalyzed: number;
  signalsGenerated: number;
  ordersExecuted: number;
  positionsClosed: number;

  // Metrics
  trainMetrics: BacktestMetrics | null;
  valMetrics: BacktestMetrics | null;
  oosMetrics: BacktestMetrics;

  // Per-period results (for walk-forward)
  walkForwardResults: WalkForwardPeriod[];

  // Detailed data
  positions: Position[];
  orders: SimulatedOrder[];
  equityCurve: EquityPoint[];
}

export interface WalkForwardPeriod {
  periodIndex: number;
  trainStart: string;
  trainEnd: string;
  valStart: string;
  valEnd: string;
  oosStart: string;
  oosEnd: string;

  trainMetrics: BacktestMetrics;
  valMetrics: BacktestMetrics;
  oosMetrics: BacktestMetrics;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
  cash: number;
  positionValue: number;
  drawdown: number;
}
