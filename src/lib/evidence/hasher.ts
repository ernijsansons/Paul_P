/**
 * Paul P - Evidence Hasher
 * SHA-256 hashing utilities for evidence integrity
 */

/**
 * Compute SHA-256 hash of data
 */
export async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute SHA-256 hash of a string
 */
export async function sha256String(str: string): Promise<string> {
  const encoder = new TextEncoder();
  return sha256(encoder.encode(str));
}

/**
 * Compute SHA-256 hash of JSON object
 */
export async function sha256Json(obj: unknown): Promise<string> {
  const str = JSON.stringify(obj);
  return sha256String(str);
}

/**
 * Compute deterministic hash for idempotency keys
 * Used for deduplication of operations
 */
export async function computeIdempotencyKey(
  operation: string,
  ...args: (string | number | boolean)[]
): Promise<string> {
  const input = [operation, ...args.map(String)].join('|');
  return sha256String(input);
}

/**
 * Compute deterministic ID for a position
 * id = hash(proxy_wallet + condition_id + side)
 */
export async function computePositionId(
  proxyWallet: string,
  conditionId: string,
  side: 'YES' | 'NO'
): Promise<string> {
  const input = `position|${proxyWallet}|${conditionId}|${side}`;
  const hash = await sha256String(input);
  return `pos_${hash.slice(0, 32)}`;
}

/**
 * Compute deterministic ID for a canonical market
 * id = hash(canonical_event_id + venue + venue_market_id)
 */
export async function computeCanonicalMarketId(
  canonicalEventId: string,
  venue: string,
  venueMarketId: string
): Promise<string> {
  const input = `canonical_market|${canonicalEventId}|${venue}|${venueMarketId}`;
  const hash = await sha256String(input);
  return `cm_${hash.slice(0, 32)}`;
}

/**
 * Compute SHA-256 hash of raw bytes (ArrayBuffer)
 * Alias for sha256 for semantic clarity
 */
export async function sha256Bytes(data: ArrayBuffer): Promise<string> {
  return sha256(data);
}

/**
 * Verify a hash matches expected data
 */
export async function verifyHash(
  data: ArrayBuffer | Uint8Array,
  expectedHash: string
): Promise<boolean> {
  const actualHash = await sha256(data);
  return actualHash === expectedHash;
}
