/**
 * Paul P - Barbell Allocation Strategy (P-09, P-18)
 *
 * Barbell allocation: 90% bonds / 10% tails
 *
 * Bond side: High-probability markets (p_yes > 93%)
 * Tail side: Event hedges, regime tails, diversifiers
 *
 * Tail Types (P-18):
 * - event_hedge: Minimum 30% of tail allocation
 * - regime_tail: Macro/systematic risk bets
 * - diversifier: Uncorrelated opportunities
 */

export type TailType = 'event_hedge' | 'regime_tail' | 'diversifier';

export interface BondPosition {
  marketId: string;
  venue: string;
  probability: number; // Current p_yes
  allocation: number; // Dollar amount
  expectedReturn: number; // Annual yield equivalent
}

export interface TailPosition {
  marketId: string;
  venue: string;
  tailType: TailType;
  probability: number;
  allocation: number;
  maxLoss: number; // Maximum loss if tail hits
  payoffMultiple: number; // Potential payoff multiple
}

export interface BarbellAllocation {
  totalCapital: number;
  bondAllocation: number; // 90%
  tailAllocation: number; // 10%
  bondPositions: BondPosition[];
  tailPositions: TailPosition[];
  herfindahlIndex: number; // Concentration measure
  eventHedgePct: number; // % of tail in event_hedge
  isValid: boolean;
  validationErrors: string[];
}

export interface BarbellConfig {
  bondPct: number; // Default 90
  tailPct: number; // Default 10
  minBondProbability: number; // Minimum p_yes for bonds (default 0.93)
  minEventHedgePct: number; // Minimum event_hedge allocation (default 30%)
  maxHerfindahl: number; // Maximum concentration (default 0.25)
  maxSingleBondPct: number; // Max single bond as % of bond allocation (default 20%)
  maxSingleTailPct: number; // Max single tail as % of tail allocation (default 40%)
}

const DEFAULT_CONFIG: BarbellConfig = {
  bondPct: 90,
  tailPct: 10,
  minBondProbability: 0.93,
  minEventHedgePct: 30,
  maxHerfindahl: 0.25,
  maxSingleBondPct: 20,
  maxSingleTailPct: 40,
};

/**
 * Calculate Herfindahl index for concentration
 * Lower is more diversified (0 = perfect diversification, 1 = single position)
 */
export function calculateHerfindahl(allocations: number[]): number {
  const total = allocations.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  return allocations.reduce((sum, alloc) => {
    const share = alloc / total;
    return sum + share * share;
  }, 0);
}

/**
 * Filter markets suitable for bond positions
 * Kalshi-only, p_yes > 93%
 */
export function filterBondCandidates(
  markets: Array<{
    marketId: string;
    venue: string;
    probability: number;
    volume24h: number;
    spread: number;
  }>,
  config: Partial<BarbellConfig> = {}
): Array<{
  marketId: string;
  venue: string;
  probability: number;
  volume24h: number;
  spread: number;
  expectedYield: number;
}> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return markets
    .filter(m =>
      m.venue === 'kalshi' &&
      m.probability >= cfg.minBondProbability &&
      m.spread < 0.05 && // Max 5% spread for bonds
      m.volume24h > 1000 // Minimum liquidity
    )
    .map(m => ({
      ...m,
      // Expected yield: if we buy YES at p, we make (1-p)/p return
      expectedYield: (1 - m.probability) / m.probability,
    }))
    .sort((a, b) => b.expectedYield - a.expectedYield); // Sort by yield desc
}

/**
 * Categorize tail opportunities
 */
export function categorizeTail(
  market: {
    marketId: string;
    category?: string;
    tags?: string[];
    description?: string;
  }
): TailType {
  const category = market.category?.toLowerCase() ?? '';
  const tags = market.tags?.map(t => t.toLowerCase()) ?? [];
  const desc = market.description?.toLowerCase() ?? '';

  // Event hedge: disaster, war, crisis, default, collapse
  const eventHedgeKeywords = ['war', 'crisis', 'default', 'collapse', 'disaster', 'emergency', 'shutdown'];
  if (eventHedgeKeywords.some(k => desc.includes(k) || tags.includes(k))) {
    return 'event_hedge';
  }

  // Regime tail: macro, fed, interest rate, recession, inflation
  const regimeKeywords = ['fed', 'interest rate', 'recession', 'inflation', 'gdp', 'unemployment', 'macro'];
  if (regimeKeywords.some(k => desc.includes(k) || tags.includes(k) || category.includes(k))) {
    return 'regime_tail';
  }

  // Default to diversifier
  return 'diversifier';
}

/**
 * Allocate capital using barbell strategy
 */
export function allocateBarbell(
  capital: number,
  bondCandidates: Array<{
    marketId: string;
    venue: string;
    probability: number;
    expectedYield: number;
  }>,
  tailCandidates: Array<{
    marketId: string;
    venue: string;
    probability: number;
    tailType: TailType;
    payoffMultiple: number;
  }>,
  config: Partial<BarbellConfig> = {}
): BarbellAllocation {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const errors: string[] = [];

  const bondAllocation = capital * (cfg.bondPct / 100);
  const tailAllocation = capital * (cfg.tailPct / 100);

  // Allocate bonds
  const bondPositions: BondPosition[] = [];
  let remainingBondCapital = bondAllocation;
  const maxSingleBond = bondAllocation * (cfg.maxSingleBondPct / 100);

  for (const bond of bondCandidates) {
    if (remainingBondCapital <= 0) break;

    const allocation = Math.min(remainingBondCapital, maxSingleBond);
    bondPositions.push({
      marketId: bond.marketId,
      venue: bond.venue,
      probability: bond.probability,
      allocation,
      expectedReturn: bond.expectedYield,
    });
    remainingBondCapital -= allocation;
  }

  // Allocate tails - ensure event_hedge minimum
  const tailPositions: TailPosition[] = [];
  let remainingTailCapital = tailAllocation;
  const maxSingleTail = tailAllocation * (cfg.maxSingleTailPct / 100);
  const minEventHedgeAmount = tailAllocation * (cfg.minEventHedgePct / 100);

  // First allocate event hedges
  const eventHedges = tailCandidates.filter(t => t.tailType === 'event_hedge');
  const otherTails = tailCandidates.filter(t => t.tailType !== 'event_hedge');

  let eventHedgeAllocated = 0;
  for (const hedge of eventHedges) {
    if (remainingTailCapital <= 0) break;
    if (eventHedgeAllocated >= minEventHedgeAmount && eventHedges.length > 1) {
      // We've met minimum, can be more selective
    }

    const allocation = Math.min(remainingTailCapital, maxSingleTail);
    tailPositions.push({
      marketId: hedge.marketId,
      venue: hedge.venue,
      tailType: hedge.tailType,
      probability: hedge.probability,
      allocation,
      maxLoss: allocation,
      payoffMultiple: hedge.payoffMultiple,
    });
    remainingTailCapital -= allocation;
    eventHedgeAllocated += allocation;
  }

  // Then allocate other tails
  for (const tail of otherTails) {
    if (remainingTailCapital <= 0) break;

    const allocation = Math.min(remainingTailCapital, maxSingleTail);
    tailPositions.push({
      marketId: tail.marketId,
      venue: tail.venue,
      tailType: tail.tailType,
      probability: tail.probability,
      allocation,
      maxLoss: allocation,
      payoffMultiple: tail.payoffMultiple,
    });
    remainingTailCapital -= allocation;
  }

  // Calculate metrics
  const allAllocations = [
    ...bondPositions.map(b => b.allocation),
    ...tailPositions.map(t => t.allocation),
  ];
  const herfindahlIndex = calculateHerfindahl(allAllocations);

  const eventHedgeTotal = tailPositions
    .filter(t => t.tailType === 'event_hedge')
    .reduce((sum, t) => sum + t.allocation, 0);
  const eventHedgePct = tailAllocation > 0 ? (eventHedgeTotal / tailAllocation) * 100 : 0;

  // Validation
  if (herfindahlIndex > cfg.maxHerfindahl) {
    errors.push(`Herfindahl index ${herfindahlIndex.toFixed(3)} exceeds max ${cfg.maxHerfindahl}`);
  }

  if (eventHedgePct < cfg.minEventHedgePct && tailCandidates.length > 0) {
    errors.push(`Event hedge ${eventHedgePct.toFixed(1)}% below min ${cfg.minEventHedgePct}%`);
  }

  if (bondPositions.length === 0) {
    errors.push('No bond positions allocated');
  }

  return {
    totalCapital: capital,
    bondAllocation,
    tailAllocation,
    bondPositions,
    tailPositions,
    herfindahlIndex,
    eventHedgePct,
    isValid: errors.length === 0,
    validationErrors: errors,
  };
}

/**
 * Validate barbell allocation against rules
 */
export function validateBarbellAllocation(
  allocation: BarbellAllocation,
  config: Partial<BarbellConfig> = {}
): { valid: boolean; errors: string[] } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const errors: string[] = [];

  // Check bond/tail ratio
  const actualBondPct = (allocation.bondAllocation / allocation.totalCapital) * 100;
  if (Math.abs(actualBondPct - cfg.bondPct) > 1) {
    errors.push(`Bond allocation ${actualBondPct.toFixed(1)}% differs from target ${cfg.bondPct}%`);
  }

  // Check concentration
  if (allocation.herfindahlIndex > cfg.maxHerfindahl) {
    errors.push(`Portfolio too concentrated: HHI ${allocation.herfindahlIndex.toFixed(3)} > ${cfg.maxHerfindahl}`);
  }

  // Check event hedge minimum
  if (allocation.eventHedgePct < cfg.minEventHedgePct) {
    errors.push(`Insufficient event hedge: ${allocation.eventHedgePct.toFixed(1)}% < ${cfg.minEventHedgePct}%`);
  }

  // Check bond probability
  const lowProbBonds = allocation.bondPositions.filter(b => b.probability < cfg.minBondProbability);
  if (lowProbBonds.length > 0) {
    errors.push(`${lowProbBonds.length} bonds below min probability ${cfg.minBondProbability}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Calculate portfolio expected return
 */
export function calculateExpectedReturn(allocation: BarbellAllocation): {
  bondReturn: number;
  tailReturn: number;
  totalReturn: number;
  maxDrawdown: number;
} {
  // Bond expected return
  const bondReturn = allocation.bondPositions.reduce((sum, b) => {
    return sum + b.allocation * b.expectedReturn;
  }, 0);

  // Tail expected return (negative expected value but positive convexity)
  // Assume 10% chance of tail hitting on average
  const tailReturn = allocation.tailPositions.reduce((sum, t) => {
    const expectedValue = 0.1 * t.allocation * t.payoffMultiple - 0.9 * t.allocation;
    return sum + expectedValue;
  }, 0);

  // Total expected return
  const totalReturn = bondReturn + tailReturn;

  // Max drawdown: if all tails lose and some bonds fail
  // Conservative: 10% bond failure rate + all tail losses
  const maxBondLoss = allocation.bondPositions.reduce((sum, b) => sum + b.allocation, 0) * 0.1;
  const maxTailLoss = allocation.tailPositions.reduce((sum, t) => sum + t.maxLoss, 0);
  const maxDrawdown = (maxBondLoss + maxTailLoss) / allocation.totalCapital;

  return {
    bondReturn,
    tailReturn,
    totalReturn,
    maxDrawdown,
  };
}
