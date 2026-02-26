/**
 * Paul P - Robust Closing Line Estimation (P-17)
 *
 * CL_robust = TWAP(midpoints, window) weighted by min(depth_yes, depth_no)
 *
 * Quality Score (0.0 to 1.0):
 *   - Depth during CL window: 40%
 *   - Spread during CL window: 30%
 *   - Sample count in window: 20%
 *   - Price stability (std dev): 10%
 *
 * CLV is valid only when quality_score >= 0.5
 */

import type { MarketClass } from './clv';
import { getClosingLineWindow } from './clv';

/**
 * A single price observation within the closing line window
 */
export interface PriceObservation {
  timestamp: number;        // Unix timestamp ms
  midPrice: number;         // Midpoint price (0-1)
  depthYes: number;         // Depth on YES side in USD
  depthNo: number;          // Depth on NO side in USD
  spread: number;           // Spread (0-1)
}

/**
 * Result of closing line estimation
 */
export interface ClosingLineResult {
  closingLinePrice: number;    // The robust CL estimate
  qualityScore: number;        // 0.0 to 1.0
  isValid: boolean;            // qualityScore >= 0.5
  method: string;              // Description of CL method used

  // Component scores
  depthScore: number;          // 0-1
  spreadScore: number;         // 0-1
  sampleScore: number;         // 0-1
  stabilityScore: number;      // 0-1

  // Statistics
  observationCount: number;
  validObservationCount: number;
  avgDepth: number;
  avgSpread: number;
  priceStdDev: number;
}

/**
 * Thresholds for quality scoring
 */
const QUALITY_THRESHOLDS = {
  // Depth thresholds (USD)
  depth: {
    excellent: 500,   // > $500 = 1.0
    good: 100,        // $100-500 = 0.7
    acceptable: 50,   // $50-100 = 0.4
    poor: 0,          // < $50 = 0.0
  },
  // Spread thresholds
  spread: {
    excellent: 0.03,  // < 3% = 1.0
    good: 0.08,       // 3-8% = 0.7
    acceptable: 0.15, // 8-15% = 0.3
    poor: 1.0,        // > 15% = 0.0
  },
  // Sample count thresholds
  samples: {
    excellent: 10,    // > 10 = 1.0
    good: 5,          // 5-10 = 0.6
    poor: 0,          // < 5 = 0.2
  },
  // Price stability (std dev)
  stability: {
    excellent: 0.02,  // < 2% = 1.0
    good: 0.05,       // 2-5% = 0.5
    poor: 1.0,        // > 5% = 0.2
  },
};

/**
 * Compute depth quality score
 */
function scoreDepth(avgDepth: number): number {
  if (avgDepth > QUALITY_THRESHOLDS.depth.excellent) return 1.0;
  if (avgDepth > QUALITY_THRESHOLDS.depth.good) return 0.7;
  if (avgDepth > QUALITY_THRESHOLDS.depth.acceptable) return 0.4;
  return 0.0;
}

/**
 * Compute spread quality score
 */
function scoreSpread(avgSpread: number): number {
  if (avgSpread < QUALITY_THRESHOLDS.spread.excellent) return 1.0;
  if (avgSpread < QUALITY_THRESHOLDS.spread.good) return 0.7;
  if (avgSpread < QUALITY_THRESHOLDS.spread.acceptable) return 0.3;
  return 0.0;
}

/**
 * Compute sample count score
 */
function scoreSamples(count: number): number {
  if (count > QUALITY_THRESHOLDS.samples.excellent) return 1.0;
  if (count >= QUALITY_THRESHOLDS.samples.good) return 0.6;
  return 0.2;
}

/**
 * Compute price stability score
 */
function scoreStability(stdDev: number): number {
  if (stdDev < QUALITY_THRESHOLDS.stability.excellent) return 1.0;
  if (stdDev < QUALITY_THRESHOLDS.stability.good) return 0.5;
  return 0.2;
}

/**
 * Estimate robust closing line from price observations
 *
 * TWAP weighted by min(depth_yes, depth_no)
 * Filters out observations with depth < $50 or spread > 0.15
 */
export function estimateClosingLine(
  observations: PriceObservation[],
  marketClass: MarketClass,
  resolutionTime: number
): ClosingLineResult {
  const windowConfig = getClosingLineWindow(marketClass);

  // For 'last-trade' (sports), use the last observation
  if (windowConfig.windowMs === 0) {
    return estimateLastTrade(observations, windowConfig.description);
  }

  // Filter observations within window and meeting quality thresholds
  const windowStart = resolutionTime - windowConfig.windowMs;

  const validObservations = observations.filter((obs) => {
    // Must be within window
    if (obs.timestamp < windowStart || obs.timestamp > resolutionTime) {
      return false;
    }

    // Must meet minimum depth ($50)
    const minDepth = Math.min(obs.depthYes, obs.depthNo);
    if (minDepth < 50) {
      return false;
    }

    // Must meet maximum spread (15%)
    if (obs.spread > 0.15) {
      return false;
    }

    return true;
  });

  if (validObservations.length === 0) {
    return createInvalidResult(observations.length, windowConfig.description);
  }

  // Compute depth-weighted TWAP
  let weightedSum = 0;
  let totalWeight = 0;

  for (const obs of validObservations) {
    const weight = Math.min(obs.depthYes, obs.depthNo);
    weightedSum += obs.midPrice * weight;
    totalWeight += weight;
  }

  const closingLinePrice = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

  // Compute statistics for quality scoring
  const depths = validObservations.map((o) => Math.min(o.depthYes, o.depthNo));
  const spreads = validObservations.map((o) => o.spread);
  const prices = validObservations.map((o) => o.midPrice);

  const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;
  const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;

  const meanPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const priceVariance = prices.reduce((sum, p) => sum + Math.pow(p - meanPrice, 2), 0) / prices.length;
  const priceStdDev = Math.sqrt(priceVariance);

  // Compute component scores
  const depthScore = scoreDepth(avgDepth);
  const spreadScore = scoreSpread(avgSpread);
  const sampleScore = scoreSamples(validObservations.length);
  const stabilityScore = scoreStability(priceStdDev);

  // Weighted quality score (P-17 weights)
  const qualityScore =
    depthScore * 0.4 +
    spreadScore * 0.3 +
    sampleScore * 0.2 +
    stabilityScore * 0.1;

  return {
    closingLinePrice,
    qualityScore,
    isValid: qualityScore >= 0.5,
    method: windowConfig.description,

    depthScore,
    spreadScore,
    sampleScore,
    stabilityScore,

    observationCount: observations.length,
    validObservationCount: validObservations.length,
    avgDepth,
    avgSpread,
    priceStdDev,
  };
}

/**
 * Estimate closing line for sports markets (last trade)
 */
function estimateLastTrade(observations: PriceObservation[], method: string): ClosingLineResult {
  if (observations.length === 0) {
    return createInvalidResult(0, method);
  }

  // Sort by timestamp descending and take the last one
  const sorted = [...observations].sort((a, b) => b.timestamp - a.timestamp);
  const lastObs = sorted[0]!;

  const minDepth = Math.min(lastObs.depthYes, lastObs.depthNo);

  const depthScore = scoreDepth(minDepth);
  const spreadScore = scoreSpread(lastObs.spread);
  const sampleScore = 0.6; // Single sample = 0.6
  const stabilityScore = 1.0; // N/A for single sample

  const qualityScore =
    depthScore * 0.4 +
    spreadScore * 0.3 +
    sampleScore * 0.2 +
    stabilityScore * 0.1;

  return {
    closingLinePrice: lastObs.midPrice,
    qualityScore,
    isValid: qualityScore >= 0.5,
    method,

    depthScore,
    spreadScore,
    sampleScore,
    stabilityScore,

    observationCount: observations.length,
    validObservationCount: 1,
    avgDepth: minDepth,
    avgSpread: lastObs.spread,
    priceStdDev: 0,
  };
}

/**
 * Create an invalid result when no valid observations available
 */
function createInvalidResult(observationCount: number, method: string): ClosingLineResult {
  return {
    closingLinePrice: 0.5, // Default to 50/50
    qualityScore: 0,
    isValid: false,
    method,

    depthScore: 0,
    spreadScore: 0,
    sampleScore: 0,
    stabilityScore: 0,

    observationCount,
    validObservationCount: 0,
    avgDepth: 0,
    avgSpread: 0,
    priceStdDev: 0,
  };
}

/**
 * Sample midpoints at regular intervals for TWAP calculation
 * Returns observations at 15-second intervals as specified in P-17
 */
export function sampleMidpoints(
  priceHistory: Array<{ timestamp: number; midPrice: number; depthYes: number; depthNo: number; spread: number }>,
  windowStart: number,
  windowEnd: number,
  intervalMs = 15000 // 15 seconds
): PriceObservation[] {
  const observations: PriceObservation[] = [];

  // Sort by timestamp
  const sorted = [...priceHistory].sort((a, b) => a.timestamp - b.timestamp);

  // Sample at regular intervals
  for (let t = windowStart; t <= windowEnd; t += intervalMs) {
    // Find the closest observation at or before this timestamp
    let closestIdx = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i]!.timestamp <= t) {
        closestIdx = i;
        break;
      }
    }

    if (closestIdx >= 0) {
      const obs = sorted[closestIdx]!;
      observations.push({
        timestamp: t,
        midPrice: obs.midPrice,
        depthYes: obs.depthYes,
        depthNo: obs.depthNo,
        spread: obs.spread,
      });
    }
  }

  return observations;
}
