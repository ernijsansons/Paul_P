/**
 * Paul P - Account Skill Scoring (Blueprint Section B4)
 *
 * 8-Factor Weighted Rubric for evaluating trader skill
 * Score range: 0-100
 *
 * Factors:
 * 1. CLV Consistency (25%) - Mean CLV across positions
 * 2. Risk-Adjusted Returns (20%) - Sharpe-equivalent
 * 3. Sizing Discipline (15%) - Max position as % of portfolio
 * 4. Ambiguity Avoidance (10%) - % in low-ambiguity markets
 * 5. Low Fee Drag (5%) - Fees as % of gross profit
 * 6. Diversification (10%) - Herfindahl index
 * 7. No Blowup Signatures (10%) - Behavioral flags
 * 8. Longevity (5%) - Account age and consistency
 */

export interface AccountPosition {
  marketId: string;
  category: string;
  entryPrice: number;
  closingLinePrice: number;
  clv: number;
  clvValid: boolean;
  pnl: number;
  size: number;
  fees: number;
  ambiguityScore: number;
  entryTimestamp: number;
  exitTimestamp: number;
}

export interface AccountMetrics {
  accountId: string;
  totalPositions: number;
  totalPnL: number;
  totalFees: number;
  portfolioValue: number;
  accountCreatedAt: number;
  lastActivityAt: number;
  positions: AccountPosition[];
  blowupFlags: BlowupFlag[];
}

export type BlowupFlag = 'MARTINGALE' | 'REVENGE_TRADING' | 'BLOWUP' | 'CONCENTRATION_RISK';

export interface SkillScoreResult {
  totalScore: number;
  tier: 'elite' | 'skilled' | 'competent' | 'noise' | 'losing';
  factors: {
    clvConsistency: { score: number; maxScore: number; meanCLV: number; validPositions: number };
    riskAdjustedReturns: { score: number; maxScore: number; sharpe: number };
    sizingDiscipline: { score: number; maxScore: number; maxPositionPct: number };
    ambiguityAvoidance: { score: number; maxScore: number; lowAmbiguityPct: number };
    lowFeeDrag: { score: number; maxScore: number; feeDragPct: number };
    diversification: { score: number; maxScore: number; herfindahl: number };
    noBlowupSignatures: { score: number; maxScore: number; flagCount: number };
    longevity: { score: number; maxScore: number; activeDays: number };
  };
  computedAt: string;
  includedCLV: boolean;
}

/**
 * Factor 1: CLV Consistency (25 points)
 * Mean CLV (positive = edge) across >= 10 positions
 */
function scoreCLVConsistency(
  positions: AccountPosition[]
): { score: number; meanCLV: number; validPositions: number } {
  const validPositions = positions.filter((p) => p.clvValid);

  if (validPositions.length < 10) {
    return { score: 0, meanCLV: 0, validPositions: validPositions.length };
  }

  const meanCLV = validPositions.reduce((sum, p) => sum + p.clv, 0) / validPositions.length;
  const meanCLVCents = meanCLV * 100;

  let score: number;
  if (meanCLVCents > 3) {
    score = 25;
  } else if (meanCLVCents >= 2) {
    score = 20;
  } else if (meanCLVCents >= 1) {
    score = 15;
  } else if (meanCLVCents >= 0) {
    score = 10;
  } else {
    score = 0;
  }

  return { score, meanCLV, validPositions: validPositions.length };
}

/**
 * Factor 2: Risk-Adjusted Returns (20 points)
 * Sharpe-equivalent calculation
 */
function scoreRiskAdjustedReturns(
  positions: AccountPosition[],
  portfolioValue: number
): { score: number; sharpe: number } {
  if (positions.length < 5 || portfolioValue <= 0) {
    return { score: 0, sharpe: 0 };
  }

  // Calculate returns per position
  const returns = positions.map((p) => p.pnl / portfolioValue);

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualize (assuming 252 trading days)
  // For simplicity, we use a basic Sharpe approximation
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252 / positions.length) : 0;

  let score: number;
  if (sharpe > 2.0) {
    score = 20;
  } else if (sharpe >= 1.5) {
    score = 16;
  } else if (sharpe >= 1.0) {
    score = 12;
  } else if (sharpe >= 0.5) {
    score = 8;
  } else {
    score = 0;
  }

  return { score, sharpe };
}

/**
 * Factor 3: Sizing Discipline (15 points)
 * Max position as % of portfolio
 */
function scoreSizingDiscipline(
  positions: AccountPosition[],
  portfolioValue: number
): { score: number; maxPositionPct: number } {
  if (positions.length === 0 || portfolioValue <= 0) {
    return { score: 15, maxPositionPct: 0 }; // No positions = perfect discipline
  }

  const maxPosition = Math.max(...positions.map((p) => Math.abs(p.size)));
  const maxPositionPct = (maxPosition / portfolioValue) * 100;

  let score: number;
  if (maxPositionPct < 10) {
    score = 15;
  } else if (maxPositionPct <= 20) {
    score = 12;
  } else if (maxPositionPct <= 30) {
    score = 8;
  } else {
    score = 4;
  }

  return { score, maxPositionPct };
}

/**
 * Factor 4: Ambiguity Avoidance (10 points)
 * % of positions in markets with ambiguity_score < 0.3
 */
function scoreAmbiguityAvoidance(
  positions: AccountPosition[]
): { score: number; lowAmbiguityPct: number } {
  if (positions.length === 0) {
    return { score: 10, lowAmbiguityPct: 100 };
  }

  const lowAmbiguityCount = positions.filter((p) => p.ambiguityScore < 0.3).length;
  const lowAmbiguityPct = (lowAmbiguityCount / positions.length) * 100;

  let score: number;
  if (lowAmbiguityPct > 80) {
    score = 10;
  } else if (lowAmbiguityPct >= 60) {
    score = 7;
  } else {
    score = 3;
  }

  return { score, lowAmbiguityPct };
}

/**
 * Factor 5: Low Fee Drag (5 points)
 * Fees as % of gross profit
 */
function scoreLowFeeDrag(
  totalFees: number,
  grossProfit: number
): { score: number; feeDragPct: number } {
  if (grossProfit <= 0) {
    // No profit = fees don't matter for scoring
    return { score: 3, feeDragPct: totalFees > 0 ? 100 : 0 };
  }

  const feeDragPct = (totalFees / grossProfit) * 100;

  let score: number;
  if (feeDragPct < 5) {
    score = 5;
  } else if (feeDragPct <= 15) {
    score = 3;
  } else {
    score = 1;
  }

  return { score, feeDragPct };
}

/**
 * Factor 6: Diversification (10 points)
 * Herfindahl index of PnL across market categories
 */
function scoreDiversification(positions: AccountPosition[]): { score: number; herfindahl: number } {
  if (positions.length === 0) {
    return { score: 10, herfindahl: 0 };
  }

  // Group PnL by category
  const pnlByCategory: Record<string, number> = {};
  let totalAbsPnL = 0;

  for (const p of positions) {
    const category = p.category || 'unknown';
    pnlByCategory[category] = (pnlByCategory[category] ?? 0) + Math.abs(p.pnl);
    totalAbsPnL += Math.abs(p.pnl);
  }

  if (totalAbsPnL === 0) {
    return { score: 10, herfindahl: 0 };
  }

  // Calculate Herfindahl index
  let herfindahl = 0;
  for (const category of Object.keys(pnlByCategory)) {
    const share = (pnlByCategory[category] ?? 0) / totalAbsPnL;
    herfindahl += share * share;
  }

  let score: number;
  if (herfindahl < 0.25) {
    score = 10;
  } else if (herfindahl <= 0.5) {
    score = 7;
  } else {
    score = 3;
  }

  return { score, herfindahl };
}

/**
 * Factor 7: No Blowup Signatures (10 points)
 * Behavioral red flags
 */
function scoreNoBlowupSignatures(flags: BlowupFlag[]): { score: number; flagCount: number } {
  const flagCount = flags.length;

  let score: number;
  if (flagCount === 0) {
    score = 10;
  } else if (flagCount === 1) {
    score = 5;
  } else {
    score = 0;
  }

  return { score, flagCount };
}

/**
 * Factor 8: Longevity (5 points)
 * Active > 180 days with consistent activity
 */
function scoreLongevity(
  accountCreatedAt: number,
  lastActivityAt: number
): { score: number; activeDays: number } {
  const activeDays = Math.floor((lastActivityAt - accountCreatedAt) / (1000 * 60 * 60 * 24));

  let score: number;
  if (activeDays >= 180) {
    score = 5;
  } else if (activeDays >= 90) {
    score = 3;
  } else {
    score = 1;
  }

  return { score, activeDays };
}

/**
 * Determine skill tier from total score
 */
function getTier(score: number): 'elite' | 'skilled' | 'competent' | 'noise' | 'losing' {
  if (score >= 80) return 'elite';
  if (score >= 60) return 'skilled';
  if (score >= 40) return 'competent';
  if (score >= 20) return 'noise';
  return 'losing';
}

/**
 * Detect blowup signatures from position history
 */
export function detectBlowupSignatures(positions: AccountPosition[]): BlowupFlag[] {
  const flags: BlowupFlag[] = [];

  if (positions.length < 3) return flags;

  // Sort by timestamp
  const sorted = [...positions].sort((a, b) => a.entryTimestamp - b.entryTimestamp);

  // Detect MARTINGALE: Doubling down after losses
  let consecutiveLosses = 0;
  let previousSize = 0;
  for (const p of sorted) {
    if (p.pnl < 0) {
      consecutiveLosses++;
      if (consecutiveLosses >= 2 && p.size > previousSize * 1.5) {
        flags.push('MARTINGALE');
        break;
      }
    } else {
      consecutiveLosses = 0;
    }
    previousSize = p.size;
  }

  // Detect REVENGE_TRADING: Many trades in short time after loss
  for (let i = 0; i < sorted.length - 3; i++) {
    const pos = sorted[i];
    if (!pos || pos.pnl >= 0) continue;

    // Check if next 3 trades are within 1 hour
    let rapidTrades = 0;
    for (let j = i + 1; j < Math.min(i + 4, sorted.length); j++) {
      const nextPos = sorted[j];
      if (!nextPos) continue;
      if (nextPos.entryTimestamp - pos.exitTimestamp < 60 * 60 * 1000) {
        rapidTrades++;
      }
    }
    if (rapidTrades >= 3) {
      if (!flags.includes('REVENGE_TRADING')) {
        flags.push('REVENGE_TRADING');
      }
      break;
    }
  }

  // Detect BLOWUP: Single position loss > 30% of portfolio
  const maxLoss = Math.max(...positions.map((p) => (p.pnl < 0 ? -p.pnl : 0)));
  const avgSize = positions.reduce((sum, p) => sum + p.size, 0) / positions.length;
  if (maxLoss > avgSize * 0.3) {
    flags.push('BLOWUP');
  }

  // Detect CONCENTRATION_RISK: > 50% in single category
  const categorySize: Record<string, number> = {};
  const totalSize = positions.reduce((sum, p) => sum + p.size, 0);
  for (const p of positions) {
    const cat = p.category || 'unknown';
    categorySize[cat] = (categorySize[cat] ?? 0) + p.size;
  }
  for (const cat of Object.keys(categorySize)) {
    if ((categorySize[cat] ?? 0) > totalSize * 0.5) {
      flags.push('CONCENTRATION_RISK');
      break;
    }
  }

  return [...new Set(flags)]; // Deduplicate
}

/**
 * Compute full skill score for an account
 */
export function computeAccountSkillScore(
  metrics: AccountMetrics,
  includeCLV = true
): SkillScoreResult {
  const { positions, totalFees, portfolioValue, accountCreatedAt, lastActivityAt, blowupFlags } =
    metrics;

  // Calculate gross profit
  const grossProfit = positions.filter((p) => p.pnl > 0).reduce((sum, p) => sum + p.pnl, 0);

  // Compute each factor
  const clvConsistency = scoreCLVConsistency(positions);
  const riskAdjustedReturns = scoreRiskAdjustedReturns(positions, portfolioValue);
  const sizingDiscipline = scoreSizingDiscipline(positions, portfolioValue);
  const ambiguityAvoidance = scoreAmbiguityAvoidance(positions);
  const lowFeeDrag = scoreLowFeeDrag(totalFees, grossProfit);
  const diversification = scoreDiversification(positions);
  const noBlowupSignatures = scoreNoBlowupSignatures(blowupFlags);
  const longevity = scoreLongevity(accountCreatedAt, lastActivityAt);

  // Adjust CLV weight if not including CLV
  let clvScore = includeCLV ? clvConsistency.score : 0;
  let adjustedRiskScore = riskAdjustedReturns.score;

  // If not including CLV, redistribute weight to risk-adjusted returns
  if (!includeCLV) {
    // CLV weight (25%) gets redistributed: 15% to risk-adjusted, 10% stays
    adjustedRiskScore = Math.min(35, riskAdjustedReturns.score * 1.75);
  }

  const totalScore =
    clvScore +
    (includeCLV ? riskAdjustedReturns.score : adjustedRiskScore) +
    sizingDiscipline.score +
    ambiguityAvoidance.score +
    lowFeeDrag.score +
    diversification.score +
    noBlowupSignatures.score +
    longevity.score;

  return {
    totalScore,
    tier: getTier(totalScore),
    factors: {
      clvConsistency: {
        score: clvScore,
        maxScore: 25,
        meanCLV: clvConsistency.meanCLV,
        validPositions: clvConsistency.validPositions,
      },
      riskAdjustedReturns: {
        score: includeCLV ? riskAdjustedReturns.score : adjustedRiskScore,
        maxScore: includeCLV ? 20 : 35,
        sharpe: riskAdjustedReturns.sharpe,
      },
      sizingDiscipline: {
        score: sizingDiscipline.score,
        maxScore: 15,
        maxPositionPct: sizingDiscipline.maxPositionPct,
      },
      ambiguityAvoidance: {
        score: ambiguityAvoidance.score,
        maxScore: 10,
        lowAmbiguityPct: ambiguityAvoidance.lowAmbiguityPct,
      },
      lowFeeDrag: {
        score: lowFeeDrag.score,
        maxScore: 5,
        feeDragPct: lowFeeDrag.feeDragPct,
      },
      diversification: {
        score: diversification.score,
        maxScore: 10,
        herfindahl: diversification.herfindahl,
      },
      noBlowupSignatures: {
        score: noBlowupSignatures.score,
        maxScore: 10,
        flagCount: noBlowupSignatures.flagCount,
      },
      longevity: {
        score: longevity.score,
        maxScore: 5,
        activeDays: longevity.activeDays,
      },
    },
    computedAt: new Date().toISOString(),
    includedCLV: includeCLV,
  };
}

/**
 * Check rank stability between CLV and non-CLV scores
 * Returns true if ranks are stable (< 5 position changes for < 20% of accounts)
 */
export function checkRankStability(
  accountsWithCLV: { accountId: string; score: number }[],
  accountsWithoutCLV: { accountId: string; score: number }[]
): { isStable: boolean; unstableAccountPct: number; maxRankChange: number } {
  if (accountsWithCLV.length !== accountsWithoutCLV.length) {
    throw new Error('Account lists must have same length');
  }

  // Sort both by score to get ranks
  const ranksWithCLV = new Map<string, number>();
  const ranksWithoutCLV = new Map<string, number>();

  [...accountsWithCLV]
    .sort((a, b) => b.score - a.score)
    .forEach((a, i) => ranksWithCLV.set(a.accountId, i + 1));

  [...accountsWithoutCLV]
    .sort((a, b) => b.score - a.score)
    .forEach((a, i) => ranksWithoutCLV.set(a.accountId, i + 1));

  // Count accounts with rank change > 5
  let unstableCount = 0;
  let maxRankChange = 0;

  for (const account of accountsWithCLV) {
    const rankWithCLV = ranksWithCLV.get(account.accountId) ?? 0;
    const rankWithoutCLV = ranksWithoutCLV.get(account.accountId) ?? 0;
    const rankChange = Math.abs(rankWithCLV - rankWithoutCLV);

    if (rankChange > 5) {
      unstableCount++;
    }
    maxRankChange = Math.max(maxRankChange, rankChange);
  }

  const unstableAccountPct = (unstableCount / accountsWithCLV.length) * 100;
  const isStable = unstableAccountPct < 20;

  return { isStable, unstableAccountPct, maxRankChange };
}
