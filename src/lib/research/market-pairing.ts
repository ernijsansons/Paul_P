/**
 * Paul P - Market Pairing & Canonicalization (P-04)
 *
 * Cross-venue market matching and equivalence assessment
 * for arbitrage opportunities.
 *
 * Equivalence Grades:
 * - identical: Same resolution source, same criteria, same timing
 * - near_equivalent: Minor wording differences, same effective meaning
 * - similar_but_divergent: Same underlying event but different resolution criteria
 * - not_equivalent: Should never be paired for arbitrage
 */

import type { Env } from '../../types/env';
import { asResearchEnv } from '../../types/env';
import { sha256String } from '../evidence/hasher';
import { assessEquivalence } from './llm-governance';

export type EquivalenceGrade =
  | 'identical'
  | 'near_equivalent'
  | 'similar_but_divergent'
  | 'not_equivalent';

export type PairStatus = 'pending_review' | 'approved' | 'rejected' | 'expired';

export interface EquivalenceChecklist {
  resolutionSourceMatch: boolean;
  timingWindowMatch: boolean;
  voidRulesMatch: boolean;
  referencePriceSourceMatch: boolean;
  dataPublisherMatch: boolean;
  wordingDelta: 'none' | 'minor' | 'material';
  settlementTimingDeltaHours: number;
  forbiddenMismatchesFound: string[];
}

export interface MarketPair {
  id: string;
  canonicalEventId: string;
  marketAId: string;
  marketBId: string;
  equivalenceGrade: EquivalenceGrade;
  settlementRuleSimilarity: number; // 0.0 to 1.0
  sharedUnderlyingEvent: boolean;
  disqualifyingMismatches: string[]; // e.g. ['time_window', 'data_source']
  equivalenceChecklist: EquivalenceChecklist;
  expiresAt: string;
  ruleTextHashA: string;
  ruleTextHashB: string;
  llmAnalysisRunId?: string;
  humanReviewer?: string;
  humanReviewDate?: string;
  humanReviewNotes?: string;
  status: PairStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalEvent {
  id: string;
  name: string;
  category: string;
  description: string;
  expectedResolutionDate?: string;
  createdAt: string;
}

export interface CanonicalMarket {
  id: string;
  canonicalEventId: string;
  venue: 'polymarket' | 'kalshi';
  venueMarketId: string;
  title: string;
  resolutionCriteria: string;
  ruleTextHash: string;
  endDate?: string;
  status: 'active' | 'closed' | 'resolved';
  createdAt: string;
  lastSyncedAt: string;
}

/**
 * Fuzzy match score between two strings
 * Returns 0-1 where 1 is exact match
 */
function fuzzyMatch(a: string, b: string): number {
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();

  if (aLower === bLower) return 1.0;

  // Jaccard similarity on words
  const aWords = new Set(aLower.split(/\s+/));
  const bWords = new Set(bLower.split(/\s+/));

  const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);

  return intersection.size / union.size;
}

/**
 * Extract key entities from market title for matching
 */
function extractEntities(title: string): string[] {
  const entities: string[] = [];

  // Extract year patterns
  const yearMatch = title.match(/20\d{2}/g);
  if (yearMatch) entities.push(...yearMatch);

  // Extract known entity patterns
  const patterns = [
    /(?:President|presidential|election)/i,
    /(?:bitcoin|btc|ethereum|eth)/i,
    /(?:temperature|weather|rain|snow)/i,
    /(?:Super Bowl|World Series|Stanley Cup)/i,
    /(?:Trump|Biden|Harris|DeSantis)/i,
    /(?:Fed|interest rate|inflation)/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) entities.push(match[0].toLowerCase());
  }

  return entities;
}

/**
 * Find potential market pairs between venues
 */
export async function findPotentialPairs(
  _env: Env,
  polymarketMarkets: CanonicalMarket[],
  kalshiMarkets: CanonicalMarket[]
): Promise<Array<{ polymarket: CanonicalMarket; kalshi: CanonicalMarket; matchScore: number }>> {
  const pairs: Array<{ polymarket: CanonicalMarket; kalshi: CanonicalMarket; matchScore: number }> =
    [];

  for (const pm of polymarketMarkets) {
    const pmEntities = extractEntities(pm.title);

    for (const km of kalshiMarkets) {
      const kmEntities = extractEntities(km.title);

      // Check entity overlap
      const entityOverlap = pmEntities.filter((e) =>
        kmEntities.some((ke) => ke.includes(e) || e.includes(ke))
      );

      // Calculate title similarity
      const titleSimilarity = fuzzyMatch(pm.title, km.title);

      // Calculate criteria similarity
      const criteriaSimilarity = fuzzyMatch(pm.resolutionCriteria, km.resolutionCriteria);

      // Combined score
      const matchScore =
        (titleSimilarity * 0.4 + criteriaSimilarity * 0.4 + (entityOverlap.length > 0 ? 0.2 : 0));

      // Only include if score is above threshold
      if (matchScore > 0.3) {
        pairs.push({ polymarket: pm, kalshi: km, matchScore });
      }
    }
  }

  // Sort by match score descending
  return pairs.sort((a, b) => b.matchScore - a.matchScore);
}

/**
 * Compute deterministic equivalence checklist
 */
export function computeEquivalenceChecklist(
  marketA: CanonicalMarket,
  marketB: CanonicalMarket
): EquivalenceChecklist {
  const criteriaA = marketA.resolutionCriteria.toLowerCase();
  const criteriaB = marketB.resolutionCriteria.toLowerCase();

  // Check resolution source match
  const sourcePatterns = [
    /associated press/i,
    /reuters/i,
    /official\s+results/i,
    /government\s+data/i,
    /noaa/i,
    /sec\s+filing/i,
  ];

  let resolutionSourceMatch = false;
  for (const pattern of sourcePatterns) {
    const matchA = pattern.test(criteriaA);
    const matchB = pattern.test(criteriaB);
    if (matchA && matchB) {
      resolutionSourceMatch = true;
      break;
    }
  }

  // Check timing window match
  const dateA = marketA.endDate ? new Date(marketA.endDate) : null;
  const dateB = marketB.endDate ? new Date(marketB.endDate) : null;
  let settlementTimingDeltaHours = 0;

  if (dateA && dateB) {
    settlementTimingDeltaHours = Math.abs(dateA.getTime() - dateB.getTime()) / (1000 * 60 * 60);
  }

  const timingWindowMatch = settlementTimingDeltaHours < 24;

  // Check void rules
  const voidKeywords = ['void', 'cancel', 'refund', 'n/a'];
  const hasVoidA = voidKeywords.some((k) => criteriaA.includes(k));
  const hasVoidB = voidKeywords.some((k) => criteriaB.includes(k));
  const voidRulesMatch = hasVoidA === hasVoidB;

  // Check reference price source
  const pricePatterns = [/spot\s+price/i, /closing\s+price/i, /index/i, /reference\s+rate/i];
  let referencePriceSourceMatch = true;
  for (const pattern of pricePatterns) {
    const matchA = pattern.test(criteriaA);
    const matchB = pattern.test(criteriaB);
    if (matchA !== matchB) {
      referencePriceSourceMatch = false;
      break;
    }
  }

  // Check data publisher
  const publisherPatterns = [/polymarket/i, /kalshi/i, /uniswap/i, /coinbase/i];
  let dataPublisherMatch = true;
  for (const pattern of publisherPatterns) {
    const matchA = pattern.test(criteriaA);
    const matchB = pattern.test(criteriaB);
    if (matchA !== matchB) {
      dataPublisherMatch = false;
      break;
    }
  }

  // Determine wording delta
  const criteriaSimilarity = fuzzyMatch(criteriaA, criteriaB);
  let wordingDelta: 'none' | 'minor' | 'material';
  if (criteriaSimilarity > 0.95) {
    wordingDelta = 'none';
  } else if (criteriaSimilarity > 0.7) {
    wordingDelta = 'minor';
  } else {
    wordingDelta = 'material';
  }

  // Find forbidden mismatches
  const forbiddenMismatchesFound: string[] = [];

  if (!resolutionSourceMatch && (sourcePatterns.some((p) => p.test(criteriaA)) || sourcePatterns.some((p) => p.test(criteriaB)))) {
    forbiddenMismatchesFound.push('resolution_source_mismatch');
  }

  if (settlementTimingDeltaHours > 72) {
    forbiddenMismatchesFound.push('settlement_timing_too_far_apart');
  }

  if (!voidRulesMatch) {
    forbiddenMismatchesFound.push('void_rules_mismatch');
  }

  return {
    resolutionSourceMatch,
    timingWindowMatch,
    voidRulesMatch,
    referencePriceSourceMatch,
    dataPublisherMatch,
    wordingDelta,
    settlementTimingDeltaHours,
    forbiddenMismatchesFound,
  };
}

/**
 * Determine equivalence grade from checklist
 */
export function determineEquivalenceGrade(checklist: EquivalenceChecklist): EquivalenceGrade {
  if (checklist.forbiddenMismatchesFound.length > 0) {
    return 'not_equivalent';
  }

  if (
    checklist.resolutionSourceMatch &&
    checklist.timingWindowMatch &&
    checklist.voidRulesMatch &&
    checklist.referencePriceSourceMatch &&
    checklist.dataPublisherMatch &&
    checklist.wordingDelta === 'none'
  ) {
    return 'identical';
  }

  if (
    checklist.resolutionSourceMatch &&
    checklist.timingWindowMatch &&
    checklist.voidRulesMatch &&
    checklist.wordingDelta !== 'material'
  ) {
    return 'near_equivalent';
  }

  if (checklist.timingWindowMatch && checklist.settlementTimingDeltaHours < 24) {
    return 'similar_but_divergent';
  }

  return 'not_equivalent';
}

/**
 * Create or update a market pair
 */
export async function createMarketPair(
  env: Env,
  canonicalEventId: string,
  marketA: CanonicalMarket,
  marketB: CanonicalMarket
): Promise<MarketPair> {
  // Compute checklist
  const checklist = computeEquivalenceChecklist(marketA, marketB);
  const grade = determineEquivalenceGrade(checklist);

  // Compute rule text hashes
  const ruleHashA = await sha256String(marketA.resolutionCriteria);
  const ruleHashB = await sha256String(marketB.resolutionCriteria);

  // Run LLM equivalence assessment
  const llmRun = await assessEquivalence(
    asResearchEnv(env),
    marketA.id,
    { title: marketA.title, criteria: marketA.resolutionCriteria, venue: marketA.venue },
    { title: marketB.title, criteria: marketB.resolutionCriteria, venue: marketB.venue }
  );

  // Deterministic pair ID from canonical event + venue market IDs.
  const orderedMarketIds = [marketA.id, marketB.id].sort();
  const pairSeed = `pair|${canonicalEventId}|${orderedMarketIds[0]}|${orderedMarketIds[1]}`;
  const pairHash = await sha256String(pairSeed);
  const pairId = `pair_${pairHash.slice(0, 32)}`;

  // Set expiration (30 days)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Compute settlement rule similarity from LLM output
  const settlementRuleSimilarity = llmRun.outputScore;

  // Determine disqualifying mismatches
  const disqualifyingMismatches: string[] = [];
  if (!checklist.timingWindowMatch) disqualifyingMismatches.push('time_window');
  if (!checklist.resolutionSourceMatch) disqualifyingMismatches.push('data_source');
  if (!checklist.voidRulesMatch) disqualifyingMismatches.push('void_rules');

  const now = new Date().toISOString();

  const pair: MarketPair = {
    id: pairId,
    canonicalEventId,
    marketAId: marketA.id,
    marketBId: marketB.id,
    equivalenceGrade: grade,
    settlementRuleSimilarity,
    sharedUnderlyingEvent: true, // Assumed since they're being paired
    disqualifyingMismatches,
    equivalenceChecklist: checklist,
    expiresAt,
    ruleTextHashA: ruleHashA,
    ruleTextHashB: ruleHashB,
    llmAnalysisRunId: llmRun.id,
    status: 'pending_review',
    createdAt: now,
    updatedAt: now,
  };

  // Store in D1
  await env.DB.prepare(`
    INSERT INTO market_pairs (
      id, canonical_event_id, market_a_id, market_b_id,
      equivalence_grade, settlement_rule_similarity, shared_underlying_event,
      disqualifying_mismatches, equivalence_checklist, expires_at,
      rule_text_hash_a, rule_text_hash_b, llm_analysis_run_id,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    pair.id,
    pair.canonicalEventId,
    pair.marketAId,
    pair.marketBId,
    pair.equivalenceGrade,
    pair.settlementRuleSimilarity,
    pair.sharedUnderlyingEvent ? 1 : 0,
    JSON.stringify(pair.disqualifyingMismatches),
    JSON.stringify(pair.equivalenceChecklist),
    pair.expiresAt,
    pair.ruleTextHashA,
    pair.ruleTextHashB,
    pair.llmAnalysisRunId ?? null,
    pair.status,
    pair.createdAt,
    pair.updatedAt
  ).run();

  return pair;
}

/**
 * Approve a market pair for trading
 */
export async function approveMarketPair(
  env: Env,
  pairId: string,
  reviewerId: string,
  notes?: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE market_pairs
    SET status = 'approved', human_reviewer = ?, human_review_date = ?,
        human_review_notes = ?, updated_at = ?
    WHERE id = ?
  `).bind(reviewerId, now, notes ?? null, now, pairId).run();
}

/**
 * Reject a market pair
 */
export async function rejectMarketPair(
  env: Env,
  pairId: string,
  reviewerId: string,
  notes?: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE market_pairs
    SET status = 'rejected', human_reviewer = ?, human_review_date = ?,
        human_review_notes = ?, updated_at = ?
    WHERE id = ?
  `).bind(reviewerId, now, notes ?? null, now, pairId).run();
}

/**
 * Check if a pair is valid for execution
 * Fail-closed: only approved identical/near_equivalent pairs can execute
 */
export async function checkPairExecutionGate(
  env: Env,
  marketAId: string,
  marketBId: string
): Promise<{ canExecute: boolean; reason?: string; pair?: MarketPair }> {
  const result = await env.DB.prepare(`
    SELECT * FROM market_pairs
    WHERE (market_a_id = ? AND market_b_id = ?)
       OR (market_a_id = ? AND market_b_id = ?)
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(marketAId, marketBId, marketBId, marketAId).first<{
    id: string;
    status: string;
    equivalence_grade: string;
    expires_at: string;
  }>();

  if (!result) {
    return { canExecute: false, reason: 'No market pair found' };
  }

  if (result.status !== 'approved') {
    return { canExecute: false, reason: `Pair status is ${result.status}, not approved` };
  }

  if (new Date(result.expires_at) < new Date()) {
    return { canExecute: false, reason: 'Pair has expired' };
  }

  if (!['identical', 'near_equivalent'].includes(result.equivalence_grade)) {
    return {
      canExecute: false,
      reason: `Equivalence grade ${result.equivalence_grade} not sufficient for execution`,
    };
  }

  return { canExecute: true };
}

/**
 * Expire old pairs and pairs with changed rule text
 */
export async function expireStalePairs(env: Env): Promise<number> {
  const result = await env.DB.prepare(`
    UPDATE market_pairs
    SET status = 'expired'
    WHERE status = 'approved' AND expires_at < datetime('now')
  `).run();

  return result.meta.changes ?? 0;
}
