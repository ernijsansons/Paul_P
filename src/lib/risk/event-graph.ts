/**
 * Paul P - Event Graph Integration for Risk Checks (P-06)
 *
 * Provides correlation data for invariant I3 (Max Market Exposure)
 * which includes exposure to correlated markets based on Event Graph edges.
 */

import type { Env } from '../../types/env';

/**
 * Correlated market with correlation strength
 */
export interface CorrelatedMarket {
  marketId: string;
  correlationScore: number; // 0.0 to 1.0
  correlationType: string;  // edge_type from event_graph_edges
}

/**
 * Result of a correlation lookup - fail-closed pattern
 */
export interface CorrelationLookupResult {
  success: boolean;
  correlatedMarkets: CorrelatedMarket[];
  error?: string;
  errorCode?: 'DB_ERROR' | 'PARSE_ERROR' | 'TIMEOUT';
}

/**
 * Portfolio exposure including correlated markets
 */
export interface CorrelatedExposure {
  directExposure: number;         // Size in the target market
  correlatedExposure: number;     // Weighted sum of correlated market exposures
  totalEffectiveExposure: number; // directExposure + correlatedExposure
  correlatedMarkets: Array<{
    marketId: string;
    size: number;
    correlationScore: number;
    weightedContribution: number;
  }>;
}

/**
 * Get markets correlated to a target market from the Event Graph (FAIL-CLOSED)
 *
 * Uses both direct edges and cached correlation scores.
 * Returns a result object with success flag - callers MUST check success before using data.
 *
 * FAIL-CLOSED BEHAVIOR: If lookup fails, success=false is returned.
 * Callers should BLOCK execution when success=false to prevent
 * undetected correlation risk from accumulating.
 */
export async function getCorrelatedMarketsWithStatus(
  env: Env,
  targetMarketId: string
): Promise<CorrelationLookupResult> {
  const correlated: CorrelatedMarket[] = [];

  try {
    // 1. Check correlation cache first (precomputed scores)
    const cachedResults = await env.DB.prepare(`
      SELECT market_b_id as market_id, correlation_score, correlation_rules_applied
      FROM correlation_cache
      WHERE market_a_id = ? AND is_valid = 1 AND expires_at > datetime('now')
      UNION
      SELECT market_a_id as market_id, correlation_score, correlation_rules_applied
      FROM correlation_cache
      WHERE market_b_id = ? AND is_valid = 1 AND expires_at > datetime('now')
    `).bind(targetMarketId, targetMarketId).all<{
      market_id: string;
      correlation_score: number;
      correlation_rules_applied: string;
    }>();

    for (const row of cachedResults.results ?? []) {
      correlated.push({
        marketId: row.market_id,
        correlationScore: row.correlation_score,
        correlationType: 'cached',
      });
    }

    // 2. Check direct Event Graph edges
    const edgeResults = await env.DB.prepare(`
      SELECT e.target_node_id as node_id, e.edge_type, e.weight
      FROM event_graph_edges e
      JOIN event_graph_nodes n ON e.source_node_id = n.id
      WHERE n.id = ? OR n.label = ?
      UNION
      SELECT e.source_node_id as node_id, e.edge_type, e.weight
      FROM event_graph_edges e
      JOIN event_graph_nodes n ON e.target_node_id = n.id
      WHERE n.id = ? OR n.label = ?
    `).bind(targetMarketId, targetMarketId, targetMarketId, targetMarketId).all<{
      node_id: string;
      edge_type: string;
      weight: number;
    }>();

    // Process edges - only include market-to-market correlations
    for (const edge of edgeResults.results ?? []) {
      // Skip if already in cache
      if (correlated.some(c => c.marketId === edge.node_id)) {
        continue;
      }

      // Determine correlation strength based on edge type
      let correlationScore = edge.weight ?? 1.0;

      switch (edge.edge_type) {
        case 'correlated_with':
          // Direct correlation - use weight as-is
          break;
        case 'same_series':
          // Same series = high correlation
          correlationScore = Math.min(correlationScore, 0.8);
          break;
        case 'belongs_to_event':
        case 'tagged_with_topic':
          // Indirect correlation through shared event/topic
          correlationScore = Math.min(correlationScore, 0.5);
          break;
        case 'resolved_by_source':
        case 'occurs_in_window':
          // Same resolution source/time = moderate correlation
          correlationScore = Math.min(correlationScore, 0.6);
          break;
        default:
          correlationScore = Math.min(correlationScore, 0.3);
      }

      correlated.push({
        marketId: edge.node_id,
        correlationScore,
        correlationType: edge.edge_type,
      });
    }

    // 3. Check active correlation rules
    const ruleResults = await env.DB.prepare(`
      SELECT id, rule_type, market_selector, correlation_weight
      FROM correlation_rules
      WHERE is_active = 1
    `).all<{
      id: string;
      rule_type: string;
      market_selector: string;
      correlation_weight: number;
    }>();

    // Get target market details for rule matching
    const targetMarket = await env.DB.prepare(`
      SELECT category, series, venue FROM markets WHERE condition_id = ?
    `).bind(targetMarketId).first<{
      category: string | null;
      series: string | null;
      venue: string | null;
    }>();

    if (targetMarket) {
      for (const rule of ruleResults.results ?? []) {
        try {
          const selector = JSON.parse(rule.market_selector);

          // Find markets matching this rule
          let matchQuery = 'SELECT condition_id FROM markets WHERE condition_id != ?';
          const params: string[] = [targetMarketId];

          if (selector.category && targetMarket.category === selector.category) {
            matchQuery += ' AND category = ?';
            params.push(selector.category);
          } else if (selector.series && targetMarket.series === selector.series) {
            matchQuery += ' AND series = ?';
            params.push(selector.series);
          } else {
            continue; // Rule doesn't apply
          }

          matchQuery += ' LIMIT 50'; // Limit to prevent explosion

          const matchedMarkets = await env.DB.prepare(matchQuery)
            .bind(...params)
            .all<{ condition_id: string }>();

          for (const match of matchedMarkets.results ?? []) {
            if (!correlated.some(c => c.marketId === match.condition_id)) {
              correlated.push({
                marketId: match.condition_id,
                correlationScore: rule.correlation_weight,
                correlationType: rule.rule_type,
              });
            }
          }
        } catch {
          // Invalid selector JSON, skip
          continue;
        }
      }
    }

  } catch (error) {
    // FAIL-CLOSED: Return explicit failure status
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Event Graph query failed (FAIL-CLOSED):', errorMessage);
    return {
      success: false,
      correlatedMarkets: [],
      error: `Event Graph lookup failed: ${errorMessage}`,
      errorCode: 'DB_ERROR',
    };
  }

  return {
    success: true,
    correlatedMarkets: correlated,
  };
}

/**
 * Legacy wrapper for backward compatibility
 * @deprecated Use getCorrelatedMarketsWithStatus for fail-closed behavior
 */
export async function getCorrelatedMarkets(
  env: Env,
  targetMarketId: string
): Promise<CorrelatedMarket[]> {
  const result = await getCorrelatedMarketsWithStatus(env, targetMarketId);
  if (!result.success) {
    // Legacy behavior: log warning and return empty
    // WARNING: This is fail-open! Use getCorrelatedMarketsWithStatus instead.
    console.warn('[DEPRECATED] getCorrelatedMarkets called - this is fail-open behavior');
    return [];
  }
  return result.correlatedMarkets;
}

/**
 * Result of correlated exposure computation - fail-closed
 */
export interface CorrelatedExposureResult {
  success: boolean;
  exposure: CorrelatedExposure | null;
  error?: string;
}

/**
 * Compute total correlated exposure for a market (FAIL-CLOSED)
 *
 * This is used by I3 (Max Market Exposure) invariant to compute
 * total effective exposure including correlated markets.
 *
 * FAIL-CLOSED: If correlation lookup fails, returns success=false.
 * Callers MUST check success and BLOCK execution if false.
 */
export async function computeCorrelatedExposureWithStatus(
  env: Env,
  targetMarketId: string,
  targetSize: number,
  existingPositions: Array<{ marketId: string; size: number }>
): Promise<CorrelatedExposureResult> {
  // Get correlated markets with status
  const lookupResult = await getCorrelatedMarketsWithStatus(env, targetMarketId);

  if (!lookupResult.success) {
    return {
      success: false,
      exposure: null,
      error: lookupResult.error,
    };
  }

  const correlatedMarkets = lookupResult.correlatedMarkets;

  // Compute direct exposure (existing + new position)
  const existingTargetPosition = existingPositions.find(p => p.marketId === targetMarketId);
  const directExposure = (existingTargetPosition?.size ?? 0) + targetSize;

  // Compute weighted correlated exposure
  let correlatedExposure = 0;
  const correlatedDetails: CorrelatedExposure['correlatedMarkets'] = [];

  for (const correlated of correlatedMarkets) {
    const position = existingPositions.find(p => p.marketId === correlated.marketId);
    if (!position) continue;

    const weightedContribution = Math.abs(position.size) * correlated.correlationScore;
    correlatedExposure += weightedContribution;

    correlatedDetails.push({
      marketId: correlated.marketId,
      size: position.size,
      correlationScore: correlated.correlationScore,
      weightedContribution,
    });
  }

  return {
    success: true,
    exposure: {
      directExposure: Math.abs(directExposure),
      correlatedExposure,
      totalEffectiveExposure: Math.abs(directExposure) + correlatedExposure,
      correlatedMarkets: correlatedDetails,
    },
  };
}

/**
 * Legacy wrapper for backward compatibility
 * @deprecated Use computeCorrelatedExposureWithStatus for fail-closed behavior
 */
export async function computeCorrelatedExposure(
  env: Env,
  targetMarketId: string,
  targetSize: number,
  existingPositions: Array<{ marketId: string; size: number }>
): Promise<CorrelatedExposure> {
  const result = await computeCorrelatedExposureWithStatus(
    env,
    targetMarketId,
    targetSize,
    existingPositions
  );

  if (!result.success || !result.exposure) {
    // Legacy behavior: return zero exposure on failure
    // WARNING: This is fail-open! Use computeCorrelatedExposureWithStatus instead.
    console.warn('[DEPRECATED] computeCorrelatedExposure called - this is fail-open behavior');
    return {
      directExposure: Math.abs(targetSize),
      correlatedExposure: 0,
      totalEffectiveExposure: Math.abs(targetSize),
      correlatedMarkets: [],
    };
  }

  return result.exposure;
}

/**
 * Build a correlation rule selector JSON
 */
export function buildRuleSelector(criteria: {
  category?: string;
  series?: string;
  dataSource?: string;
  resolutionWindow?: string;
}): string {
  return JSON.stringify(criteria);
}
