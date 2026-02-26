/**
 * Paul P - Market Pairing Queue Consumer
 *
 * Processes market pairing requests from QUEUE_PAIRING:
 * - Candidate pair detection
 * - LLM equivalence assessment
 * - Human review queue updates
 */

import type { Env } from '../types/env';
import { deterministicId } from '../lib/utils/deterministic-id';

// ============================================================
// TYPES
// ============================================================

interface PairingMessage {
  type: 'PAIR_CANDIDATE' | 'VALIDATE_PAIR' | 'EXPIRE_PAIRS';
  payload: PairCandidatePayload | ValidatePairPayload | ExpirePairsPayload;
}

interface PairCandidatePayload {
  marketAId: string;
  marketAVenue: string;
  marketBId: string;
  marketBVenue: string;
  canonicalEventId?: string;
  detectedBy: 'title_similarity' | 'same_event' | 'manual';
}

interface ValidatePairPayload {
  pairId: string;
  forceRevalidation?: boolean;
}

interface ExpirePairsPayload {
  beforeDate?: string;
  eventId?: string;
}

// ============================================================
// CONSUMER
// ============================================================

export async function handlePairingQueue(
  batch: MessageBatch,
  env: Env
): Promise<void> {
  const researchAgentId = env.RESEARCH_AGENT.idFromName('singleton');
  const researchAgent = env.RESEARCH_AGENT.get(researchAgentId);

  for (const message of batch.messages) {
    try {
      const pairingMsg = message.body as PairingMessage;

      console.log(`Processing pairing message: ${pairingMsg.type}`);

      switch (pairingMsg.type) {
        case 'PAIR_CANDIDATE':
          await handlePairCandidate(
            pairingMsg.payload as PairCandidatePayload,
            researchAgent,
            env
          );
          break;

        case 'VALIDATE_PAIR':
          await handleValidatePair(
            pairingMsg.payload as ValidatePairPayload,
            researchAgent,
            env
          );
          break;

        case 'EXPIRE_PAIRS':
          await handleExpirePairs(
            pairingMsg.payload as ExpirePairsPayload,
            env
          );
          break;

        default:
          console.warn(`Unknown pairing message type: ${pairingMsg.type}`);
      }

      message.ack();
    } catch (error) {
      console.error('Error processing pairing message:', error);
      message.retry();
    }
  }
}

// ============================================================
// HANDLERS
// ============================================================

async function handlePairCandidate(
  payload: PairCandidatePayload,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  researchAgent: any,
  env: Env
): Promise<void> {
  console.log(`Processing pair candidate: ${payload.marketAId} <-> ${payload.marketBId}`);

  // 1. Check if pair already exists
  const existingPair = await env.DB.prepare(`
    SELECT id, status FROM market_pairs
    WHERE (market_a_id = ? AND market_b_id = ?)
       OR (market_a_id = ? AND market_b_id = ?)
  `).bind(
    payload.marketAId,
    payload.marketBId,
    payload.marketBId,
    payload.marketAId
  ).first<{ id: string; status: string }>();

  if (existingPair && existingPair.status !== 'expired') {
    console.log(`Pair already exists: ${existingPair.id}, status: ${existingPair.status}`);
    return;
  }

  // 2. Get market details for both markets
  const marketA = await env.DB.prepare(`
    SELECT condition_id, question, resolution_criteria, category
    FROM markets WHERE condition_id = ?
  `).bind(payload.marketAId).first<{
    condition_id: string;
    question: string;
    resolution_criteria: string;
    category: string;
  }>();

  const marketB = await env.DB.prepare(`
    SELECT condition_id, question, resolution_criteria, category
    FROM markets WHERE condition_id = ?
  `).bind(payload.marketBId).first<{
    condition_id: string;
    question: string;
    resolution_criteria: string;
    category: string;
  }>();

  if (!marketA || !marketB) {
    console.warn('One or both markets not found');
    return;
  }

  // 3. Request LLM equivalence assessment
  const assessmentResponse = await researchAgent.fetch('http://internal/assess-equivalence', {
    method: 'POST',
    body: JSON.stringify({
      marketA: {
        id: marketA.condition_id,
        venue: payload.marketAVenue,
        title: marketA.question,
        resolutionCriteria: marketA.resolution_criteria,
      },
      marketB: {
        id: marketB.condition_id,
        venue: payload.marketBVenue,
        title: marketB.question,
        resolutionCriteria: marketB.resolution_criteria,
      },
    }),
  });

  const assessment = (await assessmentResponse.json()) as {
    equivalenceGrade: string;
    checklist: Record<string, unknown>;
    llmScoringRunId?: string;
    confidence: number;
  };

  // 4. Create pair record
  const pairId = deterministicId(
    'pair',
    payload.canonicalEventId ?? '',
    ...[payload.marketAId, payload.marketBId].sort()
  );
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await env.DB.prepare(`
    INSERT INTO market_pairs (
      id, canonical_event_id, market_a_id, market_b_id,
      equivalence_grade, settlement_rule_similarity, equivalence_checklist,
      llm_analysis_run_id, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    pairId,
    payload.canonicalEventId ?? '',
    payload.marketAId,
    payload.marketBId,
    assessment.equivalenceGrade,
    assessment.confidence,
    JSON.stringify(assessment.checklist),
    assessment.llmScoringRunId ?? null,
    assessment.equivalenceGrade === 'not_equivalent' ? 'rejected' : 'pending_review',
    expiresAt.toISOString(),
    now.toISOString(),
    now.toISOString()
  ).run();

  console.log(`Created pair ${pairId} with grade: ${assessment.equivalenceGrade}`);
}

async function handleValidatePair(
  payload: ValidatePairPayload,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  researchAgent: any,
  env: Env
): Promise<void> {
  console.log(`Validating pair: ${payload.pairId}`);

  // Get existing pair
  const pair = await env.DB.prepare(`
    SELECT * FROM market_pairs WHERE id = ?
  `).bind(payload.pairId).first<{
    id: string;
    market_a_id: string;
    market_b_id: string;
    equivalence_grade: string;
    status: string;
  }>();

  if (!pair) {
    console.warn(`Pair not found: ${payload.pairId}`);
    return;
  }

  // Re-request assessment from LLM
  const response = await researchAgent.fetch('http://internal/revalidate-pair', {
    method: 'POST',
    body: JSON.stringify({ pairId: pair.id }),
  });

  const result = (await response.json()) as { updated: boolean; newGrade?: string };

  if (result.updated) {
    console.log(`Pair ${pair.id} updated to grade: ${result.newGrade}`);
  }
}

async function handleExpirePairs(
  payload: ExpirePairsPayload,
  env: Env
): Promise<void> {
  const expireDate = payload.beforeDate ?? new Date().toISOString();

  console.log(`Expiring pairs before: ${expireDate}`);

  let query = `UPDATE market_pairs SET status = 'expired', updated_at = ? WHERE expires_at < ?`;
  const params: (string | number)[] = [new Date().toISOString(), expireDate];

  if (payload.eventId) {
    query += ' AND canonical_event_id = ?';
    params.push(payload.eventId);
  }

  const result = await env.DB.prepare(query).bind(...params).run();

  console.log(`Expired ${result.meta.changes} pairs`);
}
