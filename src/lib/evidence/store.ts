/**
 * Paul P - Evidence Store
 * Compress and store raw API responses to R2
 * Evidence-first architecture: store BEFORE parsing
 *
 * R2 key format: evidence/{source}/{YYYY-MM-DD}/{hash}.gz
 */

import type { Env } from '../../types/env';
import { Result, Ok, Err } from '../../types/env';
import { sha256 } from './hasher';
import { deterministicId } from '../utils/deterministic-id';

export interface StoreEvidenceInput {
  source: string;
  endpoint: string;
  rawBytes: ArrayBuffer;
  fetchedAt: string;
  requestMethod?: string;
  requestParams?: Record<string, string>;
}

export interface StoreEvidenceResult {
  evidenceHash: string;
  r2Key: string;
  sizeBytes: number;
  compressedSizeBytes: number;
}

/**
 * Compress data using gzip
 */
async function compressData(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Response(data).body;
  if (!stream) {
    throw new Error('Failed to create stream from data');
  }

  const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
  const compressedResponse = new Response(compressedStream);
  const compressedBuffer = await compressedResponse.arrayBuffer();
  return new Uint8Array(compressedBuffer);
}

/**
 * Decompress gzip data
 */
export async function decompressData(data: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Response(data).body;
  if (!stream) {
    throw new Error('Failed to create stream from data');
  }

  const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
  const decompressedResponse = new Response(decompressedStream);
  return decompressedResponse.arrayBuffer();
}

/**
 * Generate R2 key for evidence blob
 */
function generateR2Key(source: string, hash: string, fetchedAt: string): string {
  const date = fetchedAt.slice(0, 10); // YYYY-MM-DD
  return `evidence/${source}/${date}/${hash}.gz`;
}

/**
 * Store raw API response as evidence blob
 * This MUST be called BEFORE parsing the response
 */
export async function storeEvidence(
  env: Env,
  input: StoreEvidenceInput
): Promise<Result<StoreEvidenceResult, Error>> {
  try {
    // Compute hash of raw bytes
    const evidenceHash = await sha256(input.rawBytes);

    // Generate R2 key
    const r2Key = generateR2Key(input.source, evidenceHash, input.fetchedAt);

    // Check if already exists (deduplication)
    const existing = await env.R2_EVIDENCE.head(r2Key);
    if (existing) {
      // Already stored, return existing info
      return Ok({
        evidenceHash,
        r2Key,
        sizeBytes: input.rawBytes.byteLength,
        compressedSizeBytes: existing.size,
      });
    }

    // Compress the data
    const compressedData = await compressData(input.rawBytes);

    // Store in R2
    await env.R2_EVIDENCE.put(r2Key, compressedData, {
      httpMetadata: {
        contentType: 'application/json',
        contentEncoding: 'gzip',
      },
      customMetadata: {
        source: input.source,
        endpoint: input.endpoint,
        fetchedAt: input.fetchedAt,
        originalSize: String(input.rawBytes.byteLength),
        requestMethod: input.requestMethod ?? 'GET',
      },
    });

    // Index in D1
    await env.DB.prepare(`
      INSERT INTO evidence_blobs (
        evidence_hash, r2_key, source, endpoint, request_method, request_params,
        fetched_at, response_size_bytes, content_type, compression
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'application/json', 'gzip')
      ON CONFLICT (evidence_hash) DO NOTHING
    `).bind(
      evidenceHash,
      r2Key,
      input.source,
      input.endpoint,
      input.requestMethod ?? 'GET',
      input.requestParams ? JSON.stringify(input.requestParams) : null,
      input.fetchedAt,
      input.rawBytes.byteLength
    ).run();

    return Ok({
      evidenceHash,
      r2Key,
      sizeBytes: input.rawBytes.byteLength,
      compressedSizeBytes: compressedData.byteLength,
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Retrieve and decompress evidence blob
 */
export async function retrieveEvidence(
  env: Env,
  evidenceHash: string
): Promise<Result<{ data: ArrayBuffer; metadata: Record<string, string> }, Error>> {
  try {
    // Look up R2 key from D1
    const row = await env.DB.prepare(`
      SELECT r2_key FROM evidence_blobs WHERE evidence_hash = ?
    `).bind(evidenceHash).first<{ r2_key: string }>();

    if (!row) {
      return Err(new Error(`Evidence not found: ${evidenceHash}`));
    }

    // Fetch from R2
    const object = await env.R2_EVIDENCE.get(row.r2_key);
    if (!object) {
      return Err(new Error(`R2 object not found: ${row.r2_key}`));
    }

    // Decompress
    const compressedData = await object.arrayBuffer();
    const decompressedData = await decompressData(compressedData);

    // Verify hash
    const computedHash = await sha256(decompressedData);
    if (computedHash !== evidenceHash) {
      return Err(new Error(`Evidence hash mismatch: expected ${evidenceHash}, got ${computedHash}`));
    }

    return Ok({
      data: decompressedData,
      metadata: object.customMetadata ?? {},
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Verify evidence blob exists and is valid
 */
export async function verifyEvidence(
  env: Env,
  evidenceHash: string
): Promise<Result<boolean, Error>> {
  try {
    const row = await env.DB.prepare(`
      SELECT r2_key FROM evidence_blobs WHERE evidence_hash = ?
    `).bind(evidenceHash).first<{ r2_key: string }>();

    if (!row) {
      return Ok(false);
    }

    const object = await env.R2_EVIDENCE.head(row.r2_key);
    return Ok(object !== null);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Track usage of evidence (which records were derived from it)
 */
export async function trackEvidenceUsage(
  env: Env,
  evidenceHash: string,
  derivedEntityType: string,
  derivedEntityId: string,
  extractionPath?: string
): Promise<Result<void, Error>> {
  try {
    const extractedAt = new Date().toISOString();
    const id = deterministicId(
      'eu',
      evidenceHash,
      derivedEntityType,
      derivedEntityId,
      extractionPath ?? '',
      extractedAt
    );

    await env.DB.prepare(`
      INSERT INTO evidence_usage (
        id, evidence_hash, derived_entity_type, derived_entity_id, extraction_path, extracted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      evidenceHash,
      derivedEntityType,
      derivedEntityId,
      extractionPath ?? null,
      extractedAt
    ).run();

    return Ok(undefined);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}
