/**
 * Paul P - Market Impact Awareness (Phase B)
 *
 * Predicts and manages market impact:
 * - Detects insufficient market depth relative to order size
 * - Reduces order size if impact exceeds 30% of edge
 * - Tracks impact by market, order size, and market conditions
 * - Prevents oversize orders from eroding edge
 */

import type { KalshiMarket } from '../kalshi/types';

// ============================================================
// TYPES
// ============================================================

export interface MarketImpactAssessment {
  marketId: string;
  orderSize: number; // Original requested size
  adjustedSize: number; // Recommended size after impact adjustment
  wasSized: boolean; // True if size was reduced
  depthAtSubmission: number;
  estimatedImpactCents: number;
  estimatedImpactPercent: number; // As % of limit price
  ratioToEdge: number; // impact / edge
  maxSafeSize: number; // Largest size without exceeding impact threshold
  reason: string;
}

export interface DepthAnalysis {
  yes_depth: number;
  no_depth: number;
  total_depth: number;
  bid_side_depth: number;
  ask_side_depth: number;
  is_imbalanced: boolean;
  imbalance_ratio: number; // Deeper side / shallower side
}

// ============================================================
// DEPTH EXTRACTION
// ============================================================

/**
 * Extract available market depth from orderbook-like structures
 * Estimates liquidity available at current bid/ask prices
 */
export function estimateAvailableDepth(market: KalshiMarket): DepthAnalysis {
  // Use volume_24h as proxy for typical liquidity
  const volume24h = market.volume_24h ?? 0;
  const spread = Math.abs((market.yes_ask ?? 50) - (market.yes_bid ?? 50));

  // Estimate depth based on volume and spread
  // Higher volume = more liquidity; tighter spread = more depth
  const spreadPenalty = 1 + spread / 50; // Wider spreads indicate lower depth
  const estimatedYesDepth = Math.max(100, volume24h / (spreadPenalty * 2));
  const estimatedNoDepth = Math.max(100, volume24h / (spreadPenalty * 2));

  const totalDepth = estimatedYesDepth + estimatedNoDepth;
  const bidSideDepth = estimatedYesDepth; // Bid for YES is sell for NO
  const askSideDepth = estimatedNoDepth;

  const bidAskRatio = Math.max(bidSideDepth, askSideDepth) / Math.max(1, Math.min(bidSideDepth, askSideDepth));
  const isImbalanced = bidAskRatio > 2.0; // >2:1 ratio = imbalanced

  return {
    yes_depth: estimatedYesDepth,
    no_depth: estimatedNoDepth,
    total_depth: totalDepth,
    bid_side_depth: bidSideDepth,
    ask_side_depth: askSideDepth,
    is_imbalanced: isImbalanced,
    imbalance_ratio: bidAskRatio,
  };
}

// ============================================================
// IMPACT ESTIMATION
// ============================================================

/**
 * Linear impact model: Estimated fill slippage from order size
 * Impact = order_size / available_depth * spread
 */
export function estimateLinearImpact(
  orderSize: number,
  availableDepth: number,
  spread: number
): number {
  if (availableDepth <= 0) {
    return spread * 0.5; // Pessimistic: assume we cross spread
  }

  // Impact increases with order size relative to depth
  const depthRatio = orderSize / availableDepth;

  // Linear model: small orders have minimal impact
  // Large orders can cross multiple levels
  const impactPercent = Math.min(1, depthRatio); // Capped at 100%
  const estimatedImpact = spread * impactPercent;

  return estimatedImpact;
}

/**
 * Concave impact model: More realistic, accounts for liquidity clustering
 * Smaller orders hit better liquidity first, larger orders must cross worse levels
 */
export function estimateConcaveImpact(
  orderSize: number,
  availableDepth: number,
  spread: number,
  vpin: number // Order flow toxicity
): number {
  if (availableDepth <= 0) {
    return spread * (0.5 + vpin * 0.2); // Worse in toxic flow
  }

  // Concave impact: sqrt relationship for realistic liquidity decay
  const depthRatio = Math.sqrt(orderSize / availableDepth);
  const baseImpact = spread * Math.min(1, depthRatio);

  // Adjust for toxic flow (VPIN > 0.5 = toxic)
  const toxicityMultiplier = 1 + vpin * 0.3;
  const adjustedImpact = baseImpact * toxicityMultiplier;

  return adjustedImpact;
}

// ============================================================
// SIZE ADJUSTMENT LOGIC
// ============================================================

/**
 * Assess market impact and recommend size adjustment
 * Returns adjusted size if depth < 2x order OR impact > 30% of edge
 */
export function assessMarketImpact(
  marketId: string,
  requestedSize: number,
  limitPrice: number,
  edge: number, // Expected edge in cents
  market: KalshiMarket,
  side: 'YES' | 'NO'
): MarketImpactAssessment {
  // Step 1: Extract depth
  const depth = estimateAvailableDepth(market);

  // Step 2: Calculate spread
  const spread =
    side === 'YES'
      ? Math.abs((market.yes_ask ?? 50) - (market.yes_bid ?? 50))
      : Math.abs((market.no_ask ?? 50) - (market.no_bid ?? 50));

  // Step 3: Choose which depth to use
  const relevantDepth =
    side === 'YES' ? depth.yes_depth : depth.no_depth;

  // Step 4: Estimate impact using concave model
  const vpin = 0.5; // Default assumption; could be passed as parameter
  const estimatedImpact = estimateConcaveImpact(
    requestedSize,
    relevantDepth,
    spread,
    vpin
  );

  // Step 5: Calculate impact metrics
  const estimatedImpactPercent = (estimatedImpact / limitPrice) * 100;
  const ratioToEdge = estimatedImpact / Math.max(0.01, edge);

  // Step 6: Determine if adjustment needed
  const IMPACT_THRESHOLD = 0.3; // Don't exceed 30% of edge
  const DEPTH_MULTIPLIER = 2.0; // Want depth > 2x order size

  const depthTooShallow = requestedSize > relevantDepth * DEPTH_MULTIPLIER;
  const impactTooHigh = ratioToEdge > IMPACT_THRESHOLD;
  const needsAdjustment = depthTooShallow || impactTooHigh;

  // Step 7: Calculate max safe size
  const maxSafeByDepth = relevantDepth * DEPTH_MULTIPLIER;
  const maxSafeByEdge = Math.floor((edge * IMPACT_THRESHOLD * relevantDepth) / spread);
  const maxSafeSize = Math.floor(Math.min(maxSafeByDepth, maxSafeByEdge));

  // Step 8: Determine adjusted size and reason
  let adjustedSize = requestedSize;
  let reason = 'No adjustment needed';

  if (needsAdjustment) {
    adjustedSize = Math.max(1, Math.floor(maxSafeSize * 0.9)); // Use 90% of max safe
    const reasons: string[] = [];

    if (depthTooShallow) {
      reasons.push(
        `depth ${Math.floor(relevantDepth)} < ${Math.floor(maxSafeByDepth)} (${DEPTH_MULTIPLIER}x requested)`
      );
    }

    if (impactTooHigh) {
      reasons.push(`impact ${ratioToEdge.toFixed(2)}x edge > ${IMPACT_THRESHOLD}x threshold`);
    }

    reason = `Reduced ${requestedSize} → ${adjustedSize}: ${reasons.join(', ')}`;
  }

  return {
    marketId,
    orderSize: requestedSize,
    adjustedSize,
    wasSized: needsAdjustment,
    depthAtSubmission: relevantDepth,
    estimatedImpactCents: estimatedImpact,
    estimatedImpactPercent,
    ratioToEdge,
    maxSafeSize,
    reason,
  };
}

/**
 * Apply market impact adjustment to order size
 * Also checks for imbalanced markets and applies additional penalty
 */
export function applyMarketImpactAdjustment(
  requestedSize: number,
  limitPrice: number,
  edge: number,
  market: KalshiMarket,
  side: 'YES' | 'NO'
): { adjustedSize: number; assessment: MarketImpactAssessment } {
  const assessment = assessMarketImpact(
    market.ticker || 'unknown',
    requestedSize,
    limitPrice,
    edge,
    market,
    side
  );

  // Additional penalty for imbalanced markets
  let adjustedSize = assessment.adjustedSize;

  const depth = estimateAvailableDepth(market);
  if (depth.is_imbalanced && assessment.wasSized) {
    // Further reduce if market is imbalanced
    adjustedSize = Math.floor(adjustedSize * 0.8); // 20% reduction for imbalance
  }

  return {
    adjustedSize: Math.max(1, adjustedSize),
    assessment: {
      ...assessment,
      adjustedSize: Math.max(1, adjustedSize),
    },
  };
}

// ============================================================
// LOOKUP TABLE FOR COMMON MARKETS
// ============================================================

/**
 * Pre-computed impact lookup for common Kalshi markets
 * Avoids recalculation for high-frequency signals
 */
export interface ImpactLookupEntry {
  ticker: string;
  marketDepth: number;
  typicalSpread: number;
  maxSafeSize: number; // For 1-cent edge
  lastUpdated: number;
}

export class MarketImpactLookup {
  private cache: Map<string, ImpactLookupEntry> = new Map();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minute cache

  /**
   * Get or compute max safe size for a market
   */
  getMaxSafeSize(
    ticker: string,
    market: KalshiMarket,
    edge: number
  ): number {
    const cached = this.cache.get(ticker);
    const now = Date.now();

    // Return cached if fresh
    if (cached && now - cached.lastUpdated < this.TTL_MS) {
      // Adjust for edge
      return Math.floor((cached.maxSafeSize * edge) / 0.01); // Scale for 1-cent baseline
    }

    // Compute new entry
    const depth = estimateAvailableDepth(market);
    const spread = Math.abs((market.yes_ask ?? 50) - (market.yes_bid ?? 50));
    const maxSafe = Math.floor((depth.total_depth * 0.3) / spread); // 30% of depth

    const entry: ImpactLookupEntry = {
      ticker,
      marketDepth: depth.total_depth,
      typicalSpread: spread,
      maxSafeSize: maxSafe,
      lastUpdated: now,
    };

    this.cache.set(ticker, entry);
    return Math.floor((maxSafe * edge) / 0.01);
  }

  /**
   * Clear cache entry (e.g., after market conditions change sharply)
   */
  invalidate(ticker: string): void {
    this.cache.delete(ticker);
  }

  /**
   * Clear all cache
   */
  clearAll(): void {
    this.cache.clear();
  }
}
