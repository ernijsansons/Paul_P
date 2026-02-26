/**
 * Paul P - Capital Allocation (P-18)
 *
 * Initial live capital allocation per blueprint:
 * - Bonding: $500 (enabled immediately)
 * - Weather: $300 (enabled immediately)
 * - Others: $0 (enabled after 2 weeks of successful live trading)
 */

export type StrategyType = 'bonding' | 'weather' | 'xv_signal' | 'smart_money' | 'resolution';

export interface CapitalAllocation {
  strategy: StrategyType;
  capital: number;
  maxPositionPct: number;
  enabled: boolean;
  enableAfterDays?: number; // Days of successful trading before enabling
}

/**
 * Initial live capital allocation
 */
export const LIVE_ALLOCATION: Record<StrategyType, CapitalAllocation> = {
  bonding: {
    strategy: 'bonding',
    capital: 500,
    maxPositionPct: 5,
    enabled: true,
  },
  weather: {
    strategy: 'weather',
    capital: 300,
    maxPositionPct: 5,
    enabled: true,
  },
  xv_signal: {
    strategy: 'xv_signal',
    capital: 200,
    maxPositionPct: 5,
    enabled: false,
    enableAfterDays: 14, // 2 weeks of successful live trading
  },
  smart_money: {
    strategy: 'smart_money',
    capital: 200,
    maxPositionPct: 5,
    enabled: false,
    enableAfterDays: 14,
  },
  resolution: {
    strategy: 'resolution',
    capital: 100,
    maxPositionPct: 3, // Lower due to LLM uncertainty
    enabled: false,
    enableAfterDays: 14,
  },
};

/**
 * Get allocation for a strategy
 */
export function getAllocation(strategy: StrategyType): CapitalAllocation {
  return LIVE_ALLOCATION[strategy];
}

/**
 * Check if strategy can be enabled based on live trading history
 */
export function canEnableStrategy(
  strategy: StrategyType,
  firstLiveTradeDate: Date | null,
  successfulDays: number
): boolean {
  const allocation = LIVE_ALLOCATION[strategy];

  if (allocation.enabled) return true;
  if (!allocation.enableAfterDays) return false;
  if (!firstLiveTradeDate) return false;

  const daysSinceFirst = Math.floor(
    (Date.now() - firstLiveTradeDate.getTime()) / (24 * 60 * 60 * 1000)
  );

  return daysSinceFirst >= allocation.enableAfterDays && successfulDays >= allocation.enableAfterDays;
}

/**
 * Calculate position size for a trade
 */
export function calculatePositionSize(
  strategy: StrategyType,
  kellyFraction: number,
  currentCapital?: number
): number {
  const allocation = LIVE_ALLOCATION[strategy];
  const capital = currentCapital ?? allocation.capital;

  // Apply max position constraint
  const maxPosition = capital * (allocation.maxPositionPct / 100);

  // Kelly sizing with cap
  const kellyPosition = capital * kellyFraction;

  return Math.min(kellyPosition, maxPosition);
}

/**
 * Get total initial capital across all enabled strategies
 */
export function getTotalInitialCapital(): number {
  return Object.values(LIVE_ALLOCATION)
    .filter(a => a.enabled)
    .reduce((sum, a) => sum + a.capital, 0);
}

/**
 * Get capital breakdown summary
 */
export function getCapitalBreakdown(): {
  total: number;
  byStrategy: Record<StrategyType, number>;
  enabledStrategies: StrategyType[];
  pendingStrategies: StrategyType[];
} {
  const byStrategy: Record<StrategyType, number> = {
    bonding: 0,
    weather: 0,
    xv_signal: 0,
    smart_money: 0,
    resolution: 0,
  };

  const enabledStrategies: StrategyType[] = [];
  const pendingStrategies: StrategyType[] = [];
  let total = 0;

  for (const [strategy, allocation] of Object.entries(LIVE_ALLOCATION) as Array<[StrategyType, CapitalAllocation]>) {
    if (allocation.enabled) {
      byStrategy[strategy] = allocation.capital;
      total += allocation.capital;
      enabledStrategies.push(strategy);
    } else {
      pendingStrategies.push(strategy);
    }
  }

  return {
    total,
    byStrategy,
    enabledStrategies,
    pendingStrategies,
  };
}

/**
 * Validate allocation constraints
 */
export function validateAllocation(
  strategy: StrategyType,
  proposedSize: number,
  currentCapital: number
): { valid: boolean; reason?: string } {
  const allocation = LIVE_ALLOCATION[strategy];

  if (!allocation.enabled) {
    return { valid: false, reason: 'Strategy not enabled for live trading' };
  }

  const maxPosition = currentCapital * (allocation.maxPositionPct / 100);

  if (proposedSize > maxPosition) {
    return {
      valid: false,
      reason: `Position ${proposedSize} exceeds max ${maxPosition} (${allocation.maxPositionPct}% of ${currentCapital})`,
    };
  }

  if (proposedSize > currentCapital) {
    return {
      valid: false,
      reason: `Position ${proposedSize} exceeds available capital ${currentCapital}`,
    };
  }

  return { valid: true };
}
