/**
 * Audit Hash Chain Verification Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  verifyChainIntegrity,
  walkChainFromAnchor,
  computeChainSnapshot,
  verifyAllAnchors,
  detectChainGaps,
  findLastGoodState,
  type AuditEvent,
  type AuditAnchor,
} from '../../../src/lib/audit/hash-chain';
import { sha256String } from '../../../src/lib/evidence/hasher';

// ============================================================
// Mock D1 Database
// ============================================================

function createMockD1(events: Partial<AuditEvent>[] = [], anchors: Partial<AuditAnchor>[] = []) {
  return {
    prepare: vi.fn((sql: string) => {
      const boundMock = vi.fn((...args: unknown[]) => ({
        all: vi.fn(async () => {
          if (sql.includes('audit_chain_events')) {
            // Filter based on WHERE clause
            let filtered = [...events];
            if (sql.includes('event_sequence >=') && sql.includes('event_sequence <=')) {
              const [startSeq, endSeq] = args as number[];
              filtered = events.filter(
                (e) => (e.event_sequence ?? 0) >= startSeq && (e.event_sequence ?? 0) <= endSeq
              );
            } else if (sql.includes('event_sequence >')) {
              const seq = args[0] as number;
              filtered = events.filter((e) => (e.event_sequence ?? 0) > seq);
            } else if (sql.includes('event_sequence <=')) {
              const seq = args[0] as number;
              filtered = events.filter((e) => (e.event_sequence ?? 0) <= seq);
            }
            return { results: filtered };
          }
          if (sql.includes('audit_chain_anchors')) {
            return { results: anchors };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('WHERE id =')) {
            const id = args[0] as string;
            if (sql.includes('audit_chain_events')) {
              return events.find((e) => e.id === id) ?? null;
            }
            if (sql.includes('audit_chain_anchors')) {
              return anchors.find((a) => a.id === id) ?? null;
            }
          }
          if (sql.includes('MIN') && sql.includes('MAX')) {
            const seqs = events.map((e) => e.event_sequence ?? 0);
            if (seqs.length === 0) return { min_seq: null, max_seq: null };
            return { min_seq: Math.min(...seqs), max_seq: Math.max(...seqs) };
          }
          if (sql.includes('COUNT(*)')) {
            const seq = args[0] as number;
            const count = events.filter((e) => (e.event_sequence ?? 0) <= seq).length;
            return { count };
          }
          return null;
        }),
        run: vi.fn(async () => ({ success: true })),
      }));

      return {
        bind: boundMock,
        all: vi.fn(async () => {
          if (sql.includes('audit_chain_events')) {
            // Sort by sequence for consistent ordering
            const sorted = [...events].sort((a, b) => (a.event_sequence ?? 0) - (b.event_sequence ?? 0));
            return { results: sorted };
          }
          if (sql.includes('audit_chain_anchors')) {
            return { results: anchors };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('MIN') && sql.includes('MAX')) {
            const seqs = events.map((e) => e.event_sequence ?? 0);
            if (seqs.length === 0) return { min_seq: null, max_seq: null };
            return { min_seq: Math.min(...seqs), max_seq: Math.max(...seqs) };
          }
          return null;
        }),
      };
    }),
  };
}

// ============================================================
// Test Helpers
// ============================================================

async function createValidEvent(
  seq: number,
  prevHash: string,
  agent = 'test-agent',
  eventType = 'TEST_EVENT'
): Promise<AuditEvent> {
  const id = `evt_${seq}`;
  const timestamp = new Date(Date.now() + seq * 1000).toISOString();
  const payload = JSON.stringify({ seq, data: `test-${seq}` });
  const payloadHash = await sha256String(payload);
  const evidenceHash = null;

  const hashInput = [id, timestamp, agent, eventType, payloadHash, evidenceHash ?? '', prevHash].join('|');
  const hash = await sha256String(hashInput);

  return {
    id,
    event_sequence: seq,
    timestamp,
    agent,
    event_type: eventType,
    payload,
    payload_hash: payloadHash,
    evidence_hash: evidenceHash,
    prev_hash: prevHash,
    hash,
  };
}

async function createValidChain(length: number): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let prevHash = 'genesis';

  for (let i = 1; i <= length; i++) {
    const event = await createValidEvent(i, prevHash);
    events.push(event);
    prevHash = event.hash;
  }

  return events;
}

// ============================================================
// Tests
// ============================================================

describe('Audit Hash Chain Verification', () => {
  describe('verifyChainIntegrity', () => {
    it('returns valid for empty range', async () => {
      const db = createMockD1([]);
      const result = await verifyChainIntegrity(db as unknown as D1Database, 1, 10);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(true);
        expect(result.value.eventsChecked).toBe(0);
      }
    });

    it('validates a correctly linked chain', async () => {
      const events = await createValidChain(5);
      const db = createMockD1(events);

      const result = await verifyChainIntegrity(db as unknown as D1Database, 1, 5);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(true);
        expect(result.value.gaps).toHaveLength(0);
        expect(result.value.brokenLinks).toHaveLength(0);
        expect(result.value.eventsChecked).toBe(5);
      }
    });

    it('detects sequence gaps', async () => {
      const events = await createValidChain(5);
      // Remove event 3 to create a gap
      const eventsWithGap = events.filter((e) => e.event_sequence !== 3);
      const db = createMockD1(eventsWithGap);

      const result = await verifyChainIntegrity(db as unknown as D1Database, 1, 5);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(false);
        expect(result.value.gaps).toContain(3);
      }
    });

    it('detects broken hash links', async () => {
      const events = await createValidChain(5);
      // Corrupt the prev_hash of event 3
      events[2].prev_hash = 'corrupted_hash';
      const db = createMockD1(events);

      const result = await verifyChainIntegrity(db as unknown as D1Database, 1, 5);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(false);
        expect(result.value.brokenLinks.length).toBeGreaterThan(0);
        expect(result.value.brokenLinks.some((b) => b.sequence === 3)).toBe(true);
      }
    });

    it('detects payload hash corruption', async () => {
      const events = await createValidChain(3);
      // Corrupt the payload hash
      events[1].payload_hash = 'wrong_payload_hash';
      const db = createMockD1(events);

      const result = await verifyChainIntegrity(db as unknown as D1Database, 1, 3);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(false);
        expect(result.value.brokenLinks.some((b) => b.eventId === 'evt_2')).toBe(true);
      }
    });

    it('detects tampered event hash', async () => {
      const events = await createValidChain(3);
      // Corrupt the stored hash
      events[1].hash = 'tampered_hash';
      const db = createMockD1(events);

      const result = await verifyChainIntegrity(db as unknown as D1Database, 1, 3);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(false);
      }
    });

    it('respects sequence range boundaries', async () => {
      const events = await createValidChain(10);
      const db = createMockD1(events);

      const result = await verifyChainIntegrity(db as unknown as D1Database, 3, 7);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.firstSequence).toBe(3);
        expect(result.value.lastSequence).toBe(7);
        expect(result.value.eventsChecked).toBe(5);
      }
    });
  });

  describe('computeChainSnapshot', () => {
    it('returns empty_chain for no events', async () => {
      const db = createMockD1([]);
      const result = await computeChainSnapshot(db as unknown as D1Database, 10);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hash).toBe('empty_chain');
        expect(result.value.count).toBe(0);
      }
    });

    it('computes deterministic snapshot hash', async () => {
      const events = await createValidChain(5);
      const db = createMockD1(events);

      const result1 = await computeChainSnapshot(db as unknown as D1Database, 5);
      const result2 = await computeChainSnapshot(db as unknown as D1Database, 5);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.hash).toBe(result2.value.hash);
        expect(result1.value.count).toBe(5);
      }
    });

    it('different chains produce different snapshots', async () => {
      const events1 = await createValidChain(5);
      const events2 = await createValidChain(5);
      // Modify an event to get different hashes
      events2[2].hash = 'different_hash';

      const db1 = createMockD1(events1);
      const db2 = createMockD1(events2);

      const result1 = await computeChainSnapshot(db1 as unknown as D1Database, 5);
      const result2 = await computeChainSnapshot(db2 as unknown as D1Database, 5);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.hash).not.toBe(result2.value.hash);
      }
    });

    it('includes timestamp in snapshot', async () => {
      const events = await createValidChain(3);
      const db = createMockD1(events);

      const result = await computeChainSnapshot(db as unknown as D1Database, 3);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.computedAt).toBeDefined();
        expect(new Date(result.value.computedAt).getTime()).toBeGreaterThan(0);
      }
    });
  });

  describe('detectChainGaps', () => {
    it('returns empty for continuous chain', async () => {
      const events = await createValidChain(5);
      const db = createMockD1(events);

      const result = await detectChainGaps(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it('returns empty for no events', async () => {
      const db = createMockD1([]);
      const result = await detectChainGaps(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it('detects single gap', async () => {
      const events = await createValidChain(5);
      const eventsWithGap = events.filter((e) => e.event_sequence !== 3);
      const db = createMockD1(eventsWithGap);

      const result = await detectChainGaps(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain(3);
        expect(result.value).toHaveLength(1);
      }
    });

    it('detects multiple gaps', async () => {
      const events = await createValidChain(10);
      const eventsWithGaps = events.filter((e) => ![3, 5, 7].includes(e.event_sequence));
      const db = createMockD1(eventsWithGaps);

      const result = await detectChainGaps(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain(3);
        expect(result.value).toContain(5);
        expect(result.value).toContain(7);
        expect(result.value).toHaveLength(3);
      }
    });

    it('detects consecutive gaps', async () => {
      const events = await createValidChain(10);
      const eventsWithGaps = events.filter((e) => ![4, 5, 6].includes(e.event_sequence));
      const db = createMockD1(eventsWithGaps);

      const result = await detectChainGaps(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([4, 5, 6]);
      }
    });
  });

  describe('findLastGoodState', () => {
    it('returns genesis for empty chain', async () => {
      const db = createMockD1([]);
      const result = await findLastGoodState(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sequence).toBe(0);
        expect(result.value.hash).toBe('genesis');
      }
    });

    it('returns last event for valid chain', async () => {
      const events = await createValidChain(5);
      const db = createMockD1(events);

      const result = await findLastGoodState(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sequence).toBe(5);
        expect(result.value.hash).toBe(events[4].hash);
      }
    });

    it('stops at first broken link', async () => {
      const events = await createValidChain(5);
      // Break the chain at event 4
      events[3].prev_hash = 'broken';
      const db = createMockD1(events);

      const result = await findLastGoodState(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sequence).toBe(3);
        expect(result.value.hash).toBe(events[2].hash);
      }
    });

    it('stops at sequence gap', async () => {
      const events = await createValidChain(5);
      // Create gap by changing sequence 3 to 4, leaving original 4 as duplicate
      const eventsWithGap = [...events.slice(0, 2), ...events.slice(3)];
      // Fix sequences to have 1, 2, 4, 5 instead of 1, 2, 3, 4, 5
      eventsWithGap[2].event_sequence = 4;
      eventsWithGap[3].event_sequence = 5;
      const db = createMockD1(eventsWithGap);

      const result = await findLastGoodState(db as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sequence).toBe(2);
      }
    });
  });

  describe('walkChainFromAnchor', () => {
    it('returns error for missing anchor', async () => {
      const db = createMockD1([]);
      const dbAnchor = createMockD1([], []);

      const result = await walkChainFromAnchor(
        db as unknown as D1Database,
        dbAnchor as unknown as D1Database,
        'nonexistent_anchor'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Anchor not found');
      }
    });

    it('returns error for anchor with missing event', async () => {
      const anchor: AuditAnchor = {
        id: 'anchor_1',
        chain_head_hash: 'some_hash',
        chain_length: 5,
        anchor_timestamp: new Date().toISOString(),
        anchor_sequence: 1,
        first_event_id: 'evt_1',
        last_event_id: 'evt_5',
        first_event_timestamp: '',
        last_event_timestamp: '',
        verified: 0,
      };

      const db = createMockD1([]);
      const dbAnchor = createMockD1([], [anchor]);

      const result = await walkChainFromAnchor(
        db as unknown as D1Database,
        dbAnchor as unknown as D1Database,
        'anchor_1'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('last event not found');
      }
    });

    it('verifies events after valid anchor', async () => {
      const events = await createValidChain(10);
      const anchorEvent = events[4]; // Anchor at event 5

      const anchor: AuditAnchor = {
        id: 'anchor_1',
        chain_head_hash: anchorEvent.hash,
        chain_length: 5,
        anchor_timestamp: new Date().toISOString(),
        anchor_sequence: 1,
        first_event_id: 'evt_1',
        last_event_id: anchorEvent.id,
        first_event_timestamp: events[0].timestamp,
        last_event_timestamp: anchorEvent.timestamp,
        verified: 0,
      };

      const db = createMockD1(events);
      const dbAnchor = createMockD1([], [anchor]);

      const result = await walkChainFromAnchor(
        db as unknown as D1Database,
        dbAnchor as unknown as D1Database,
        'anchor_1'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.verified).toBe(5); // Events 6-10
        expect(result.value.errors).toHaveLength(0);
        expect(result.value.lastVerifiedSequence).toBe(10);
      }
    });

    it('detects hash mismatch between anchor and event', async () => {
      const events = await createValidChain(5);
      const anchorEvent = events[4];

      const anchor: AuditAnchor = {
        id: 'anchor_1',
        chain_head_hash: 'wrong_hash', // Doesn't match event
        chain_length: 5,
        anchor_timestamp: new Date().toISOString(),
        anchor_sequence: 1,
        first_event_id: 'evt_1',
        last_event_id: anchorEvent.id,
        first_event_timestamp: '',
        last_event_timestamp: '',
        verified: 0,
      };

      const db = createMockD1(events);
      const dbAnchor = createMockD1([], [anchor]);

      const result = await walkChainFromAnchor(
        db as unknown as D1Database,
        dbAnchor as unknown as D1Database,
        'anchor_1'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.verified).toBe(0);
        expect(result.value.errors).toHaveLength(1);
        expect(result.value.errors[0].type).toBe('hash_mismatch');
      }
    });
  });

  describe('verifyAllAnchors', () => {
    it('returns empty results for no anchors', async () => {
      const db = createMockD1([]);
      const dbAnchor = createMockD1([], []);

      const result = await verifyAllAnchors(db as unknown as D1Database, dbAnchor as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.verified).toBe(0);
        expect(result.value.failed).toBe(0);
        expect(result.value.anchors).toHaveLength(0);
      }
    });

    it('verifies valid anchors', async () => {
      const events = await createValidChain(5);

      const anchor: AuditAnchor = {
        id: 'anchor_1',
        chain_head_hash: events[4].hash,
        chain_length: 5,
        anchor_timestamp: new Date().toISOString(),
        anchor_sequence: 1,
        first_event_id: 'evt_1',
        last_event_id: 'evt_5',
        first_event_timestamp: '',
        last_event_timestamp: '',
        verified: 0,
      };

      const db = createMockD1(events);
      const dbAnchor = createMockD1([], [anchor]);

      const result = await verifyAllAnchors(db as unknown as D1Database, dbAnchor as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.verified).toBe(1);
        expect(result.value.failed).toBe(0);
        expect(result.value.anchors[0].valid).toBe(true);
      }
    });

    it('detects invalid anchors', async () => {
      const events = await createValidChain(5);

      const validAnchor: AuditAnchor = {
        id: 'anchor_1',
        chain_head_hash: events[4].hash,
        chain_length: 5,
        anchor_timestamp: new Date().toISOString(),
        anchor_sequence: 1,
        first_event_id: 'evt_1',
        last_event_id: 'evt_5',
        first_event_timestamp: '',
        last_event_timestamp: '',
        verified: 0,
      };

      const invalidAnchor: AuditAnchor = {
        id: 'anchor_2',
        chain_head_hash: 'wrong_hash',
        chain_length: 5,
        anchor_timestamp: new Date().toISOString(),
        anchor_sequence: 2,
        first_event_id: 'evt_1',
        last_event_id: 'evt_5',
        first_event_timestamp: '',
        last_event_timestamp: '',
        verified: 0,
      };

      const db = createMockD1(events);
      const dbAnchor = createMockD1([], [validAnchor, invalidAnchor]);

      const result = await verifyAllAnchors(db as unknown as D1Database, dbAnchor as unknown as D1Database);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.verified).toBe(1);
        expect(result.value.failed).toBe(1);
        expect(result.value.anchors.find((a) => a.id === 'anchor_1')?.valid).toBe(true);
        expect(result.value.anchors.find((a) => a.id === 'anchor_2')?.valid).toBe(false);
      }
    });
  });
});

// Type declaration for test environment
type D1Database = import('@cloudflare/workers-types').D1Database;
