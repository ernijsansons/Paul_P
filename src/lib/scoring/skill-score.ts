/**
 * Paul P - Account Skill Score (0-100)
 *
 * 8-factor weighted rubric from blueprint Section B4:
 *   - CLV Consistency: 25%
 *   - Risk-Adjusted Returns: 20%
 *   - Sizing Discipline: 15%
 *   - Ambiguity Avoidance: 10%
 *   - Low Fee Drag: 5%
 *   - Diversification: 10%
 *   - No Blowup Signatures: 10%
 *   - Longevity: 5%
 *
 * Skill Score Tiers:
 *   80-100: Elite
 *   60-79: Skilled
 *   40-59: Competent
 *   20-39: Noise
 *   0-19: Losing
 */

import { scoreCLVConsistency, type CLVStatistics } from './clv';

/**
 * Input data for skill score computation
 */
export interface SkillScoreInput {
  // CLV metrics
  clvStats: CLVStatistics;

  // Returns metrics
  totalPnl: number;
  totalPositions: number;
  positionPnls: number[];  // Array of individual position PnLs
  positionsPerMonth: number;

  // Sizing metrics
  maxPositionPct: number;  // Max single position as % of portfolio

  // Ambiguity metrics
  totalAmbiguityAssessed: number;  // Positions with ambiguity score
  lowAmbiguityCount: number;       // Positions with ambiguity_score < 0.3

  // Fee metrics
  grossProfit: number;
  totalFees: number;

  // Diversification
  categoryPnls: Record<string, number>;  // PnL by category

  // Blowup signatures
  hasBlowup: boolean;
  hasMartingale: boolean;
  hasRevenge: boolean;

  // Longevity
  accountAgeDays: number;
  hasConsistentActivity: boolean;
}

/**
 * Skill score result with breakdown
 */
export interface SkillScoreResult {
  totalScore: number;
  tier: 'Elite' | 'Skilled' | 'Competent' | 'Noise' | 'Losing';

  // Component scores (out of their max)
  clvScore: number;           // 0-25
  returnsScore: number;       // 0-20
  sizingScore: number;        // 0-15
  ambiguityScore: number;     // 0-10
  feeScore: number;           // 0-5
  diversificationScore: number; // 0-10
  blowupScore: number;        // 0-10
  longevityScore: number;     // 0-5

  // CLV stability check
  clvStabilityWarning: boolean;  // True if CLV-based vs non-CLV ranks differ
}

/**
 * Compute Sharpe-equivalent ratio
 */
function computeSharpe(positionPnls: number[], positionsPerMonth: number): number {
  if (positionPnls.length < 5) return 0;

  const mean = positionPnls.reduce((a, b) => a + b, 0) / positionPnls.length;
  const variance = positionPnls.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / positionPnls.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Sharpe-equivalent = (mean / stdDev) * sqrt(positions_per_month)
  return (mean / stdDev) * Math.sqrt(positionsPerMonth);
}

/**
 * Score risk-adjusted returns (0-20)
 */
function scoreReturns(sharpe: number): number {
  if (sharpe > 2.0) return 20;
  if (sharpe > 1.5) return 16;
  if (sharpe > 1.0) return 12;
  if (sharpe > 0.5) return 8;
  return 0;
}

/**
 * Score sizing discipline (0-15)
 */
function scoreSizing(maxPositionPct: number): number {
  if (maxPositionPct < 0.10) return 15;  // < 10%
  if (maxPositionPct < 0.20) return 12;  // 10-20%
  if (maxPositionPct < 0.30) return 8;   // 20-30%
  return 4;                               // > 30%
}

/**
 * Score ambiguity avoidance (0-10)
 */
function scoreAmbiguity(totalAssessed: number, lowAmbiguityCount: number): number {
  if (totalAssessed === 0) return 5; // No data, neutral

  const pct = lowAmbiguityCount / totalAssessed;

  if (pct > 0.80) return 10;  // > 80% in low-ambiguity markets
  if (pct > 0.60) return 7;   // 60-80%
  return 3;                    // < 60%
}

/**
 * Score fee drag (0-5)
 */
function scoreFees(grossProfit: number, totalFees: number): number {
  if (grossProfit <= 0) return 1;

  const feePct = totalFees / grossProfit;

  if (feePct < 0.05) return 5;   // < 5%
  if (feePct < 0.15) return 3;   // 5-15%
  return 1;                       // > 15%
}

/**
 * Compute Herfindahl index for concentration
 */
function computeHerfindahl(categoryPnls: Record<string, number>): number {
  const values = Object.values(categoryPnls).filter((v) => v > 0);
  if (values.length === 0) return 1;

  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 1;

  const shares = values.map((v) => v / total);
  return shares.reduce((sum, s) => sum + s * s, 0);
}

/**
 * Score diversification (0-10)
 */
function scoreDiversification(categoryPnls: Record<string, number>): number {
  const hhi = computeHerfindahl(categoryPnls);

  if (hhi < 0.25) return 10;  // Well diversified
  if (hhi < 0.50) return 7;   // Moderately diversified
  return 3;                    // Concentrated
}

/**
 * Score blowup signatures (0-10)
 */
function scoreBlowup(hasBlowup: boolean, hasMartingale: boolean, hasRevenge: boolean): number {
  const flags = [hasBlowup, hasMartingale, hasRevenge].filter(Boolean).length;

  if (flags === 0) return 10;  // No flags
  if (flags === 1) return 5;   // One flag
  return 0;                     // Multiple flags
}

/**
 * Score longevity (0-5)
 */
function scoreLongevity(accountAgeDays: number, hasConsistentActivity: boolean): number {
  if (accountAgeDays > 180 && hasConsistentActivity) return 5;
  if (accountAgeDays > 90) return 3;
  return 1;
}

/**
 * Determine skill tier from total score
 */
function getTier(score: number): SkillScoreResult['tier'] {
  if (score >= 80) return 'Elite';
  if (score >= 60) return 'Skilled';
  if (score >= 40) return 'Competent';
  if (score >= 20) return 'Noise';
  return 'Losing';
}

/**
 * Compute account skill score
 */
export function computeSkillScore(input: SkillScoreInput): SkillScoreResult {
  // Require minimum 20 positions over 60 days
  if (input.totalPositions < 20 || input.accountAgeDays < 60) {
    return {
      totalScore: 0,
      tier: 'Losing',
      clvScore: 0,
      returnsScore: 0,
      sizingScore: 0,
      ambiguityScore: 0,
      feeScore: 0,
      diversificationScore: 0,
      blowupScore: 0,
      longevityScore: 0,
      clvStabilityWarning: false,
    };
  }

  // Compute component scores
  const clvScore = scoreCLVConsistency(input.clvStats.meanCLVCents, input.clvStats.validCLVCount);
  const sharpe = computeSharpe(input.positionPnls, input.positionsPerMonth);
  const returnsScore = scoreReturns(sharpe);
  const sizingScore = scoreSizing(input.maxPositionPct);
  const ambiguityScore = scoreAmbiguity(input.totalAmbiguityAssessed, input.lowAmbiguityCount);
  const feeScore = scoreFees(input.grossProfit, input.totalFees);
  const diversificationScore = scoreDiversification(input.categoryPnls);
  const blowupScore = scoreBlowup(input.hasBlowup, input.hasMartingale, input.hasRevenge);
  const longevityScore = scoreLongevity(input.accountAgeDays, input.hasConsistentActivity);

  const totalScore =
    clvScore +
    returnsScore +
    sizingScore +
    ambiguityScore +
    feeScore +
    diversificationScore +
    blowupScore +
    longevityScore;

  const withoutClvScaled = (totalScore - clvScore) * (100 / 75);

  return {
    totalScore,
    tier: getTier(totalScore),
    clvScore,
    returnsScore,
    sizingScore,
    ambiguityScore,
    feeScore,
    diversificationScore,
    blowupScore,
    longevityScore,
    clvStabilityWarning: Math.abs(totalScore - withoutClvScaled) > 10,
  };
}

/**
 * Compute skill score WITHOUT CLV component
 * Used to detect CLV scoring instability (P-17)
 */
export function computeSkillScoreWithoutCLV(input: SkillScoreInput): SkillScoreResult {
  // Require minimum 20 positions over 60 days
  if (input.totalPositions < 20 || input.accountAgeDays < 60) {
    return {
      totalScore: 0,
      tier: 'Losing',
      clvScore: 0,
      returnsScore: 0,
      sizingScore: 0,
      ambiguityScore: 0,
      feeScore: 0,
      diversificationScore: 0,
      blowupScore: 0,
      longevityScore: 0,
      clvStabilityWarning: false,
    };
  }

  const clvScore = scoreCLVConsistency(input.clvStats.meanCLVCents, input.clvStats.validCLVCount);
  const sharpe = computeSharpe(input.positionPnls, input.positionsPerMonth);
  const returnsScore = scoreReturns(sharpe);
  const sizingScore = scoreSizing(input.maxPositionPct);
  const ambiguityScore = scoreAmbiguity(input.totalAmbiguityAssessed, input.lowAmbiguityCount);
  const feeScore = scoreFees(input.grossProfit, input.totalFees);
  const diversificationScore = scoreDiversification(input.categoryPnls);
  const blowupScore = scoreBlowup(input.hasBlowup, input.hasMartingale, input.hasRevenge);
  const longevityScore = scoreLongevity(input.accountAgeDays, input.hasConsistentActivity);

  const withClvTotal =
    clvScore +
    returnsScore +
    sizingScore +
    ambiguityScore +
    feeScore +
    diversificationScore +
    blowupScore +
    longevityScore;

  const scaledTotal = Math.round((withClvTotal - clvScore) * (100 / 75));

  return {
    totalScore: scaledTotal,
    tier: getTier(scaledTotal),
    clvScore: 0,
    returnsScore,
    sizingScore,
    ambiguityScore,
    feeScore,
    diversificationScore,
    blowupScore,
    longevityScore,
    clvStabilityWarning: Math.abs(withClvTotal - scaledTotal) > 10,
  };
}
