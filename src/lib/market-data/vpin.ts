/**
 * Paul P - VPIN Computation (P-25)
 *
 * Volume-Synchronized Probability of Informed Trading
 * Adapted for prediction markets.
 *
 * Formula:
 *   VPIN_bucket = |V_buy - V_sell| / (V_buy + V_sell)
 *   VPIN = rolling average over last 50 buckets
 *
 * Where:
 *   V_buy  = volume of trades at or above midpoint in bucket
 *   V_sell = volume of trades at or below midpoint in bucket
 *   Bucket = fixed-volume buckets ($1000 notional default)
 *
 * Thresholds:
 *   VPIN < 0.3: Normal flow
 *   VPIN 0.3-0.6: Elevated informed flow
 *   VPIN > 0.6: Toxic flow
 */

export interface Trade {
  price: number;
  volume: number;
  timestamp: number;
  side?: 'buy' | 'sell'; // Optional, will infer from midpoint if not provided
}

export interface VPINBucket {
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  vpin: number;
  startTime: number;
  endTime: number;
  tradeCount: number;
}

export interface VPINResult {
  currentVPIN: number;
  buckets: VPINBucket[];
  flowClassification: 'normal' | 'elevated' | 'toxic';
  edgeMultiplier: number; // 1.0 for normal, 1.5 for elevated, 0 for toxic (pause)
  shouldPause: boolean;
  lastUpdated: string;
}

export interface VPINConfig {
  bucketSize: number; // Notional volume per bucket (default $1000)
  rollingBuckets: number; // Number of buckets for rolling average (default 50)
  normalThreshold: number; // Below this = normal (default 0.3)
  elevatedThreshold: number; // Above this = toxic (default 0.6)
}

const DEFAULT_CONFIG: VPINConfig = {
  bucketSize: 1000,
  rollingBuckets: 50,
  normalThreshold: 0.3,
  elevatedThreshold: 0.6,
};

/**
 * Classify a trade as buy or sell based on midpoint
 * True VPIN requires trade-level buy/sell classification
 * We approximate from trade-vs-midpoint comparison
 */
function classifyTrade(trade: Trade, midpoint: number): 'buy' | 'sell' {
  if (trade.side) return trade.side;
  return trade.price >= midpoint ? 'buy' : 'sell';
}

/**
 * Compute VPIN for a single bucket
 */
function computeBucketVPIN(buyVolume: number, sellVolume: number): number {
  const total = buyVolume + sellVolume;
  if (total === 0) return 0;
  return Math.abs(buyVolume - sellVolume) / total;
}

/**
 * Create VPIN buckets from trades
 */
export function createVPINBuckets(
  trades: Trade[],
  midpoints: { timestamp: number; price: number }[],
  config: Partial<VPINConfig> = {}
): VPINBucket[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const buckets: VPINBucket[] = [];

  if (trades.length === 0) return buckets;

  // Sort trades by timestamp
  const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  // Create a function to get midpoint at a given time
  const sortedMidpoints = [...midpoints].sort((a, b) => a.timestamp - b.timestamp);
  const getMidpoint = (timestamp: number): number => {
    // Find the most recent midpoint before or at this timestamp
    let midpoint = sortedMidpoints[0]?.price ?? 0.5;
    for (const mp of sortedMidpoints) {
      if (mp.timestamp <= timestamp) {
        midpoint = mp.price;
      } else {
        break;
      }
    }
    return midpoint;
  };

  let currentBucket: VPINBucket = {
    buyVolume: 0,
    sellVolume: 0,
    totalVolume: 0,
    vpin: 0,
    startTime: sortedTrades[0]?.timestamp ?? 0,
    endTime: 0,
    tradeCount: 0,
  };

  for (const trade of sortedTrades) {
    const midpoint = getMidpoint(trade.timestamp);
    const side = classifyTrade(trade, midpoint);
    const notional = trade.volume * trade.price;

    if (currentBucket.totalVolume + notional > cfg.bucketSize && currentBucket.tradeCount > 0) {
      // Finalize current bucket
      currentBucket.vpin = computeBucketVPIN(currentBucket.buyVolume, currentBucket.sellVolume);
      buckets.push(currentBucket);

      // Start new bucket
      currentBucket = {
        buyVolume: 0,
        sellVolume: 0,
        totalVolume: 0,
        vpin: 0,
        startTime: trade.timestamp,
        endTime: 0,
        tradeCount: 0,
      };
    }

    // Add trade to current bucket
    if (side === 'buy') {
      currentBucket.buyVolume += notional;
    } else {
      currentBucket.sellVolume += notional;
    }
    currentBucket.totalVolume += notional;
    currentBucket.endTime = trade.timestamp;
    currentBucket.tradeCount++;
  }

  // Finalize last bucket if it has trades
  if (currentBucket.tradeCount > 0) {
    currentBucket.vpin = computeBucketVPIN(currentBucket.buyVolume, currentBucket.sellVolume);
    buckets.push(currentBucket);
  }

  return buckets;
}

/**
 * Compute rolling VPIN from buckets
 */
export function computeRollingVPIN(
  buckets: VPINBucket[],
  config: Partial<VPINConfig> = {}
): number {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (buckets.length === 0) return 0;

  // Take the last N buckets
  const relevantBuckets = buckets.slice(-cfg.rollingBuckets);

  // Compute weighted average (more recent buckets weighted higher)
  let weightedSum = 0;
  let weightSum = 0;

  for (let i = 0; i < relevantBuckets.length; i++) {
    const bucket = relevantBuckets[i];
    if (!bucket) continue;
    const weight = i + 1; // Linear weighting: older = 1, newer = N
    weightedSum += bucket.vpin * weight;
    weightSum += weight;
  }

  return weightSum > 0 ? weightedSum / weightSum : 0;
}

/**
 * Classify flow based on VPIN thresholds
 */
export function classifyFlow(
  vpin: number,
  config: Partial<VPINConfig> = {}
): { classification: 'normal' | 'elevated' | 'toxic'; edgeMultiplier: number; shouldPause: boolean } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (vpin >= cfg.elevatedThreshold) {
    return {
      classification: 'toxic',
      edgeMultiplier: 0, // Don't trade
      shouldPause: true,
    };
  }

  if (vpin >= cfg.normalThreshold) {
    return {
      classification: 'elevated',
      edgeMultiplier: 1.5, // Require 50% higher edge
      shouldPause: false,
    };
  }

  return {
    classification: 'normal',
    edgeMultiplier: 1.0,
    shouldPause: false,
  };
}

/**
 * Full VPIN computation
 */
export function computeVPIN(
  trades: Trade[],
  midpoints: { timestamp: number; price: number }[],
  config: Partial<VPINConfig> = {}
): VPINResult {
  const buckets = createVPINBuckets(trades, midpoints, config);
  const currentVPIN = computeRollingVPIN(buckets, config);
  const { classification, edgeMultiplier, shouldPause } = classifyFlow(currentVPIN, config);

  return {
    currentVPIN,
    buckets,
    flowClassification: classification,
    edgeMultiplier,
    shouldPause,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Incrementally update VPIN with new trades
 * More efficient than recomputing from scratch
 */
export function updateVPIN(
  existingBuckets: VPINBucket[],
  newTrades: Trade[],
  midpoints: { timestamp: number; price: number }[],
  config: Partial<VPINConfig> = {}
): VPINResult {
  // Combine existing incomplete bucket with new trades
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // If we have existing buckets, check if the last one is complete
  const completeBuckets = existingBuckets.filter(
    (b) => b.totalVolume >= cfg.bucketSize * 0.95 // 95% full = complete
  );

  // Create new buckets from new trades
  const newBuckets = createVPINBuckets(newTrades, midpoints, config);

  // Combine and keep only the rolling window
  const allBuckets = [...completeBuckets, ...newBuckets].slice(-cfg.rollingBuckets);

  const currentVPIN = computeRollingVPIN(allBuckets, config);
  const { classification, edgeMultiplier, shouldPause } = classifyFlow(currentVPIN, config);

  return {
    currentVPIN,
    buckets: allBuckets,
    flowClassification: classification,
    edgeMultiplier,
    shouldPause,
    lastUpdated: new Date().toISOString(),
  };
}
