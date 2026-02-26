/**
 * Paul P - Audit Hash Chain Verification
 * Functions for verifying integrity of the immutable audit chain
 */

import type { D1Database } from '@cloudflare/workers-types';
import { sha256String } from '../evidence/hasher';
import type { Result } from '../../types/env';
import { Ok, Err } from '../../types/env';

// ============================================================
// Types
// ============================================================

export interface AuditEvent {
  id: string;
  event_sequence: number;
  timestamp: string;
  agent: string;
  event_type: string;
  payload: string;
  payload_hash: string;
  evidence_hash: string | null;
  prev_hash: string;
  hash: string;
}

export interface AuditAnchor {
  id: string;
  chain_head_hash: string;
  chain_length: number;
  anchor_timestamp: string;
  anchor_sequence: number;
  first_event_id: string;
  last_event_id: string;
  first_event_timestamp: string;
  last_event_timestamp: string;
  verified: number;
}

export interface ChainIntegrityResult {
  valid: boolean;
  gaps: number[];
  brokenLinks: BrokenLink[];
  eventsChecked: number;
  firstSequence: number;
  lastSequence: number;
}

export interface BrokenLink {
  sequence: number;
  eventId: string;
  expectedPrevHash: string;
  actualPrevHash: string;
}

export interface ChainWalkResult {
  verified: number;
  errors: AuditError[];
  lastVerifiedSequence: number;
  lastVerifiedHash: string;
}

export interface AuditError {
  type: 'gap' | 'hash_mismatch' | 'payload_mismatch' | 'sequence_error';
  sequence: number;
  eventId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ChainSnapshot {
  hash: string;
  count: number;
  firstSequence: number;
  lastSequence: number;
  computedAt: string;
}

// ============================================================
// Chain Integrity Verification
// ============================================================

/**
 * Verify the integrity of the audit chain between two sequence numbers.
 * Checks for:
 * 1. Sequence gaps
 * 2. Broken hash links (prev_hash doesn't match previous event's hash)
 * 3. Payload hash integrity
 */
export async function verifyChainIntegrity(
  db: D1Database,
  startSeq: number,
  endSeq: number
): Promise<Result<ChainIntegrityResult, Error>> {
  try {
    // Fetch all events in range
    const events = await db
      .prepare(
        `SELECT id, event_sequence, timestamp, agent, event_type,
                payload, payload_hash, evidence_hash, prev_hash, hash
         FROM audit_chain_events
         WHERE event_sequence >= ? AND event_sequence <= ?
         ORDER BY event_sequence ASC`
      )
      .bind(startSeq, endSeq)
      .all<AuditEvent>();

    if (!events.results || events.results.length === 0) {
      return Ok({
        valid: true,
        gaps: [],
        brokenLinks: [],
        eventsChecked: 0,
        firstSequence: startSeq,
        lastSequence: endSeq,
      });
    }

    const gaps: number[] = [];
    const brokenLinks: BrokenLink[] = [];
    let prevEvent: AuditEvent | null = null;

    // Check for gaps and hash chain integrity
    for (const event of events.results) {
      // Check for sequence gaps
      if (prevEvent) {
        const expectedSeq = prevEvent.event_sequence + 1;
        if (event.event_sequence !== expectedSeq) {
          // Record all missing sequences
          for (let seq = expectedSeq; seq < event.event_sequence; seq++) {
            gaps.push(seq);
          }
        }

        // Check hash chain link
        if (event.prev_hash !== prevEvent.hash) {
          brokenLinks.push({
            sequence: event.event_sequence,
            eventId: event.id,
            expectedPrevHash: prevEvent.hash,
            actualPrevHash: event.prev_hash,
          });
        }
      }

      // Verify payload hash
      const computedPayloadHash = await sha256String(event.payload);
      if (computedPayloadHash !== event.payload_hash) {
        brokenLinks.push({
          sequence: event.event_sequence,
          eventId: event.id,
          expectedPrevHash: `payload_hash:${computedPayloadHash}`,
          actualPrevHash: `payload_hash:${event.payload_hash}`,
        });
      }

      // Recompute event hash to verify integrity
      const hashInput = [
        event.id,
        event.timestamp,
        event.agent,
        event.event_type,
        event.payload_hash,
        event.evidence_hash ?? '',
        event.prev_hash,
      ].join('|');

      const computedHash = await sha256String(hashInput);
      if (computedHash !== event.hash) {
        brokenLinks.push({
          sequence: event.event_sequence,
          eventId: event.id,
          expectedPrevHash: `computed_hash:${computedHash}`,
          actualPrevHash: `stored_hash:${event.hash}`,
        });
      }

      prevEvent = event;
    }

    // Safe to access since we already checked for empty results above
    const firstEvent = events.results[0]!;
    const lastEvent = events.results[events.results.length - 1]!;

    return Ok({
      valid: gaps.length === 0 && brokenLinks.length === 0,
      gaps,
      brokenLinks,
      eventsChecked: events.results.length,
      firstSequence: firstEvent.event_sequence,
      lastSequence: lastEvent.event_sequence,
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================
// Walk Chain from Anchor
// ============================================================

/**
 * Walk the audit chain from an anchor point, verifying each event.
 * Returns the number of verified events and any errors found.
 */
export async function walkChainFromAnchor(
  db: D1Database,
  dbAnchor: D1Database,
  anchorId: string
): Promise<Result<ChainWalkResult, Error>> {
  try {
    // Fetch the anchor
    const anchor = await dbAnchor
      .prepare(`SELECT * FROM audit_chain_anchors WHERE id = ?`)
      .bind(anchorId)
      .first<AuditAnchor>();

    if (!anchor) {
      return Err(new Error(`Anchor not found: ${anchorId}`));
    }

    // Get the last event at anchor time
    const anchorEvent = await db
      .prepare(`SELECT * FROM audit_chain_events WHERE id = ?`)
      .bind(anchor.last_event_id)
      .first<AuditEvent>();

    if (!anchorEvent) {
      return Err(new Error(`Anchor's last event not found: ${anchor.last_event_id}`));
    }

    // Verify anchor hash matches
    if (anchorEvent.hash !== anchor.chain_head_hash) {
      return Ok({
        verified: 0,
        errors: [
          {
            type: 'hash_mismatch',
            sequence: anchorEvent.event_sequence,
            eventId: anchorEvent.id,
            message: 'Anchor chain_head_hash does not match last event hash',
            details: {
              anchorHash: anchor.chain_head_hash,
              eventHash: anchorEvent.hash,
            },
          },
        ],
        lastVerifiedSequence: 0,
        lastVerifiedHash: 'genesis',
      });
    }

    // Walk forward from anchor to verify all subsequent events
    const eventsAfterAnchor = await db
      .prepare(
        `SELECT * FROM audit_chain_events
         WHERE event_sequence > ?
         ORDER BY event_sequence ASC`
      )
      .bind(anchorEvent.event_sequence)
      .all<AuditEvent>();

    const errors: AuditError[] = [];
    let verified = 0;
    let lastHash = anchorEvent.hash;
    let lastSequence = anchorEvent.event_sequence;

    for (const event of eventsAfterAnchor.results ?? []) {
      // Check sequence continuity
      if (event.event_sequence !== lastSequence + 1) {
        errors.push({
          type: 'gap',
          sequence: lastSequence + 1,
          message: `Missing events from ${lastSequence + 1} to ${event.event_sequence - 1}`,
        });
      }

      // Check prev_hash linkage
      if (event.prev_hash !== lastHash) {
        errors.push({
          type: 'hash_mismatch',
          sequence: event.event_sequence,
          eventId: event.id,
          message: 'prev_hash does not match previous event hash',
          details: {
            expected: lastHash,
            actual: event.prev_hash,
          },
        });
      }

      // Verify computed hash
      const hashInput = [
        event.id,
        event.timestamp,
        event.agent,
        event.event_type,
        event.payload_hash,
        event.evidence_hash ?? '',
        event.prev_hash,
      ].join('|');

      const computedHash = await sha256String(hashInput);
      if (computedHash !== event.hash) {
        errors.push({
          type: 'hash_mismatch',
          sequence: event.event_sequence,
          eventId: event.id,
          message: 'Computed hash does not match stored hash',
          details: {
            computed: computedHash,
            stored: event.hash,
          },
        });
      }

      lastHash = event.hash;
      lastSequence = event.event_sequence;
      verified++;
    }

    return Ok({
      verified,
      errors,
      lastVerifiedSequence: lastSequence,
      lastVerifiedHash: lastHash,
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================
// Chain Snapshot
// ============================================================

/**
 * Compute a deterministic snapshot hash of the chain up to a sequence number.
 * This creates a Merkle-like summary that can be used to verify chain integrity.
 */
export async function computeChainSnapshot(
  db: D1Database,
  upToSeq: number
): Promise<Result<ChainSnapshot, Error>> {
  try {
    // Get all events up to the specified sequence
    const events = await db
      .prepare(
        `SELECT hash, event_sequence
         FROM audit_chain_events
         WHERE event_sequence <= ?
         ORDER BY event_sequence ASC`
      )
      .bind(upToSeq)
      .all<{ hash: string; event_sequence: number }>();

    if (!events.results || events.results.length === 0) {
      return Ok({
        hash: 'empty_chain',
        count: 0,
        firstSequence: 0,
        lastSequence: 0,
        computedAt: new Date().toISOString(),
      });
    }

    // Concatenate all hashes in order
    const allHashes = events.results.map((e) => e.hash).join('');
    const snapshotHash = await sha256String(allHashes);

    // Safe to access since we already checked for empty results above
    const first = events.results[0]!;
    const last = events.results[events.results.length - 1]!;

    return Ok({
      hash: snapshotHash,
      count: events.results.length,
      firstSequence: first.event_sequence,
      lastSequence: last.event_sequence,
      computedAt: new Date().toISOString(),
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================
// Anchor Verification
// ============================================================

/**
 * Verify all anchors are consistent with the chain.
 * Returns list of anchors and their verification status.
 */
export async function verifyAllAnchors(
  db: D1Database,
  dbAnchor: D1Database
): Promise<
  Result<
    {
      verified: number;
      failed: number;
      anchors: Array<{ id: string; valid: boolean; reason?: string }>;
    },
    Error
  >
> {
  try {
    const anchors = await dbAnchor
      .prepare(`SELECT * FROM audit_chain_anchors ORDER BY anchor_sequence ASC`)
      .all<AuditAnchor>();

    const results: Array<{ id: string; valid: boolean; reason?: string }> = [];
    let verified = 0;
    let failed = 0;

    for (const anchor of anchors.results ?? []) {
      // Get the last event referenced by anchor
      const event = await db
        .prepare(`SELECT hash FROM audit_chain_events WHERE id = ?`)
        .bind(anchor.last_event_id)
        .first<{ hash: string }>();

      if (!event) {
        results.push({
          id: anchor.id,
          valid: false,
          reason: `Last event not found: ${anchor.last_event_id}`,
        });
        failed++;
        continue;
      }

      if (event.hash !== anchor.chain_head_hash) {
        results.push({
          id: anchor.id,
          valid: false,
          reason: `Hash mismatch: expected ${anchor.chain_head_hash}, got ${event.hash}`,
        });
        failed++;
        continue;
      }

      // Check chain length matches
      const countResult = await db
        .prepare(`SELECT COUNT(*) as count FROM audit_chain_events WHERE event_sequence <= ?`)
        .bind(anchor.chain_length)
        .first<{ count: number }>();

      if (countResult && countResult.count !== anchor.chain_length) {
        results.push({
          id: anchor.id,
          valid: false,
          reason: `Chain length mismatch: expected ${anchor.chain_length}, got ${countResult.count}`,
        });
        failed++;
        continue;
      }

      results.push({ id: anchor.id, valid: true });
      verified++;
    }

    return Ok({ verified, failed, anchors: results });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================
// Gap Detection
// ============================================================

/**
 * Detect any gaps in the event sequence.
 * Returns array of missing sequence numbers.
 */
export async function detectChainGaps(db: D1Database): Promise<Result<number[], Error>> {
  try {
    // Get min and max sequence
    const bounds = await db
      .prepare(
        `SELECT MIN(event_sequence) as min_seq, MAX(event_sequence) as max_seq
         FROM audit_chain_events`
      )
      .first<{ min_seq: number; max_seq: number }>();

    if (!bounds || bounds.min_seq === null) {
      return Ok([]);
    }

    // Get all sequences
    const sequences = await db
      .prepare(
        `SELECT event_sequence FROM audit_chain_events
         ORDER BY event_sequence ASC`
      )
      .all<{ event_sequence: number }>();

    const seqSet = new Set((sequences.results ?? []).map((s) => s.event_sequence));
    const gaps: number[] = [];

    for (let seq = bounds.min_seq; seq <= bounds.max_seq; seq++) {
      if (!seqSet.has(seq)) {
        gaps.push(seq);
      }
    }

    return Ok(gaps);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================================
// Recovery Helpers
// ============================================================

/**
 * Find the last known good state of the chain.
 * Returns the sequence number of the last verified event.
 */
export async function findLastGoodState(
  db: D1Database
): Promise<Result<{ sequence: number; hash: string }, Error>> {
  try {
    // Start from genesis and walk forward until we find a broken link
    const events = await db
      .prepare(
        `SELECT id, event_sequence, timestamp, agent, event_type,
                payload_hash, evidence_hash, prev_hash, hash
         FROM audit_chain_events
         ORDER BY event_sequence ASC`
      )
      .all<AuditEvent>();

    if (!events.results || events.results.length === 0) {
      return Ok({ sequence: 0, hash: 'genesis' });
    }

    let lastGoodSequence = 0;
    let lastGoodHash = 'genesis';
    let expectedPrevHash = 'genesis';

    for (const event of events.results) {
      // Check sequence continuity
      if (event.event_sequence !== lastGoodSequence + 1) {
        break;
      }

      // Check hash chain
      if (event.prev_hash !== expectedPrevHash) {
        break;
      }

      // Recompute hash
      const hashInput = [
        event.id,
        event.timestamp,
        event.agent,
        event.event_type,
        event.payload_hash,
        event.evidence_hash ?? '',
        event.prev_hash,
      ].join('|');

      const computedHash = await sha256String(hashInput);
      if (computedHash !== event.hash) {
        break;
      }

      lastGoodSequence = event.event_sequence;
      lastGoodHash = event.hash;
      expectedPrevHash = event.hash;
    }

    return Ok({ sequence: lastGoodSequence, hash: lastGoodHash });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}
