/**
 * Paul P - Audit Reporter Agent
 * Immutable audit chain + external anchoring + integrity verification
 */

import { PaulPAgent } from './base';
import { sha256String } from '../lib/evidence/hasher';
import { deterministicId } from '../lib/utils/deterministic-id';
import {
  verifyChainIntegrity,
  walkChainFromAnchor,
  computeChainSnapshot,
  verifyAllAnchors,
  detectChainGaps,
  findLastGoodState,
} from '../lib/audit/hash-chain';

export class AuditReporterAgent extends PaulPAgent {
  readonly agentName = 'audit-reporter';

  private lastHash = 'genesis';
  private eventSequence = 0;

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    switch (path) {
      case '/log':
        return this.logEvent(request);
      case '/anchor':
        return this.anchorChain();
      case '/status':
        return this.getStatus();
      case '/verify-chain':
        return this.verifyChain(request);
      case '/get-anchor-status':
        return this.getAnchorStatus();
      case '/detect-gaps':
        return this.detectGaps();
      case '/walk-from-anchor':
        return this.walkFromAnchor(request);
      case '/compute-snapshot':
        return this.computeSnapshot(request);
      case '/anchor-enhanced':
        return this.anchorChainEnhanced();
      case '/find-last-good':
        return this.findLastGood();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  private async logEvent(request: Request): Promise<Response> {
    const event = await request.json<{
      agent: string;
      eventType: string;
      payload: Record<string, unknown>;
      evidenceHash?: string;
      timestamp: string;
    }>();

    const eventId = deterministicId(
      'evt',
      event.timestamp,
      event.agent,
      event.eventType,
      JSON.stringify(event.payload),
      this.eventSequence + 1
    );
    this.eventSequence++;

    // Compute payload hash
    const payloadHash = await sha256String(JSON.stringify(event.payload));

    // Compute chain hash
    const hashInput = [
      eventId,
      event.timestamp,
      event.agent,
      event.eventType,
      payloadHash,
      event.evidenceHash ?? '',
      this.lastHash,
    ].join('|');

    const hash = await sha256String(hashInput);

    // Store in D1
    await this.env.DB.prepare(`
      INSERT INTO audit_chain_events (
        id, event_sequence, timestamp, agent, event_type,
        payload, payload_hash, evidence_hash, prev_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      this.eventSequence,
      event.timestamp,
      event.agent,
      event.eventType,
      JSON.stringify(event.payload),
      payloadHash,
      event.evidenceHash ?? null,
      this.lastHash,
      hash
    ).run();

    this.lastHash = hash;

    return Response.json({ eventId, hash });
  }

  private async anchorChain(): Promise<Response> {
    // Get first and last event details for the chain
    const firstEvent = await this.env.DB.prepare(
      `SELECT id, timestamp FROM audit_chain_events ORDER BY event_sequence ASC LIMIT 1`
    ).first<{ id: string; timestamp: string }>();

    const lastEvent = await this.env.DB.prepare(
      `SELECT id, timestamp FROM audit_chain_events ORDER BY event_sequence DESC LIMIT 1`
    ).first<{ id: string; timestamp: string }>();

    // Get current anchor sequence
    const prevAnchor = await this.env.DB_ANCHOR.prepare(
      `SELECT MAX(anchor_sequence) as max_seq FROM audit_chain_anchors`
    ).first<{ max_seq: number }>();

    const anchorSequence = (prevAnchor?.max_seq ?? 0) + 1;
    const now = new Date().toISOString();
    const anchorId = deterministicId(
      'anchor',
      anchorSequence,
      this.eventSequence,
      this.lastHash,
      now
    );

    await this.env.DB_ANCHOR.prepare(`
      INSERT INTO audit_chain_anchors (
        id, chain_head_hash, chain_length, anchor_timestamp, anchor_sequence,
        first_event_id, last_event_id, first_event_timestamp, last_event_timestamp,
        anchored_to, events_in_range_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1_secondary', ?)
    `).bind(
      anchorId,
      this.lastHash,
      this.eventSequence,
      now,
      anchorSequence,
      firstEvent?.id ?? '',
      lastEvent?.id ?? '',
      firstEvent?.timestamp ?? now,
      lastEvent?.timestamp ?? now,
      this.eventSequence
    ).run();

    return Response.json({
      anchored: true,
      anchorId,
      anchorSequence,
      chainHead: this.lastHash,
      chainLength: this.eventSequence,
      firstEventId: firstEvent?.id,
      lastEventId: lastEvent?.id,
    });
  }

  private async getStatus(): Promise<Response> {
    return Response.json({
      agent: this.agentName,
      chainHead: this.lastHash,
      chainLength: this.eventSequence,
    });
  }

  /**
   * Verify chain integrity between two sequence numbers
   * POST /verify-chain { startSeq: number, endSeq: number }
   */
  private async verifyChain(request: Request): Promise<Response> {
    const body = await request.json<{ startSeq?: number; endSeq?: number }>();

    // Default to full chain if not specified
    const startSeq = body.startSeq ?? 1;
    const endSeq = body.endSeq ?? this.eventSequence;

    const result = await verifyChainIntegrity(this.env.DB, startSeq, endSeq);

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    // Log verification to audit trail
    await this.logAudit('CHAIN_VERIFICATION', {
      startSeq,
      endSeq,
      valid: result.value.valid,
      gaps: result.value.gaps.length,
      brokenLinks: result.value.brokenLinks.length,
    });

    // Alert if gaps or broken links detected
    if (!result.value.valid) {
      console.error('AUDIT CHAIN INTEGRITY FAILURE:', {
        gaps: result.value.gaps,
        brokenLinks: result.value.brokenLinks,
      });
    }

    return Response.json(result.value);
  }

  /**
   * Get status of all anchors
   * GET /get-anchor-status
   */
  private async getAnchorStatus(): Promise<Response> {
    const result = await verifyAllAnchors(this.env.DB, this.env.DB_ANCHOR);

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    // Get latest anchor details
    const latestAnchor = await this.env.DB_ANCHOR.prepare(
      `SELECT * FROM audit_chain_anchors ORDER BY anchor_sequence DESC LIMIT 1`
    ).first();

    return Response.json({
      currentChainHead: this.lastHash,
      currentChainLength: this.eventSequence,
      anchorsVerified: result.value.verified,
      anchorsFailed: result.value.failed,
      anchors: result.value.anchors,
      latestAnchor,
    });
  }

  /**
   * Detect gaps in the event sequence
   * GET /detect-gaps
   */
  private async detectGaps(): Promise<Response> {
    const result = await detectChainGaps(this.env.DB);

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    const gaps = result.value;

    // Alert if gaps detected
    if (gaps.length > 0) {
      console.error('AUDIT CHAIN GAPS DETECTED:', gaps);

      await this.logAudit('CHAIN_GAPS_DETECTED', {
        gapCount: gaps.length,
        gaps: gaps.slice(0, 100), // Limit logged gaps
      });
    }

    return Response.json({
      hasGaps: gaps.length > 0,
      gapCount: gaps.length,
      gaps: gaps.slice(0, 1000), // Limit response size
    });
  }

  /**
   * Walk chain from a specific anchor to verify events after it
   * POST /walk-from-anchor { anchorId: string }
   */
  private async walkFromAnchor(request: Request): Promise<Response> {
    const body = await request.json<{ anchorId: string }>();

    if (!body.anchorId) {
      return Response.json({ error: 'anchorId required' }, { status: 400 });
    }

    const result = await walkChainFromAnchor(this.env.DB, this.env.DB_ANCHOR, body.anchorId);

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    // Log walk result
    await this.logAudit('CHAIN_WALK_FROM_ANCHOR', {
      anchorId: body.anchorId,
      verified: result.value.verified,
      errors: result.value.errors.length,
    });

    return Response.json(result.value);
  }

  /**
   * Compute a snapshot hash of the chain up to a sequence
   * POST /compute-snapshot { upToSeq?: number }
   */
  private async computeSnapshot(request: Request): Promise<Response> {
    const body = await request.json<{ upToSeq?: number }>();
    const upToSeq = body.upToSeq ?? this.eventSequence;

    const result = await computeChainSnapshot(this.env.DB, upToSeq);

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    return Response.json(result.value);
  }

  /**
   * Enhanced anchor with metadata
   */
  private async anchorChainEnhanced(): Promise<Response> {
    // Get first and last event details
    const firstEvent = await this.env.DB.prepare(
      `SELECT id, timestamp FROM audit_chain_events ORDER BY event_sequence ASC LIMIT 1`
    ).first<{ id: string; timestamp: string }>();

    const lastEvent = await this.env.DB.prepare(
      `SELECT id, timestamp FROM audit_chain_events ORDER BY event_sequence DESC LIMIT 1`
    ).first<{ id: string; timestamp: string }>();

    // Get current anchor sequence
    const prevAnchor = await this.env.DB_ANCHOR.prepare(
      `SELECT MAX(anchor_sequence) as max_seq FROM audit_chain_anchors`
    ).first<{ max_seq: number }>();

    const anchorSequence = (prevAnchor?.max_seq ?? 0) + 1;
    const now = new Date().toISOString();
    const anchorId = deterministicId(
      'anchor',
      anchorSequence,
      this.eventSequence,
      this.lastHash,
      now
    );

    await this.env.DB_ANCHOR.prepare(
      `INSERT INTO audit_chain_anchors (
        id, chain_head_hash, chain_length, anchor_timestamp, anchor_sequence,
        first_event_id, last_event_id, first_event_timestamp, last_event_timestamp,
        anchored_to, events_in_range_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1_secondary', ?)`
    )
      .bind(
        anchorId,
        this.lastHash,
        this.eventSequence,
        now,
        anchorSequence,
        firstEvent?.id ?? '',
        lastEvent?.id ?? '',
        firstEvent?.timestamp ?? '',
        lastEvent?.timestamp ?? '',
        this.eventSequence
      )
      .run();

    await this.logAudit('CHAIN_ANCHORED', {
      anchorId,
      chainHead: this.lastHash,
      chainLength: this.eventSequence,
      anchorSequence,
    });

    return Response.json({
      anchored: true,
      anchorId,
      chainHead: this.lastHash,
      chainLength: this.eventSequence,
      anchorSequence,
    });
  }

  /**
   * Find the last known good state of the chain
   */
  private async findLastGood(): Promise<Response> {
    const result = await findLastGoodState(this.env.DB);

    if (!result.ok) {
      return Response.json({ error: result.error.message }, { status: 500 });
    }

    return Response.json(result.value);
  }
}
