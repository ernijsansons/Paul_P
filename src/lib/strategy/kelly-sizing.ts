/**
 * Paul P - Kelly Criterion Sizing (P-10)
 *
 * Empirical Kelly sizing with Monte Carlo CV adjustment.
 * For prediction markets with binary outcomes.
 *
 * Kelly Formula: f* = (bp - q) / b
 * where:
 *   b = odds received on the bet (decimal odds - 1)
 *   p = probability of winning
 *   q = probability of losing (1 - p)
 *
 * For binary markets at price P:
 *   - If betting YES at price P: b = (1-P)/P, we win 1-P for risking P
 *   - If betting NO at price P: b = P/(1-P), we win P for risking 1-P
 */

export interface KellyInput {
  fairProbability: number; // Our estimated true probability (0-1)
  marketPrice: number; // Current market price (0-1)
  side: 'YES' | 'NO';
  bankroll: number; // Total capital available
  maxPositionPct?: number; // Max position as % of bankroll (default 5%)
}

export interface KellyResult {
  kellyFraction: number; // Raw Kelly fraction (can be negative if no edge)
  adjustedFraction: number; // After CV adjustment and caps
  positionSize: number; // Dollar amount to bet
  expectedEdge: number; // Expected edge in cents
  hasEdge: boolean;
  confidenceAdjustment: number; // CV adjustment factor (0-1)
}

export interface MonteCarloConfig {
  simulations: number; // Number of simulations (default 10000)
  historicalReturns?: number[]; // Past returns for CV estimation
  assumedCV?: number; // Assumed coefficient of variation if no history
}

const DEFAULT_MONTE_CARLO: MonteCarloConfig = {
  simulations: 10000,
  assumedCV: 0.3, // 30% CV if no historical data
};

/**
 * Compute raw Kelly fraction for binary market
 */
export function computeRawKelly(
  fairProbability: number,
  marketPrice: number,
  side: 'YES' | 'NO'
): number {
  // Validate inputs
  if (fairProbability <= 0 || fairProbability >= 1) return 0;
  if (marketPrice <= 0 || marketPrice >= 1) return 0;

  let p: number; // Probability of winning the bet
  let b: number; // Decimal odds - 1

  if (side === 'YES') {
    // Betting YES: we think fair prob > market price
    p = fairProbability;
    // If we buy YES at price P, we risk P to win (1-P)
    // Decimal odds = 1/P, so b = 1/P - 1 = (1-P)/P
    b = (1 - marketPrice) / marketPrice;
  } else {
    // Betting NO: we think fair prob < market price
    // Equivalent to betting on complement
    p = 1 - fairProbability;
    // If we buy NO at price (1-P), we risk (1-P) to win P
    // Decimal odds = 1/(1-P), so b = P/(1-P)
    b = marketPrice / (1 - marketPrice);
  }

  const q = 1 - p;

  // Kelly formula: f* = (bp - q) / b
  const kelly = (b * p - q) / b;

  return kelly;
}

/**
 * Compute coefficient of variation from historical returns
 */
export function computeCV(returns: number[]): number {
  if (returns.length < 5) return 0.3; // Default CV

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  if (Math.abs(mean) < 0.0001) return 0.3; // Avoid division by zero

  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  return stdDev / Math.abs(mean);
}

/**
 * Monte Carlo adjustment for Kelly sizing
 * Reduces Kelly fraction based on estimation uncertainty
 */
export function monteCarloAdjustment(
  rawKelly: number,
  config: MonteCarloConfig = DEFAULT_MONTE_CARLO
): number {
  const cv = config.historicalReturns
    ? computeCV(config.historicalReturns)
    : config.assumedCV ?? 0.3;

  // Half-Kelly adjustment is common; we use CV-based adjustment
  // Higher CV = more uncertainty = more conservative sizing
  // Adjustment factor: 1 / (1 + CV^2)
  const adjustmentFactor = 1 / (1 + cv * cv);

  return rawKelly * adjustmentFactor;
}

/**
 * Full Kelly sizing calculation with Monte Carlo adjustment
 */
export function computeKellySize(
  input: KellyInput,
  config: MonteCarloConfig = DEFAULT_MONTE_CARLO
): KellyResult {
  const { fairProbability, marketPrice, side, bankroll, maxPositionPct = 5 } = input;

  // Compute raw Kelly
  const kellyFraction = computeRawKelly(fairProbability, marketPrice, side);

  // Check if we have edge
  const hasEdge = kellyFraction > 0;

  if (!hasEdge) {
    return {
      kellyFraction,
      adjustedFraction: 0,
      positionSize: 0,
      expectedEdge: 0,
      hasEdge: false,
      confidenceAdjustment: 0,
    };
  }

  // Compute CV adjustment
  const cv = config.historicalReturns
    ? computeCV(config.historicalReturns)
    : config.assumedCV ?? 0.3;
  const confidenceAdjustment = 1 / (1 + cv * cv);

  // Apply Monte Carlo adjustment
  let adjustedFraction = kellyFraction * confidenceAdjustment;

  // Apply max position cap
  const maxFraction = maxPositionPct / 100;
  adjustedFraction = Math.min(adjustedFraction, maxFraction);

  // Compute position size
  const positionSize = adjustedFraction * bankroll;

  // Compute expected edge in cents
  // Edge = fair probability - market price (for YES side)
  const expectedEdge = side === 'YES'
    ? (fairProbability - marketPrice) * 100
    : (marketPrice - fairProbability) * 100;

  return {
    kellyFraction,
    adjustedFraction,
    positionSize,
    expectedEdge,
    hasEdge,
    confidenceAdjustment,
  };
}

/**
 * Batch Kelly sizing for portfolio
 * Ensures total allocation doesn't exceed limits
 */
export function batchKellySizing(
  opportunities: Array<{
    id: string;
    fairProbability: number;
    marketPrice: number;
    side: 'YES' | 'NO';
  }>,
  bankroll: number,
  config: {
    maxTotalAllocation?: number; // Max % of bankroll to deploy (default 50%)
    maxSinglePosition?: number; // Max % per position (default 5%)
    monteCarloConfig?: MonteCarloConfig;
  } = {}
): Array<{ id: string; positionSize: number; kellyResult: KellyResult }> {
  const {
    maxTotalAllocation = 50,
    maxSinglePosition = 5,
    monteCarloConfig = DEFAULT_MONTE_CARLO,
  } = config;

  // Compute Kelly for each opportunity
  const results = opportunities.map(opp => ({
    id: opp.id,
    kellyResult: computeKellySize(
      {
        fairProbability: opp.fairProbability,
        marketPrice: opp.marketPrice,
        side: opp.side,
        bankroll,
        maxPositionPct: maxSinglePosition,
      },
      monteCarloConfig
    ),
  }));

  // Filter to only opportunities with edge
  const withEdge = results.filter(r => r.kellyResult.hasEdge);

  // Calculate total allocation
  const totalAllocation = withEdge.reduce((sum, r) => sum + r.kellyResult.adjustedFraction, 0);

  // Scale down if exceeds max total allocation
  const maxFraction = maxTotalAllocation / 100;
  const scaleFactor = totalAllocation > maxFraction ? maxFraction / totalAllocation : 1;

  return withEdge.map(r => ({
    id: r.id,
    positionSize: r.kellyResult.positionSize * scaleFactor,
    kellyResult: {
      ...r.kellyResult,
      adjustedFraction: r.kellyResult.adjustedFraction * scaleFactor,
      positionSize: r.kellyResult.positionSize * scaleFactor,
    },
  }));
}
