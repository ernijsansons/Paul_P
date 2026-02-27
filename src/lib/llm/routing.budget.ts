/**
 * Paul P - LLM Routing Budget
 *
 * Budget enforcement plus deterministic cost projection from explicit assumptions.
 */

import type { ResearchEnv } from '../../types/env';
import type {
  BudgetCategory,
  BudgetCheckResult,
  BudgetEnvelope,
  BudgetProjection,
  BudgetState,
  LLMBudgetAssumptions,
  LLMRoutingClass,
} from './routing.types';
import {
  computeEstimatedCost,
  getDefaultModelIdForRouteClass,
} from './routing.manifest';
import { deterministicId } from '../utils/deterministic-id';

// ============================================================
// ASSUMPTION-DRIVEN PROJECTION
// ============================================================

const ALERT_THRESHOLDS: Record<BudgetCategory, number> = {
  research_scoring: 80,
  trading_validation: 70,
  ingestion_classification: 80,
  governance_audit: 90,
};

/**
 * Default assumptions for monthly projection.
 * Values are policy assumptions, not fixed spend limits.
 */
export const DEFAULT_BUDGET_ASSUMPTIONS: LLMBudgetAssumptions = {
  callsPerDay: 3200,
  daysPerMonth: 30,
  routeMix: {
    deterministic_hard_control: 0,
    premium_cognition: 0.2,
    scanner_fastpath: 0.45,
    synthesis_long_context: 0.1,
    cheap_enrichment: 0.25,
  },
  categoryMix: {
    research_scoring: 0.4,
    trading_validation: 0.25,
    ingestion_classification: 0.25,
    governance_audit: 0.1,
  },
  avgInputTokensByRouteClass: {
    deterministic_hard_control: 0,
    premium_cognition: 2500,
    scanner_fastpath: 900,
    synthesis_long_context: 3200,
    cheap_enrichment: 1200,
  },
  avgOutputTokensByRouteClass: {
    deterministic_hard_control: 0,
    premium_cognition: 700,
    scanner_fastpath: 220,
    synthesis_long_context: 950,
    cheap_enrichment: 280,
  },
  retryRate: 0.05,
  cacheHitRate: 0.25,
  safetyMultiplier: 1.35,
};

function validateAssumptions(assumptions: LLMBudgetAssumptions): void {
  const routeMixSum = Object.values(assumptions.routeMix).reduce((sum, value) => sum + value, 0);
  const categoryMixSum = Object.values(assumptions.categoryMix).reduce((sum, value) => sum + value, 0);
  if (Math.abs(routeMixSum - 1) > 0.0001) {
    throw new Error(`routeMix must sum to 1.0, received ${routeMixSum.toFixed(4)}`);
  }
  if (Math.abs(categoryMixSum - 1) > 0.0001) {
    throw new Error(`categoryMix must sum to 1.0, received ${categoryMixSum.toFixed(4)}`);
  }
}

export function projectBudgetFromAssumptions(
  assumptions: LLMBudgetAssumptions
): BudgetProjection {
  validateAssumptions(assumptions);

  const routeClasses: LLMRoutingClass[] = [
    'deterministic_hard_control',
    'premium_cognition',
    'scanner_fastpath',
    'synthesis_long_context',
    'cheap_enrichment',
  ];

  const byRouteClass = routeClasses.map((routeClass) => {
    const routeShare = assumptions.routeMix[routeClass];
    const callsPerDay = assumptions.callsPerDay * routeShare * (1 + assumptions.retryRate);
    const inputTokens = callsPerDay * assumptions.avgInputTokensByRouteClass[routeClass];
    const outputTokens = callsPerDay * assumptions.avgOutputTokensByRouteClass[routeClass];
    const cachedInputTokens = inputTokens * assumptions.cacheHitRate;
    const defaultModelId = getDefaultModelIdForRouteClass(routeClass);

    const projectedDailyCostUsd = defaultModelId
      ? computeEstimatedCost(defaultModelId, inputTokens, outputTokens, cachedInputTokens)
      : 0;
    const projectedMonthlyCostUsd =
      projectedDailyCostUsd * assumptions.daysPerMonth * assumptions.safetyMultiplier;

    return {
      routeClass,
      resolvedModelId: defaultModelId,
      callsPerDay,
      projectedDailyCostUsd,
      projectedMonthlyCostUsd,
    };
  });

  const projectedDailyCostUsd = byRouteClass.reduce(
    (sum, item) => sum + item.projectedDailyCostUsd,
    0
  ) * assumptions.safetyMultiplier;

  const projectedMonthlyCostUsd = projectedDailyCostUsd * assumptions.daysPerMonth;

  return {
    assumptions,
    projectedDailyCostUsd,
    projectedMonthlyCostUsd,
    byRouteClass,
  };
}

export function deriveBudgetEnvelopesFromAssumptions(
  assumptions: LLMBudgetAssumptions
): Record<BudgetCategory, BudgetEnvelope> {
  const projection = projectBudgetFromAssumptions(assumptions);

  const envelopes: Record<BudgetCategory, BudgetEnvelope> = {
    research_scoring: {
      category: 'research_scoring',
      dailyLimitUsd: projection.projectedDailyCostUsd * assumptions.categoryMix.research_scoring,
      monthlyLimitUsd:
        projection.projectedMonthlyCostUsd * assumptions.categoryMix.research_scoring,
      alertThresholdPct: ALERT_THRESHOLDS.research_scoring,
      hardCapPct: 100,
    },
    trading_validation: {
      category: 'trading_validation',
      dailyLimitUsd: projection.projectedDailyCostUsd * assumptions.categoryMix.trading_validation,
      monthlyLimitUsd:
        projection.projectedMonthlyCostUsd * assumptions.categoryMix.trading_validation,
      alertThresholdPct: ALERT_THRESHOLDS.trading_validation,
      hardCapPct: 100,
    },
    ingestion_classification: {
      category: 'ingestion_classification',
      dailyLimitUsd:
        projection.projectedDailyCostUsd * assumptions.categoryMix.ingestion_classification,
      monthlyLimitUsd:
        projection.projectedMonthlyCostUsd * assumptions.categoryMix.ingestion_classification,
      alertThresholdPct: ALERT_THRESHOLDS.ingestion_classification,
      hardCapPct: 100,
    },
    governance_audit: {
      category: 'governance_audit',
      dailyLimitUsd: projection.projectedDailyCostUsd * assumptions.categoryMix.governance_audit,
      monthlyLimitUsd:
        projection.projectedMonthlyCostUsd * assumptions.categoryMix.governance_audit,
      alertThresholdPct: ALERT_THRESHOLDS.governance_audit,
      hardCapPct: 100,
    },
  };

  return envelopes;
}

const BUDGET_ENVELOPES: Record<BudgetCategory, BudgetEnvelope> =
  deriveBudgetEnvelopesFromAssumptions(DEFAULT_BUDGET_ASSUMPTIONS);

/**
 * Backward-compatible alias.
 */
export function deriveBudgetsFromAssumptions(
  assumptions: LLMBudgetAssumptions
): Record<BudgetCategory, BudgetEnvelope> {
  return deriveBudgetEnvelopesFromAssumptions(assumptions);
}

// ============================================================
// ENFORCEMENT HELPERS
// ============================================================

function getPeriodStart(date: Date, periodType: 'daily' | 'monthly'): string {
  if (periodType === 'daily') {
    const day = date.toISOString().split('T')[0];
    return day ?? date.toISOString().slice(0, 10);
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

function getDaysInMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

export async function getBudgetState(
  env: ResearchEnv,
  category: BudgetCategory,
  periodType: 'daily' | 'monthly'
): Promise<BudgetState> {
  const now = new Date();
  const periodStart = getPeriodStart(now, periodType);
  const envelope = BUDGET_ENVELOPES[category];
  const limitUsd = periodType === 'daily' ? envelope.dailyLimitUsd : envelope.monthlyLimitUsd;

  const row = await env.DB.prepare(
    `
    SELECT COALESCE(SUM(cost_usd), 0) as consumed
    FROM llm_budget_usage
    WHERE category = ? AND period_start = ? AND period_type = ?
  `
  )
    .bind(category, periodStart, periodType)
    .first<{ consumed: number }>();

  const consumedUsd = row?.consumed ?? 0;
  const remainingUsd = Math.max(0, limitUsd - consumedUsd);
  const percentUsed = limitUsd > 0 ? (consumedUsd / limitUsd) * 100 : 0;

  return {
    category,
    periodStart,
    periodType,
    limitUsd,
    consumedUsd,
    remainingUsd,
    percentUsed,
    isBlocked: percentUsed >= envelope.hardCapPct,
    lastUpdated: now.toISOString(),
  };
}

export async function checkBudget(
  env: ResearchEnv,
  category: BudgetCategory,
  projectedCostUsd: number
): Promise<BudgetCheckResult> {
  const envelope = BUDGET_ENVELOPES[category];
  const dailyState = await getBudgetState(env, category, 'daily');
  if (dailyState.isBlocked || dailyState.consumedUsd + projectedCostUsd > dailyState.limitUsd) {
    return {
      allowed: false,
      reason: `Daily budget exceeded for ${category}`,
      dailyState,
    };
  }

  const monthlyState = await getBudgetState(env, category, 'monthly');
  if (
    monthlyState.isBlocked ||
    monthlyState.consumedUsd + projectedCostUsd > monthlyState.limitUsd
  ) {
    return {
      allowed: false,
      reason: `Monthly budget exceeded for ${category}`,
      dailyState,
      monthlyState,
    };
  }

  return {
    allowed: true,
    reason: 'Budget available',
    shouldAlert:
      dailyState.percentUsed >= envelope.alertThresholdPct ||
      monthlyState.percentUsed >= envelope.alertThresholdPct,
    dailyState,
    monthlyState,
  };
}

export async function recordUsage(
  env: ResearchEnv,
  category: BudgetCategory,
  costUsd: number
): Promise<void> {
  const now = new Date();
  const timestamp = now.toISOString();
  const dailyPeriod = getPeriodStart(now, 'daily');
  const monthlyPeriod = getPeriodStart(now, 'monthly');
  const baseId = deterministicId('llm-usage', category, timestamp, String(costUsd));

  await env.DB.prepare(
    `
    INSERT INTO llm_budget_usage (id, category, period_start, period_type, cost_usd, timestamp)
    VALUES (?, ?, ?, 'daily', ?, ?)
  `
  )
    .bind(`${baseId}-d`, category, dailyPeriod, costUsd, timestamp)
    .run();

  await env.DB.prepare(
    `
    INSERT INTO llm_budget_usage (id, category, period_start, period_type, cost_usd, timestamp)
    VALUES (?, ?, ?, 'monthly', ?, ?)
  `
  )
    .bind(`${baseId}-m`, category, monthlyPeriod, costUsd, timestamp)
    .run();
}

// ============================================================
// OPERATIONS / ADMIN
// ============================================================

export async function getAllBudgetStates(
  env: ResearchEnv
): Promise<Record<BudgetCategory, { daily: BudgetState; monthly: BudgetState }>> {
  return {
    research_scoring: {
      daily: await getBudgetState(env, 'research_scoring', 'daily'),
      monthly: await getBudgetState(env, 'research_scoring', 'monthly'),
    },
    trading_validation: {
      daily: await getBudgetState(env, 'trading_validation', 'daily'),
      monthly: await getBudgetState(env, 'trading_validation', 'monthly'),
    },
    ingestion_classification: {
      daily: await getBudgetState(env, 'ingestion_classification', 'daily'),
      monthly: await getBudgetState(env, 'ingestion_classification', 'monthly'),
    },
    governance_audit: {
      daily: await getBudgetState(env, 'governance_audit', 'daily'),
      monthly: await getBudgetState(env, 'governance_audit', 'monthly'),
    },
  };
}

/**
 * Runtime usage-rate projection for one category.
 * Kept for operations visibility.
 */
export async function projectCosts(
  env: ResearchEnv,
  category: BudgetCategory
): Promise<{
  dailyProjection: number;
  monthlyProjection: number;
  willExceedDaily: boolean;
  willExceedMonthly: boolean;
}> {
  const now = new Date();
  const envelope = BUDGET_ENVELOPES[category];
  const dailyState = await getBudgetState(env, category, 'daily');
  const monthlyState = await getBudgetState(env, category, 'monthly');

  const hoursElapsed = now.getUTCHours() + now.getUTCMinutes() / 60;
  const dailyProjection = hoursElapsed > 0 ? (dailyState.consumedUsd / hoursElapsed) * 24 : 0;

  const dayOfMonth = now.getUTCDate();
  const daysInMonth = getDaysInMonth(now);
  const monthlyProjection = dayOfMonth > 0 ? (monthlyState.consumedUsd / dayOfMonth) * daysInMonth : 0;

  return {
    dailyProjection,
    monthlyProjection,
    willExceedDaily: dailyProjection > envelope.dailyLimitUsd,
    willExceedMonthly: monthlyProjection > envelope.monthlyLimitUsd,
  };
}

export async function getTotalSpending(
  env: ResearchEnv,
  periodType: 'daily' | 'monthly'
): Promise<{ total: number; byCategory: Record<BudgetCategory, number> }> {
  const periodStart = getPeriodStart(new Date(), periodType);
  const rows = await env.DB.prepare(
    `
    SELECT category, SUM(cost_usd) as total
    FROM llm_budget_usage
    WHERE period_start = ? AND period_type = ?
    GROUP BY category
  `
  )
    .bind(periodStart, periodType)
    .all<{ category: string; total: number }>();

  const byCategory: Record<BudgetCategory, number> = {
    research_scoring: 0,
    trading_validation: 0,
    ingestion_classification: 0,
    governance_audit: 0,
  };

  let total = 0;
  for (const row of rows.results ?? []) {
    const category = row.category as BudgetCategory;
    if (category in byCategory) {
      byCategory[category] = row.total;
      total += row.total;
    }
  }

  return { total, byCategory };
}

export function getBudgetEnvelope(category: BudgetCategory): BudgetEnvelope {
  return BUDGET_ENVELOPES[category];
}

export function getAllBudgetEnvelopes(): Record<BudgetCategory, BudgetEnvelope> {
  return { ...BUDGET_ENVELOPES };
}

export function getTotalBudgetLimits(): { dailyTotal: number; monthlyTotal: number } {
  const all = Object.values(BUDGET_ENVELOPES);
  return {
    dailyTotal: all.reduce((sum, value) => sum + value.dailyLimitUsd, 0),
    monthlyTotal: all.reduce((sum, value) => sum + value.monthlyLimitUsd, 0),
  };
}

export async function resetBudgetUsage(
  env: ResearchEnv,
  category: BudgetCategory,
  periodType: 'daily' | 'monthly'
): Promise<void> {
  const periodStart = getPeriodStart(new Date(), periodType);
  await env.DB.prepare(
    `
    DELETE FROM llm_budget_usage
    WHERE category = ? AND period_start = ? AND period_type = ?
  `
  )
    .bind(category, periodStart, periodType)
    .run();
}
