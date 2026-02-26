/**
 * Paul P - Sources Registry (P-12)
 *
 * FACT provenance tracking for all data sources.
 * Every piece of data must trace back to a verifiable source.
 *
 * Source Types:
 * - api_response: Direct API call with evidence blob
 * - websocket_message: Real-time data feed
 * - webhook_payload: Incoming webhook data
 * - manual_entry: Human-entered data with reviewer ID
 * - computed: Derived from other sources (with lineage)
 */

import type { Env } from '../../types/env';
import { sha256String, sha256Bytes } from './hasher';
import { deterministicId } from '../utils/deterministic-id';

export type SourceType =
  | 'api_response'
  | 'websocket_message'
  | 'webhook_payload'
  | 'manual_entry'
  | 'computed';

export type SourceQuality =
  | 'authoritative' // Official source (exchange API, government data)
  | 'primary' // Direct observation (trade execution, orderbook snapshot)
  | 'secondary' // Aggregated or derived data
  | 'tertiary'; // Third-party or unverified

export interface SourceEntry {
  id: string;
  sourceType: SourceType;
  sourceUrl: string;
  sourceVendor: string;
  quality: SourceQuality;
  evidenceHash: string;
  evidenceBlobKey?: string; // R2 key for raw evidence
  fetchedAt: string;
  expiresAt?: string;
  metadata: Record<string, unknown>;
  lineage?: string[]; // IDs of parent sources for computed data
  createdAt: string;
}

export interface SourceRegistration {
  sourceType: SourceType;
  sourceUrl: string;
  sourceVendor: string;
  quality: SourceQuality;
  evidenceBlob?: ArrayBuffer | string;
  metadata?: Record<string, unknown>;
  lineage?: string[];
  ttlSeconds?: number;
}

/**
 * Register a new source with evidence
 */
export async function registerSource(
  env: Env,
  registration: SourceRegistration
): Promise<SourceEntry> {
  const now = new Date().toISOString();
  const id = deterministicId(
    'src',
    registration.sourceType,
    registration.sourceVendor,
    registration.sourceUrl,
    now
  );

  // Compute evidence hash
  let evidenceHash: string;
  let evidenceBlobKey: string | undefined;

  if (registration.evidenceBlob) {
    if (typeof registration.evidenceBlob === 'string') {
      evidenceHash = await sha256String(registration.evidenceBlob);
    } else {
      evidenceHash = await sha256Bytes(registration.evidenceBlob);
    }

    // Store evidence blob in R2
    evidenceBlobKey = `evidence/${registration.sourceVendor}/${evidenceHash}`;
    await env.R2_EVIDENCE.put(
      evidenceBlobKey,
      registration.evidenceBlob,
      {
        customMetadata: {
          sourceId: id,
          sourceType: registration.sourceType,
          fetchedAt: now,
        },
      }
    );
  } else if (registration.lineage && registration.lineage.length > 0) {
    // For computed sources, hash the lineage
    evidenceHash = await sha256String(registration.lineage.join(':'));
  } else {
    evidenceHash = await sha256String(`${registration.sourceUrl}:${now}`);
  }

  // Calculate expiration
  const expiresAt = registration.ttlSeconds
    ? new Date(Date.now() + registration.ttlSeconds * 1000).toISOString()
    : undefined;

  const entry: SourceEntry = {
    id,
    sourceType: registration.sourceType,
    sourceUrl: registration.sourceUrl,
    sourceVendor: registration.sourceVendor,
    quality: registration.quality,
    evidenceHash,
    evidenceBlobKey,
    fetchedAt: now,
    expiresAt,
    metadata: registration.metadata ?? {},
    lineage: registration.lineage,
    createdAt: now,
  };

  // Store in D1
  await env.DB.prepare(`
    INSERT INTO sources (
      id, source_type, source_url, source_vendor, quality,
      evidence_hash, evidence_blob_key, fetched_at, expires_at,
      metadata, lineage, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.id,
    entry.sourceType,
    entry.sourceUrl,
    entry.sourceVendor,
    entry.quality,
    entry.evidenceHash,
    entry.evidenceBlobKey ?? null,
    entry.fetchedAt,
    entry.expiresAt ?? null,
    JSON.stringify(entry.metadata),
    entry.lineage ? JSON.stringify(entry.lineage) : null,
    entry.createdAt
  ).run();

  return entry;
}

/**
 * Get a source by ID
 */
export async function getSource(env: Env, sourceId: string): Promise<SourceEntry | null> {
  const result = await env.DB.prepare(`
    SELECT * FROM sources WHERE id = ?
  `).bind(sourceId).first<{
    id: string;
    source_type: string;
    source_url: string;
    source_vendor: string;
    quality: string;
    evidence_hash: string;
    evidence_blob_key: string | null;
    fetched_at: string;
    expires_at: string | null;
    metadata: string;
    lineage: string | null;
    created_at: string;
  }>();

  if (!result) return null;

  return {
    id: result.id,
    sourceType: result.source_type as SourceType,
    sourceUrl: result.source_url,
    sourceVendor: result.source_vendor,
    quality: result.quality as SourceQuality,
    evidenceHash: result.evidence_hash,
    evidenceBlobKey: result.evidence_blob_key ?? undefined,
    fetchedAt: result.fetched_at,
    expiresAt: result.expires_at ?? undefined,
    metadata: JSON.parse(result.metadata),
    lineage: result.lineage ? JSON.parse(result.lineage) : undefined,
    createdAt: result.created_at,
  };
}

/**
 * Get source by evidence hash
 */
export async function getSourceByHash(env: Env, evidenceHash: string): Promise<SourceEntry | null> {
  const result = await env.DB.prepare(`
    SELECT * FROM sources WHERE evidence_hash = ? ORDER BY created_at DESC LIMIT 1
  `).bind(evidenceHash).first<{
    id: string;
    source_type: string;
    source_url: string;
    source_vendor: string;
    quality: string;
    evidence_hash: string;
    evidence_blob_key: string | null;
    fetched_at: string;
    expires_at: string | null;
    metadata: string;
    lineage: string | null;
    created_at: string;
  }>();

  if (!result) return null;

  return {
    id: result.id,
    sourceType: result.source_type as SourceType,
    sourceUrl: result.source_url,
    sourceVendor: result.source_vendor,
    quality: result.quality as SourceQuality,
    evidenceHash: result.evidence_hash,
    evidenceBlobKey: result.evidence_blob_key ?? undefined,
    fetchedAt: result.fetched_at,
    expiresAt: result.expires_at ?? undefined,
    metadata: JSON.parse(result.metadata),
    lineage: result.lineage ? JSON.parse(result.lineage) : undefined,
    createdAt: result.created_at,
  };
}

/**
 * Retrieve evidence blob from R2
 */
export async function getEvidenceBlob(
  env: Env,
  sourceId: string
): Promise<ArrayBuffer | null> {
  const source = await getSource(env, sourceId);
  if (!source?.evidenceBlobKey) return null;

  const obj = await env.R2_EVIDENCE.get(source.evidenceBlobKey);
  if (!obj) return null;

  return obj.arrayBuffer();
}

/**
 * Verify evidence integrity
 */
export async function verifyEvidence(
  env: Env,
  sourceId: string
): Promise<{ valid: boolean; reason?: string }> {
  const source = await getSource(env, sourceId);
  if (!source) {
    return { valid: false, reason: 'Source not found' };
  }

  if (!source.evidenceBlobKey) {
    // No blob to verify
    return { valid: true };
  }

  const blob = await getEvidenceBlob(env, sourceId);
  if (!blob) {
    return { valid: false, reason: 'Evidence blob not found in R2' };
  }

  const computedHash = await sha256Bytes(blob);
  if (computedHash !== source.evidenceHash) {
    return { valid: false, reason: 'Evidence hash mismatch - data may be corrupted' };
  }

  return { valid: true };
}

/**
 * List sources by vendor
 */
export async function listSourcesByVendor(
  env: Env,
  vendor: string,
  limit: number = 100
): Promise<SourceEntry[]> {
  const results = await env.DB.prepare(`
    SELECT * FROM sources
    WHERE source_vendor = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(vendor, limit).all<{
    id: string;
    source_type: string;
    source_url: string;
    source_vendor: string;
    quality: string;
    evidence_hash: string;
    evidence_blob_key: string | null;
    fetched_at: string;
    expires_at: string | null;
    metadata: string;
    lineage: string | null;
    created_at: string;
  }>();

  return (results.results ?? []).map(r => ({
    id: r.id,
    sourceType: r.source_type as SourceType,
    sourceUrl: r.source_url,
    sourceVendor: r.source_vendor,
    quality: r.quality as SourceQuality,
    evidenceHash: r.evidence_hash,
    evidenceBlobKey: r.evidence_blob_key ?? undefined,
    fetchedAt: r.fetched_at,
    expiresAt: r.expires_at ?? undefined,
    metadata: JSON.parse(r.metadata),
    lineage: r.lineage ? JSON.parse(r.lineage) : undefined,
    createdAt: r.created_at,
  }));
}

/**
 * Get source count by vendor
 */
export async function getSourceCount(env: Env, vendor?: string): Promise<number> {
  const query = vendor
    ? env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE source_vendor = ?`).bind(vendor)
    : env.DB.prepare(`SELECT COUNT(*) as count FROM sources`);

  const result = await query.first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * Trace lineage for a computed source
 */
export async function traceLineage(
  env: Env,
  sourceId: string,
  maxDepth: number = 10
): Promise<SourceEntry[]> {
  const lineage: SourceEntry[] = [];
  const visited = new Set<string>();
  const queue: string[] = [sourceId];
  let depth = 0;

  while (queue.length > 0 && depth < maxDepth) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const source = await getSource(env, currentId);
    if (!source) continue;

    lineage.push(source);

    if (source.lineage) {
      queue.push(...source.lineage);
    }
    depth++;
  }

  return lineage;
}

/**
 * Clean up expired sources
 */
export async function cleanupExpiredSources(env: Env): Promise<number> {
  // Get expired source blob keys for R2 cleanup
  const expired = await env.DB.prepare(`
    SELECT evidence_blob_key FROM sources
    WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
    AND evidence_blob_key IS NOT NULL
  `).all<{ evidence_blob_key: string }>();

  // Delete from R2
  for (const row of expired.results ?? []) {
    try {
      await env.R2_EVIDENCE.delete(row.evidence_blob_key);
    } catch {
      // Ignore R2 deletion errors
    }
  }

  // Delete from D1
  const result = await env.DB.prepare(`
    DELETE FROM sources
    WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
  `).run();

  return result.meta.changes ?? 0;
}

/**
 * Get quality distribution stats
 */
export async function getQualityStats(env: Env): Promise<Record<SourceQuality, number>> {
  const results = await env.DB.prepare(`
    SELECT quality, COUNT(*) as count FROM sources GROUP BY quality
  `).all<{ quality: string; count: number }>();

  const stats: Record<SourceQuality, number> = {
    authoritative: 0,
    primary: 0,
    secondary: 0,
    tertiary: 0,
  };

  for (const row of results.results ?? []) {
    stats[row.quality as SourceQuality] = row.count;
  }

  return stats;
}
