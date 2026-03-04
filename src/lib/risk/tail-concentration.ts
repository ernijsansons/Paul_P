/**
 * Tail Concentration Risk Module
 *
 * Provides Herfindahl-Hirschman Index (HHI) calculation for portfolio
 * concentration risk assessment. Used by RiskGovernorAgent for tail
 * position monitoring.
 *
 * HHI = sum of squared position percentages
 * - HHI = 1.0 means single position (maximum concentration)
 * - HHI = 0.5 means two equal positions
 * - HHI < 0.3 is compliant (well-diversified)
 */

/**
 * Position data required for tail concentration calculation
 */
export interface TailPosition {
  marketId: string;
  size: number;
  currentPrice?: number;
  side?: 'YES' | 'NO';
}

/**
 * Result of tail concentration analysis
 */
export interface TailConcentrationResult {
  isCompliant: boolean;
  herfindahl: number;
  maxPositionPct: number;
  tailPositions: TailPosition[];
  totalTailValue: number;
}

/**
 * Filter positions that are in tail territory (extreme prices)
 * Tail positions are those with price < 0.2 or price > 0.8
 */
export function filterTailPositions(positions: TailPosition[]): TailPosition[] {
  return positions.filter(p => {
    if (p.currentPrice === undefined) return false;
    return p.currentPrice < 0.2 || p.currentPrice > 0.8;
  });
}

/**
 * Calculate Herfindahl-Hirschman Index for a set of positions
 *
 * @param positions - Array of positions with size values
 * @returns HHI value between 0 and 1
 */
export function calculateHerfindahl(positions: TailPosition[]): number {
  if (positions.length === 0) return 0;

  const totalValue = positions.reduce((sum, p) => sum + p.size, 0);
  if (totalValue === 0) return 0;

  return positions.reduce((sum, p) => {
    const pct = p.size / totalValue;
    return sum + pct * pct;
  }, 0);
}

/**
 * Calculate the maximum position percentage in the portfolio
 */
export function calculateMaxPositionPct(positions: TailPosition[]): number {
  if (positions.length === 0) return 0;

  const totalValue = positions.reduce((sum, p) => sum + p.size, 0);
  if (totalValue === 0) return 0;

  return Math.max(...positions.map(p => (p.size / totalValue) * 100));
}

/**
 * Check tail concentration compliance
 *
 * @param positions - Array of portfolio positions
 * @param herfindahlThreshold - Maximum allowed HHI (default 0.3)
 * @returns Compliance result with HHI metrics
 */
export function checkTailConcentration(
  positions: TailPosition[],
  herfindahlThreshold = 0.3
): TailConcentrationResult {
  // Filter for tail positions (extreme prices)
  const tailPositions = positions.filter(p => {
    // If no price, include in calculation (allows testing without price)
    if (p.currentPrice === undefined) return p.size > 0;
    return (p.currentPrice < 0.2 || p.currentPrice > 0.8) && p.size > 0;
  });

  if (tailPositions.length === 0) {
    return {
      isCompliant: true,
      herfindahl: 0,
      maxPositionPct: 0,
      tailPositions: [],
      totalTailValue: 0,
    };
  }

  const totalTailValue = tailPositions.reduce((sum, p) => sum + p.size, 0);
  const herfindahl = calculateHerfindahl(tailPositions);
  const maxPositionPct = calculateMaxPositionPct(tailPositions);
  const isCompliant = herfindahl < herfindahlThreshold;

  return {
    isCompliant,
    herfindahl,
    maxPositionPct,
    tailPositions,
    totalTailValue,
  };
}

/**
 * Create SQL parameters for tail_concentration_snapshots insert
 */
export function createSnapshotParams(
  result: TailConcentrationResult
): [string, number, number, number, number, number] {
  return [
    new Date().toISOString(),
    result.totalTailValue,
    result.tailPositions.length,
    result.herfindahl,
    result.maxPositionPct,
    result.isCompliant ? 1 : 0,
  ];
}
