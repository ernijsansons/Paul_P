/**
 * Paul P - Backtest Harness
 * Main entry point for running strategy backtests
 *
 * Run with: npx tsx scripts/backtest/harness.ts
 */

import {
  loadMarkets,
  loadCandlesticks,
  findLatestDataFiles,
  filterMarkets,
  generateSnapshots,
  computeClosingLine,
  summarizeData,
} from './data-loader';
import {
  simulateOrder,
  openPosition,
  closePositionAtResolution,
  initializeEquity,
  updateEquityAfterFill,
  updateEquityAfterClose,
  computeEquity,
} from './simulator';
import type {
  HistoricalMarket,
  Candlestick,
  BacktestConfig,
  BacktestResult,
  BacktestMetrics,
  Signal,
  Position,
  SimulatedOrder,
  EquityPoint,
  DEFAULT_BACKTEST_CONFIG,
  DEFAULT_FILL_MODEL,
  StrategyConfig,
} from './types';
import { writeFileSync } from 'fs';

// ============================================================
// STRATEGY IMPLEMENTATIONS
// ============================================================

/**
 * Simple bonding strategy: buy high-probability YES contracts
 *
 * Edge calculation: For binary markets, if we buy YES at yesAsk and
 * the market resolves YES with probability P, our expected profit is:
 * E[profit] = P * $1.00 - yesAsk = P - yesAsk
 *
 * For bonding, we use the market's closing result as ground truth.
 * The "edge" we compute at entry time is based on:
 * - probability estimate = midPrice (our best guess of true probability)
 * - BUT this is flawed since mid < ask by definition
 *
 * Alternative: Use the potential profit margin = 1.0 - yesAsk
 * For high-probability markets (>90%), this is the upside if YES wins.
 */
function bondingStrategy(
  market: HistoricalMarket,
  snapshots: ReturnType<typeof generateSnapshots>,
  config: StrategyConfig
): Signal | null {
  if (snapshots.length === 0) return null;

  // Use first snapshot as entry point
  const entrySnapshot = snapshots[0];

  // Check entry criteria
  const probability = entrySnapshot.midPrice;

  if (probability < (config.minProbability ?? 0.93)) return null;
  if (probability > (config.maxProbability ?? 0.99)) return null;
  if (entrySnapshot.spread > (config.maxSpread ?? 0.10)) return null;

  // Compute expected edge
  // For bonding strategy, edge = potential profit if YES wins = 1.0 - yesAsk
  // This is the return we capture on high-probability YES markets
  const potentialProfit = 1.0 - entrySnapshot.yesAsk;

  // Scale by our probability estimate to get expected edge
  const expectedEdge = probability * potentialProfit - (1 - probability) * entrySnapshot.yesAsk;
  if (expectedEdge < (config.minEdge ?? 0.02)) return null;

  // Compute Kelly sizing
  const winProb = probability;
  const winAmount = 1.0 - entrySnapshot.yesAsk; // Profit if wins
  const lossAmount = entrySnapshot.yesAsk; // Loss if loses
  const kellyFraction = (winProb * winAmount - (1 - winProb) * lossAmount) / winAmount;
  const adjustedKelly = Math.max(0, kellyFraction * config.kellyFraction);

  return {
    signalId: `bonding-${market.ticker}-${entrySnapshot.timestamp}`,
    strategyId: config.strategyId,
    timestamp: entrySnapshot.timestamp,
    ticker: market.ticker,
    side: 'yes',
    action: 'buy',
    entryPrice: entrySnapshot.yesAsk,
    expectedEdge,
    confidence: probability,
    suggestedSize: 10, // Fixed size for simplicity
    kellySize: adjustedKelly * 100, // Convert to contracts
  };
}

// ============================================================
// METRICS COMPUTATION
// ============================================================

function computeMetrics(
  positions: Position[],
  orders: SimulatedOrder[],
  equityCurve: EquityPoint[],
  initialCapital: number
): BacktestMetrics {
  const closedPositions = positions.filter((p) => p.exitTimestamp !== null);

  // Returns
  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialCapital;
  const totalReturn = (finalEquity - initialCapital) / initialCapital;

  // Win/loss
  const wins = closedPositions.filter((p) => (p.realizedPnl ?? 0) > 0);
  const losses = closedPositions.filter((p) => (p.realizedPnl ?? 0) < 0);
  const winRate = closedPositions.length > 0 ? wins.length / closedPositions.length : 0;

  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + (p.realizedPnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, p) => s + (p.realizedPnl ?? 0), 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  // Drawdown
  let maxEquity = initialCapital;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    maxEquity = Math.max(maxEquity, point.equity);
    const drawdown = (maxEquity - point.equity) / maxEquity;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  // CLV stats
  const validClvPositions = closedPositions.filter((p) => p.clv !== null);
  const avgClv = validClvPositions.length > 0
    ? validClvPositions.reduce((s, p) => s + (p.clv ?? 0), 0) / validClvPositions.length
    : 0;
  const clvPositiveRate = validClvPositions.length > 0
    ? validClvPositions.filter((p) => (p.clv ?? 0) > 0).length / validClvPositions.length
    : 0;

  // Slippage and fees
  const filledOrders = orders.filter((o) => o.filled);
  const avgSlippage = filledOrders.length > 0
    ? filledOrders.reduce((s, o) => s + (o.realizedSlippage ?? 0), 0) / filledOrders.length
    : 0;
  const totalFees = orders.reduce((s, o) => s + o.fees, 0);
  const fillRate = orders.length > 0 ? filledOrders.length / orders.length : 0;

  // Sharpe (simplified - using position returns)
  const returns = closedPositions.map((p) => (p.realizedPnl ?? 0) / (p.entryPrice * p.size));
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.map((r) => Math.pow(r - meanReturn, 2)).reduce((a, b) => a + b, 0) / (returns.length - 1))
    : 0;
  const sharpeRatio = stdReturn > 0 ? meanReturn / stdReturn : 0;

  // Confidence intervals (Wilson score for win rate)
  const n = closedPositions.length;
  const z = 1.96; // 95% CI
  const winRateLower = n > 0
    ? (winRate + z * z / (2 * n) - z * Math.sqrt((winRate * (1 - winRate) + z * z / (4 * n)) / n)) / (1 + z * z / n)
    : 0;
  const winRateUpper = n > 0
    ? (winRate + z * z / (2 * n) + z * Math.sqrt((winRate * (1 - winRate) + z * z / (4 * n)) / n)) / (1 + z * z / n)
    : 1;

  return {
    totalReturn,
    annualizedReturn: totalReturn * 365 / Math.max(1, getDaysBetween(equityCurve)),
    sharpeRatio,
    sortinoRatio: 0, // TODO: implement
    maxDrawdown,
    maxDrawdownDuration: 0, // TODO: implement
    volatility: stdReturn,
    totalTrades: closedPositions.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    avgClv,
    clvPositiveRate,
    avgSlippage,
    totalFees,
    fillRate,
    winRateCI: { lower: winRateLower, upper: winRateUpper, confidence: 0.95 },
    sharpeCI: { lower: sharpeRatio - 0.5, upper: sharpeRatio + 0.5, confidence: 0.95 }, // TODO: bootstrap
  };
}

function getDaysBetween(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 2) return 1;
  const start = new Date(equityCurve[0].timestamp).getTime();
  const end = new Date(equityCurve[equityCurve.length - 1].timestamp).getTime();
  return Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
}

// ============================================================
// BACKTEST ENGINE
// ============================================================

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const runId = `backtest-${Date.now()}`;
  const startedAt = new Date().toISOString();

  console.log('=' .repeat(60));
  console.log('PAUL P BACKTEST ENGINE');
  console.log('=' .repeat(60));
  console.log(`Run ID: ${runId}`);
  console.log(`Strategy: ${config.strategyConfig.name}`);
  console.log(`Initial Capital: $${config.initialCapital}`);
  console.log();

  // Load data
  console.log('📥 Loading data...');
  const files = findLatestDataFiles();
  if (!files) {
    throw new Error('No data files found');
  }

  const allMarkets = loadMarkets(files.marketsFile);
  const allCandlesticks = loadCandlesticks(files.candlesticksFile);

  // Filter markets with candlesticks
  const marketsWithData = allMarkets.filter((m) => allCandlesticks.has(m.ticker));
  console.log(`  Markets with candlestick data: ${marketsWithData.length}`);

  // Generate signals
  console.log('\n📊 Generating signals...');
  const signals: Signal[] = [];

  for (const market of marketsWithData) {
    const candles = allCandlesticks.get(market.ticker) || [];
    const snapshots = generateSnapshots(market, candles);

    const signal = bondingStrategy(market, snapshots, config.strategyConfig);
    if (signal) {
      signals.push(signal);
    }
  }
  console.log(`  Signals generated: ${signals.length}`);

  // Run simulation
  console.log('\n⚙️  Running simulation...');
  let equityState = initializeEquity(config.initialCapital, signals[0]?.timestamp || new Date().toISOString());
  const orders: SimulatedOrder[] = [];
  const positions: Position[] = [];
  const equityCurve: EquityPoint[] = [];

  for (const signal of signals) {
    const market = marketsWithData.find((m) => m.ticker === signal.ticker)!;
    const candles = allCandlesticks.get(signal.ticker) || [];
    const snapshots = generateSnapshots(market, candles);

    if (snapshots.length === 0) continue;

    const snapshot = snapshots[0];

    // Simulate order
    const order = simulateOrder(signal, snapshot, {
      fillModel: config.fillModel,
      feePerContract: config.feePerContract,
      currentTime: signal.timestamp,
    });
    orders.push(order);

    if (order.filled) {
      // Open position
      const position = openPosition(order);
      equityState = updateEquityAfterFill(equityState, order, position);

      // Close at resolution
      const closingLine = computeClosingLine(market, candles);
      const closedPosition = closePositionAtResolution(
        position,
        market.result as 'yes' | 'no',
        market.settlementTime,
        closingLine?.closingLinePrice
      );
      positions.push(closedPosition);
      equityState = updateEquityAfterClose(equityState, closedPosition);

      // Record equity
      equityCurve.push({
        timestamp: closedPosition.exitTimestamp!,
        equity: equityState.cash,
        cash: equityState.cash,
        positionValue: 0,
        drawdown: 0,
      });
    }
  }

  // Compute metrics
  console.log('\n📈 Computing metrics...');
  const oosMetrics = computeMetrics(positions, orders, equityCurve, config.initialCapital);

  const completedAt = new Date().toISOString();

  const result: BacktestResult = {
    config,
    runId,
    startedAt,
    completedAt,
    marketsAnalyzed: marketsWithData.length,
    signalsGenerated: signals.length,
    ordersExecuted: orders.filter((o) => o.filled).length,
    positionsClosed: positions.length,
    trainMetrics: null,
    valMetrics: null,
    oosMetrics,
    walkForwardResults: [],
    positions,
    orders,
    equityCurve,
  };

  // Print summary
  console.log('\n' + '=' .repeat(60));
  console.log('RESULTS');
  console.log('=' .repeat(60));
  console.log(`Total Return: ${(oosMetrics.totalReturn * 100).toFixed(2)}%`);
  console.log(`Win Rate: ${(oosMetrics.winRate * 100).toFixed(1)}% (${oosMetrics.winningTrades}/${oosMetrics.totalTrades})`);
  console.log(`  95% CI: [${(oosMetrics.winRateCI.lower * 100).toFixed(1)}%, ${(oosMetrics.winRateCI.upper * 100).toFixed(1)}%]`);
  console.log(`Sharpe Ratio: ${oosMetrics.sharpeRatio.toFixed(2)}`);
  console.log(`Max Drawdown: ${(oosMetrics.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`Avg CLV: ${(oosMetrics.avgClv * 100).toFixed(2)}¢`);
  console.log(`CLV Positive Rate: ${(oosMetrics.clvPositiveRate * 100).toFixed(1)}%`);
  console.log(`Fill Rate: ${(oosMetrics.fillRate * 100).toFixed(1)}%`);
  console.log(`Total Fees: $${oosMetrics.totalFees.toFixed(2)}`);

  return result;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Default bonding strategy config
  // Relaxed criteria for initial testing with limited data
  // NOTE: These parameters are intentionally loose for infrastructure testing
  const strategyConfig: StrategyConfig = {
    strategyId: 'bonding-v1',
    version: '1.0.0',
    name: 'Bonding Strategy',
    minProbability: 0.10, // Lowered significantly for testing
    maxProbability: 0.99,
    minEdge: -1.0, // Allow negative edges for infrastructure testing
    maxSpread: 0.80, // Very wide spread allowed for testing
    minLiquidity: 0,
    kellyFraction: 0.25,
    maxPositionPct: 0.05,
    maxDailyLossPct: 0.03,
    maxDrawdownPct: 0.15,
  };

  const config: BacktestConfig = {
    dataPath: './data/kalshi-historical',
    startDate: '2025-02-27',
    endDate: '2025-03-02',
    strategyConfig,
    fillModel: {
      name: 'conservative',
      baseSlippageBps: 100,
      sizeImpactFactor: 0.5,
      spreadImpactFactor: 0.3,
      vpinImpactFactor: 0.2,
      limitFillProbability: 0.5,
      marketFillProbability: 0.95,
      allowPartialFills: false,
      partialFillDistribution: 'uniform',
    },
    initialCapital: 800,
    walkForward: {
      enabled: false, // Disabled for initial test
      trainPct: 0.6,
      valPct: 0.2,
      oosPct: 0.2,
      rollingWindows: 5,
    },
    feePerContract: 0.0107,
  };

  try {
    const result = await runBacktest(config);

    // Save results
    const outputPath = `./data/backtest-results/result-${result.runId}.json`;
    const { mkdirSync, existsSync } = await import('fs');
    if (!existsSync('./data/backtest-results')) {
      mkdirSync('./data/backtest-results', { recursive: true });
    }
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 Results saved to ${outputPath}`);
  } catch (error) {
    console.error('Backtest failed:', error);
    process.exit(1);
  }
}

main();
