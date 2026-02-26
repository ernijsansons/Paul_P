/**
 * Paul P - CLV (Closing Line Value) Computation
 *
 * CLV Sign Convention (P-01 CRITICAL):
 *   CLV = closing_line_price - entry_price
 *   POSITIVE CLV = edge (entered at better price than closing consensus)
 *
 * For YES buyer: positive CLV means you bought cheaper than closing YES price
 * For NO buyer: positive CLV means you bought NO cheaper than closing NO price
 *
 * Over large samples, consistently positive CLV predicts long-term profitability.
 */

/**
 * Market class determines the closing line definition
 */
export type MarketClass =
  | 'political'   // T-60 minutes before resolution announcement
  | 'sports'      // Last traded price before market halt
  | 'weather'     // T-5 minutes before data release
  | 'mentions'    // T-30 seconds before speech segment
  | 'crypto';     // T-60 seconds before oracle update

/**
 * CLV computation result
 */
export interface CLVResult {
  clv: number;              // Raw CLV value (positive = edge)
  clvCents: number;         // CLV in cents for display
  closingLinePrice: number; // The closing line price used
  entryPrice: number;       // The entry price
  side: 'YES' | 'NO';       // Position side
  closingLineMethod: string; // Which CL definition was used
  isValid: boolean;         // Whether CLV is valid for use
  qualityScore: number;     // Closing line quality (0-1)
}

/**
 * Closing line window configuration by market class
 */
const CLOSING_LINE_WINDOWS: Record<MarketClass, { windowMs: number; description: string }> = {
  political: { windowMs: 60 * 60 * 1000, description: 'T-60min' },  // 60 minutes
  sports: { windowMs: 0, description: 'last-trade' },               // Last trade before halt
  weather: { windowMs: 5 * 60 * 1000, description: 'T-5min' },      // 5 minutes
  mentions: { windowMs: 30 * 1000, description: 'T-30sec' },        // 30 seconds
  crypto: { windowMs: 60 * 1000, description: 'T-60sec' },          // 60 seconds
};

/**
 * Compute CLV for a position
 *
 * @param entryPrice - The average entry price (0-1)
 * @param closingLinePrice - The closing line price (0-1)
 * @param side - 'YES' or 'NO'
 * @param marketClass - Market class for CL definition
 * @param qualityScore - Optional closing line quality (0-1)
 */
export function computeCLV(
  entryPrice: number,
  closingLinePrice: number,
  side: 'YES' | 'NO',
  marketClass: MarketClass,
  qualityScore = 1.0
): CLVResult {
  const windowConfig = CLOSING_LINE_WINDOWS[marketClass];

  // For YES positions: CLV = closing_price - entry_price
  // For NO positions: we compare NO prices, so CLV = closing_NO_price - entry_NO_price
  // Since closing_NO_price = 1 - closing_YES_price and entry_NO_price = 1 - entry_YES_price,
  // this is equivalent to CLV = entry_YES_price - closing_YES_price (inverted for NO)
  //
  // HOWEVER, the convention is unified: we always compute based on the side's perspective.
  // If you're a YES buyer and bought at 0.40 and CL is 0.50, CLV = 0.50 - 0.40 = +0.10 (edge)
  // If you're a NO buyer and bought NO at 0.60 and CL of NO is 0.50, CLV = 0.50 - 0.60 = -0.10 (no edge)
  //
  // For NO buyers, we pass in the NO prices directly, so the formula is the same.

  const clv = closingLinePrice - entryPrice;
  const clvCents = clv * 100;

  // CLV is valid only when quality score >= 0.5 (P-17)
  const isValid = qualityScore >= 0.5;

  return {
    clv,
    clvCents,
    closingLinePrice,
    entryPrice,
    side,
    closingLineMethod: windowConfig.description,
    isValid,
    qualityScore,
  };
}

/**
 * Compute CLV for a YES buyer
 *
 * Example:
 *   Entry: bought YES at $0.40
 *   Closing line: YES at $0.50
 *   CLV = 0.50 - 0.40 = +0.10 = +10 cents = EDGE
 */
export function computeCLVForYesBuyer(
  entryYesPrice: number,
  closingYesPrice: number,
  marketClass: MarketClass,
  qualityScore = 1.0
): CLVResult {
  return computeCLV(entryYesPrice, closingYesPrice, 'YES', marketClass, qualityScore);
}

/**
 * Compute CLV for a NO buyer
 *
 * Example:
 *   Entry: bought NO at $0.60 (equivalent to selling YES at $0.40)
 *   Closing line: NO at $0.50
 *   CLV = 0.50 - 0.60 = -0.10 = -10 cents = NO EDGE
 *
 * Note: Pass in the NO prices, not converted YES prices.
 */
export function computeCLVForNoBuyer(
  entryNoPrice: number,
  closingNoPrice: number,
  marketClass: MarketClass,
  qualityScore = 1.0
): CLVResult {
  return computeCLV(entryNoPrice, closingNoPrice, 'NO', marketClass, qualityScore);
}

/**
 * Compute aggregate CLV statistics for a set of positions
 */
export interface CLVStatistics {
  meanCLV: number;
  meanCLVCents: number;
  stdDevCLV: number;
  positiveCLVCount: number;
  negativeCLVCount: number;
  validCLVCount: number;
  invalidCLVCount: number;
  clvConsistencyScore: number;  // % of positions with positive CLV
}

export function computeCLVStatistics(results: CLVResult[]): CLVStatistics {
  const validResults = results.filter((r) => r.isValid);
  const invalidCount = results.length - validResults.length;

  if (validResults.length === 0) {
    return {
      meanCLV: 0,
      meanCLVCents: 0,
      stdDevCLV: 0,
      positiveCLVCount: 0,
      negativeCLVCount: 0,
      validCLVCount: 0,
      invalidCLVCount: invalidCount,
      clvConsistencyScore: 0,
    };
  }

  const clvValues = validResults.map((r) => r.clv);
  const mean = clvValues.reduce((a, b) => a + b, 0) / clvValues.length;

  const variance = clvValues.reduce((sum, clv) => sum + Math.pow(clv - mean, 2), 0) / clvValues.length;
  const stdDev = Math.sqrt(variance);

  const positiveCount = clvValues.filter((c) => c > 0).length;
  const negativeCount = clvValues.filter((c) => c < 0).length;

  return {
    meanCLV: mean,
    meanCLVCents: mean * 100,
    stdDevCLV: stdDev,
    positiveCLVCount: positiveCount,
    negativeCLVCount: negativeCount,
    validCLVCount: validResults.length,
    invalidCLVCount: invalidCount,
    clvConsistencyScore: positiveCount / validResults.length,
  };
}

/**
 * Score CLV consistency for skill rubric (P-01)
 *
 * Scoring (out of 25 points):
 *   Mean CLV > +3¢ = 25
 *   Mean CLV +2 to +3¢ = 20
 *   Mean CLV +1 to +2¢ = 15
 *   Mean CLV 0 to +1¢ = 10
 *   Mean CLV negative = 0
 */
export function scoreCLVConsistency(meanCLVCents: number, validCount: number): number {
  // Require at least 10 positions
  if (validCount < 10) {
    return 0;
  }

  if (meanCLVCents > 3) return 25;
  if (meanCLVCents > 2) return 20;
  if (meanCLVCents > 1) return 15;
  if (meanCLVCents > 0) return 10;
  return 0;
}

/**
 * Get closing line window for a market class
 */
export function getClosingLineWindow(marketClass: MarketClass): { windowMs: number; description: string } {
  return CLOSING_LINE_WINDOWS[marketClass];
}

/**
 * Infer market class from category/tags
 */
export function inferMarketClass(category?: string, tags?: string[]): MarketClass {
  const lowerCategory = category?.toLowerCase() ?? '';
  const lowerTags = tags?.map((t) => t.toLowerCase()) ?? [];

  if (lowerCategory.includes('politic') || lowerCategory.includes('election')) {
    return 'political';
  }

  if (lowerCategory.includes('sport') || lowerTags.some((t) => t.includes('sport') || t.includes('game'))) {
    return 'sports';
  }

  if (lowerCategory.includes('weather') || lowerTags.some((t) => t.includes('weather') || t.includes('temperature'))) {
    return 'weather';
  }

  if (lowerCategory.includes('mention') || lowerTags.some((t) => t.includes('speech') || t.includes('say'))) {
    return 'mentions';
  }

  if (lowerCategory.includes('crypto') || lowerTags.some((t) => t.includes('btc') || t.includes('eth') || t.includes('bitcoin'))) {
    return 'crypto';
  }

  // Default to political (longest window = most conservative)
  return 'political';
}
