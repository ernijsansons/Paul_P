/**
 * Paul P - Price Semantics Normalization (P-16)
 *
 * Canonical price layer that handles:
 * - Binary token markets (Polymarket standard)
 * - Orderbook binary markets (Kalshi)
 * - Multi-outcome markets
 * - Fee-adjusted pricing
 * - Void risk markets
 *
 * All CLV and strategy logic must consume only normalized values.
 */

/**
 * Market mechanics classification
 */
export type MarketMechanics =
  | 'binary_token'      // Standard YES/NO tokens, sum ~ $1.00
  | 'orderbook_binary'  // Limit order book, YES+NO may != $1.00
  | 'multi_outcome'     // 3+ outcomes
  | 'fee_adjusted'      // Venue charges affect effective price
  | 'void_risk';        // High probability of void/refund

/**
 * CLV basis declaration
 */
export type CLVBasis = 'p_mid' | 'p_yes' | 'last_trade';

/**
 * Normalized price output
 */
export interface NormalizedPrice {
  pYes: number;        // Probability of YES outcome (0.0 to 1.0), fee-adjusted
  pNo: number;         // Probability of NO outcome (0.0 to 1.0), fee-adjusted
  pMid: number;        // Midpoint accounting for spread
  spread: number;      // Effective spread (yesAsk - yesBid equivalent)
  vig: number;         // Overround / vigorish: (pYes + pNo) - 1.0
  clvBasis: CLVBasis;  // Declared source for CLV computation
  isValid: boolean;    // Whether price is usable for trading/CLV
  warnings: string[];  // Any price anomalies detected
}

/**
 * Input for price normalization
 */
export interface RawPriceInput {
  mechanics: MarketMechanics;

  // For binary_token (Polymarket)
  yesPrice?: number;   // YES token price
  noPrice?: number;    // NO token price

  // For orderbook_binary (Kalshi)
  yesBid?: number;     // Best bid for YES
  yesAsk?: number;     // Best ask for YES
  noBid?: number;      // Best bid for NO
  noAsk?: number;      // Best ask for NO

  // For multi_outcome
  outcomePrices?: number[];  // Array of outcome prices

  // For fee_adjusted
  takerFeeBps?: number;      // Taker fee in basis points (e.g., 107 for 1.07%)

  // For void_risk
  voidProbability?: number;  // Estimated probability of void
}

/**
 * Kalshi fee schedule (as of 2026)
 * Taker fee: ~1.07 cents per contract (~1.07%)
 */
const KALSHI_TAKER_FEE_BPS = 107;

/**
 * Normalize prices to canonical representation
 */
export function normalizePrice(input: RawPriceInput): NormalizedPrice {
  const warnings: string[] = [];

  switch (input.mechanics) {
    case 'binary_token':
      return normalizeBinaryToken(input, warnings);

    case 'orderbook_binary':
      return normalizeOrderbookBinary(input, warnings);

    case 'multi_outcome':
      return normalizeMultiOutcome(input, warnings);

    case 'fee_adjusted':
      return normalizeFeeAdjusted(input, warnings);

    case 'void_risk':
      return normalizeVoidRisk(input, warnings);

    default:
      warnings.push(`Unknown mechanics type: ${input.mechanics}`);
      return {
        pYes: 0.5,
        pNo: 0.5,
        pMid: 0.5,
        spread: 0,
        vig: 0,
        clvBasis: 'p_mid',
        isValid: false,
        warnings,
      };
  }
}

/**
 * Normalize binary token market (Polymarket standard)
 * YES + NO should sum to ~$1.00
 */
function normalizeBinaryToken(input: RawPriceInput, warnings: string[]): NormalizedPrice {
  const yesPrice = input.yesPrice ?? 0.5;
  const noPrice = input.noPrice ?? 0.5;

  const sum = yesPrice + noPrice;

  // Check sum validity
  if (sum < 0.98) {
    warnings.push(`Token sum ${sum.toFixed(4)} < 0.98: potential arbitrage`);
  } else if (sum > 1.02) {
    warnings.push(`Token sum ${sum.toFixed(4)} > 1.02: high vig`);
  }

  const pYes = yesPrice;
  const pNo = noPrice;
  const pMid = (pYes + (1 - pNo)) / 2;
  const spread = pYes - (1 - pNo);
  const vig = sum - 1.0;

  return {
    pYes,
    pNo,
    pMid,
    spread: Math.abs(spread),
    vig,
    clvBasis: 'p_mid',
    isValid: sum >= 0.98 && sum <= 1.05,
    warnings,
  };
}

/**
 * Normalize orderbook binary market (Kalshi)
 * Uses bid/ask spreads, YES + NO may not equal $1.00
 */
function normalizeOrderbookBinary(input: RawPriceInput, warnings: string[]): NormalizedPrice {
  const yesBid = input.yesBid ?? 0;
  const yesAsk = input.yesAsk ?? 1;
  const noBid = input.noBid ?? 0;
  const noAsk = input.noAsk ?? 1;

  // Compute midpoints
  const yesMid = (yesBid + yesAsk) / 2;
  const noMid = (noBid + noAsk) / 2;

  // Check if bid/ask are inverted
  if (yesBid > yesAsk) {
    warnings.push('YES bid > ask: crossed book');
  }
  if (noBid > noAsk) {
    warnings.push('NO bid > ask: crossed book');
  }

  // Check if YES + NO bid/ask creates arbitrage
  if (yesAsk + noAsk < 1.0) {
    warnings.push(`YES ask + NO ask = ${(yesAsk + noAsk).toFixed(4)} < 1.0: potential arbitrage`);
  }

  const pYes = yesMid;
  const pNo = noMid;
  const pMid = (pYes + (1 - pNo)) / 2;
  const spread = yesAsk - yesBid;
  const vig = (yesMid + noMid) - 1.0;

  return {
    pYes,
    pNo,
    pMid,
    spread,
    vig,
    clvBasis: 'p_mid',
    isValid: yesBid <= yesAsk && noBid <= noAsk && spread < 0.20,
    warnings,
  };
}

/**
 * Normalize multi-outcome market
 * Prices should sum to ~1.0 when normalized
 */
function normalizeMultiOutcome(input: RawPriceInput, warnings: string[]): NormalizedPrice {
  const prices = input.outcomePrices ?? [];

  if (prices.length < 2) {
    warnings.push(`Multi-outcome market with ${prices.length} outcomes`);
    return {
      pYes: 0.5,
      pNo: 0.5,
      pMid: 0.5,
      spread: 0,
      vig: 0,
      clvBasis: 'p_mid',
      isValid: false,
      warnings,
    };
  }

  const sum = prices.reduce((a, b) => a + b, 0);

  // Normalize to sum to 1.0
  const normalizedPrices = prices.map((p) => p / sum);

  // For multi-outcome, we report the highest probability as "YES"
  const maxProb = Math.max(...normalizedPrices);

  if (Math.abs(sum - 1.0) > 0.05) {
    warnings.push(`Multi-outcome sum ${sum.toFixed(4)} deviates >5% from 1.0`);
  }

  return {
    pYes: maxProb,
    pNo: 1 - maxProb,
    pMid: maxProb,
    spread: 0, // Not directly applicable
    vig: sum - 1.0,
    clvBasis: 'p_yes',
    isValid: Math.abs(sum - 1.0) <= 0.10,
    warnings,
  };
}

/**
 * Normalize fee-adjusted market
 * Applies taker fee to effective prices
 */
function normalizeFeeAdjusted(input: RawPriceInput, warnings: string[]): NormalizedPrice {
  const yesBid = input.yesBid ?? 0;
  const yesAsk = input.yesAsk ?? 1;
  const takerFeeBps = input.takerFeeBps ?? KALSHI_TAKER_FEE_BPS;

  const feeMultiplier = takerFeeBps / 10000;

  // For buys: effective price = raw price + taker fee
  // For sells: effective price = raw price - taker fee
  const effectiveYesAsk = yesAsk + feeMultiplier;
  const effectiveYesBid = yesBid - feeMultiplier;

  const yesMid = (yesBid + yesAsk) / 2;
  const effectiveSpread = (yesAsk - yesBid) + (2 * feeMultiplier);

  // Example: $0.95 YES contract costs $0.9607 effective with 1.07% fee
  if (effectiveYesAsk > 1.0) {
    warnings.push(`Effective YES ask ${effectiveYesAsk.toFixed(4)} > 1.0 after fees`);
  }

  return {
    pYes: yesMid,
    pNo: 1 - yesMid,
    pMid: yesMid,
    spread: effectiveSpread,
    vig: feeMultiplier * 2, // Round-trip cost
    clvBasis: 'p_mid',
    isValid: effectiveYesBid >= 0 && effectiveYesAsk <= 1.05,
    warnings,
  };
}

/**
 * Normalize void risk market
 * Prices become meaningless when void probability is high
 */
function normalizeVoidRisk(input: RawPriceInput, warnings: string[]): NormalizedPrice {
  const voidProb = input.voidProbability ?? 0;
  const yesPrice = input.yesPrice ?? 0.5;
  const noPrice = input.noPrice ?? 0.5;

  if (voidProb > 0.1) {
    warnings.push(`High void probability: ${(voidProb * 100).toFixed(1)}%`);
  }

  // Adjust probabilities for void risk
  const adjustedYes = yesPrice * (1 - voidProb);
  const adjustedNo = noPrice * (1 - voidProb);

  return {
    pYes: adjustedYes,
    pNo: adjustedNo,
    pMid: (adjustedYes + adjustedNo) / 2,
    spread: Math.abs(yesPrice - (1 - noPrice)),
    vig: (yesPrice + noPrice) - 1.0,
    clvBasis: 'p_mid',
    isValid: voidProb < 0.5, // Exclude from CLV if >50% void risk
    warnings,
  };
}

/**
 * Detect market mechanics type from raw data
 */
export function detectMechanics(data: {
  venue: 'polymarket' | 'kalshi';
  hasOrderbook: boolean;
  outcomeCount: number;
  voidHistory: boolean;
}): MarketMechanics {
  if (data.voidHistory) {
    return 'void_risk';
  }

  if (data.outcomeCount > 2) {
    return 'multi_outcome';
  }

  if (data.venue === 'kalshi') {
    return 'fee_adjusted'; // Kalshi always has fees
  }

  if (data.hasOrderbook) {
    return 'orderbook_binary';
  }

  return 'binary_token';
}

/**
 * Convert Kalshi cents to normalized price
 * Kalshi prices are 1-99 cents
 */
export function kalshiCentsToNormalized(cents: number): number {
  return cents / 100;
}

/**
 * Convert normalized price to Kalshi cents
 */
export function normalizedToKalshiCents(price: number): number {
  return Math.round(price * 100);
}
