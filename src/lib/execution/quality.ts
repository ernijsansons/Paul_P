/**
 * Paul P - Execution Quality Tracking (Phase B)
 *
 * Tracks execution quality metrics:
 * - Expected vs realized slippage per order
 * - Execution grades (EXCELLENT, GOOD, ACCEPTABLE, POOR)
 * - Slippage breakdown by market depth, order size, VPIN, time-of-day
 * - Kill switch evaluation for I18 invariant
 */

// ============================================================
// TYPES
// ============================================================

export type ExecutionGrade = 'EXCELLENT' | 'GOOD' | 'ACCEPTABLE' | 'POOR';

export interface ExecutionQualityReport {
  orderId: string;
  ticker: string;
  side: 'yes' | 'no';
  limitPrice: number;
  expectedSlippage: number; // Predicted slippage (cents)
  realizedSlippage: number; // Actual slippage (cents)
  slippageRatio: number; // realized / expected
  executionGrade: ExecutionGrade;
  edgePercent: number; // Expected edge (%+)
  slippageVsEdgeRatio: number; // slippage / edge
  fillPrice: number;
  orderSize: number;
  orderNotional: number;
  marketDepth?: number; // Market depth at submission
  marketSpread?: number; // Market spread at submission
  vpin?: number; // VPIN at submission
  timeOfDay?: string; // Time of execution
  timestamp: string;
}

export interface ExecutionMetrics {
  totalOrders: number;
  excellentCount: number;
  goodCount: number;
  acceptableCount: number;
  poorCount: number;
  averageSlippage: number;
  averageSlippageRatio: number;
  averageGradeScore: number; // 4=excellent, 3=good, 2=acceptable, 1=poor
  killSwitchTriggered: boolean;
  killSwitchCount: number;
}

// ============================================================
// EXECUTION GRADE LOGIC
// ============================================================

/**
 * Determine execution grade based on realized vs expected slippage
 * Grades reflect how well we executed vs market conditions
 */
export function computeExecutionGrade(
  slippageRatio: number, // realized / expected
  _slippageVsEdgeRatio: number  // slippage / edge (used for documentation)
): ExecutionGrade {
  // If slippage is less than expected, we got lucky (EXCELLENT)
  if (slippageRatio < 0.5) {
    return 'EXCELLENT';
  }

  // If slippage is 50-100% of expected, we did well (GOOD)
  if (slippageRatio < 1.0) {
    return 'GOOD';
  }

  // If slippage is 100-150% of expected, acceptable (ACCEPTABLE)
  if (slippageRatio < 1.5) {
    return 'ACCEPTABLE';
  }

  // If slippage exceeds expected by >150%, poor execution (POOR)
  return 'POOR';
}

/**
 * Compute expected slippage based on market conditions
 * Used as baseline for comparison
 */
export function computeExpectedSlippage(
  marketSpread: number, // Bid-ask spread in cents
  _orderSize: number, // Order size in contracts (size impacts depth, but not direct formula)
  orderNotional: number, // Order notional in cents
  vpin: number, // VPIN (0-1)
  marketDepth: number // Available liquidity
): number {
  // Base slippage: fraction of spread
  const spreadSlippage = marketSpread * 0.25; // We should cross 25% of spread on average

  // Impact slippage: order size relative to depth
  const impactRatio = Math.min(1, orderNotional / (marketDepth || 1000));
  const impactSlippage = marketSpread * impactRatio * 0.5; // Up to 50% more spread from impact

  // Toxicity adjustment: VPIN indicates order flow toxicity
  const toxicityMultiplier = 1 + vpin; // Higher VPIN = worse execution
  const toxicitySlippage = (spreadSlippage + impactSlippage) * (toxicityMultiplier - 1) * 0.25;

  return Math.max(0.1, spreadSlippage + impactSlippage + toxicitySlippage);
}

/**
 * Create execution quality report after fill
 */
export function createExecutionQualityReport(
  orderId: string,
  ticker: string,
  side: 'yes' | 'no',
  limitPrice: number,
  fillPrice: number,
  orderSize: number,
  edgePercent: number, // Expected edge as %
  marketSpread: number,
  vpin: number,
  marketDepth: number,
  timeOfDay?: string
): ExecutionQualityReport {
  // Calculate realized slippage
  const realizedSlippage = Math.abs(fillPrice - limitPrice);
  const orderNotional = orderSize * limitPrice;

  // Calculate expected slippage
  const expectedSlippage = computeExpectedSlippage(
    marketSpread,
    orderSize,
    orderNotional,
    vpin,
    marketDepth
  );

  // Compute ratios
  const slippageRatio = expectedSlippage > 0 ? realizedSlippage / expectedSlippage : 0;
  const slippageVsEdgeRatio = edgePercent > 0 ? (realizedSlippage / limitPrice / 100) / edgePercent : 0;

  // Compute grade
  const executionGrade = computeExecutionGrade(slippageRatio, slippageVsEdgeRatio);

  return {
    orderId,
    ticker,
    side,
    limitPrice,
    expectedSlippage,
    realizedSlippage,
    slippageRatio,
    executionGrade,
    edgePercent,
    slippageVsEdgeRatio,
    fillPrice,
    orderSize,
    orderNotional,
    marketDepth,
    marketSpread,
    vpin,
    timeOfDay,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// METRICS COMPUTATION
// ============================================================

/**
 * Aggregate execution metrics from multiple reports
 */
export function computeExecutionMetrics(reports: ExecutionQualityReport[]): ExecutionMetrics {
  if (reports.length === 0) {
    return {
      totalOrders: 0,
      excellentCount: 0,
      goodCount: 0,
      acceptableCount: 0,
      poorCount: 0,
      averageSlippage: 0,
      averageSlippageRatio: 0,
      averageGradeScore: 0,
      killSwitchTriggered: false,
      killSwitchCount: 0,
    };
  }

  let excellentCount = 0;
  let goodCount = 0;
  let acceptableCount = 0;
  let poorCount = 0;
  let killSwitchCount = 0;
  let totalSlippage = 0;
  let totalSlippageRatio = 0;

  for (const report of reports) {
    // Count grades
    switch (report.executionGrade) {
      case 'EXCELLENT':
        excellentCount++;
        break;
      case 'GOOD':
        goodCount++;
        break;
      case 'ACCEPTABLE':
        acceptableCount++;
        break;
      case 'POOR':
        poorCount++;
        break;
    }

    // Check kill switch (I18): if slippage > 50% of edge
    if (report.slippageVsEdgeRatio > 0.5) {
      killSwitchCount++;
    }

    totalSlippage += report.realizedSlippage;
    totalSlippageRatio += report.slippageRatio;
  }

  // Compute average grade score (4=excellent, 3=good, 2=acceptable, 1=poor)
  const gradeScore =
    excellentCount * 4 + goodCount * 3 + acceptableCount * 2 + poorCount * 1;
  const averageGradeScore = gradeScore / reports.length;

  const killSwitchTriggered = killSwitchCount > 0;

  return {
    totalOrders: reports.length,
    excellentCount,
    goodCount,
    acceptableCount,
    poorCount,
    averageSlippage: totalSlippage / reports.length,
    averageSlippageRatio: totalSlippageRatio / reports.length,
    averageGradeScore,
    killSwitchTriggered,
    killSwitchCount,
  };
}

/**
 * Generate execution quality report summary (for dashboards/alerts)
 */
export function formatExecutionSummary(metrics: ExecutionMetrics): string {
  const gradeDistribution = `${metrics.excellentCount}E/${metrics.goodCount}G/${metrics.acceptableCount}A/${metrics.poorCount}P`;
  const avgSlippageCents = (metrics.averageSlippage * 100).toFixed(1);
  const avgGrade = metrics.averageGradeScore.toFixed(2);
  const killWarning = metrics.killSwitchTriggered ? ` [KILL SWITCH: ${metrics.killSwitchCount} orders]` : '';

  return (
    `Execution Quality: ${gradeDistribution} | ` +
    `Avg Slippage: ${avgSlippageCents} ¢ | ` +
    `Grade Score: ${avgGrade}/4.0` +
    killWarning
  );
}
