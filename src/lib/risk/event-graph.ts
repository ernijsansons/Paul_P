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
 * Get markets correlated to a target market from the Event Graph
 *
 * Uses both direct edges and cached correlation scores.
 * Falls back gracefully if Event Graph data is unavailable.
 */
export async function getCorrelatedMarkets(
  env: Env,
  targetMarketId: string
): Promise<CorrelatedMarket[]> {
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
    // Fail gracefully - if Event Graph is unavailable, return empty
    console.warn('Event Graph query failed, returning no correlations:', error);
    return [];
  }

  return correlated;
}

/**
 * Compute total correlated exposure for a market
 *
 * This is used by I3 (Max Market Exposure) invariant to compute
 * total effective exposure including correlated markets.
 */
export async function computeCorrelatedExposure(
  env: Env,
  targetMarketId: string,
  targetSize: number,
  existingPositions: Array<{ marketId: string; size: number }>
): Promise<CorrelatedExposure> {
  // Get correlated markets
  const correlatedMarkets = await getCorrelatedMarkets(env, targetMarketId);

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
    directExposure: Math.abs(directExposure),
    correlatedExposure,
    totalEffectiveExposure: Math.abs(directExposure) + correlatedExposure,
    correlatedMarkets: correlatedDetails,
  };
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
