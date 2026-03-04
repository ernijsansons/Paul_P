/**
 * Cloudflare Access JWT Validation
 *
 * Validates CF Access JWT tokens by fetching public keys from the CF Access
 * certificate endpoint and verifying the JWT signature.
 *
 * This provides defense-in-depth beyond CF Access edge enforcement:
 * - If edge Access is misconfigured, spoofed headers are rejected
 * - If someone bypasses the CF edge, the JWT signature check fails
 */

import { importJWK, importX509, jwtVerify, type JWTPayload } from 'jose';

export interface CFAccessClaims extends JWTPayload {
  email: string;
  aud: string[];
  iss: string;
  sub: string;
  iat: number;
  exp: number;
}

interface CFAccessKey {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  e: string;
  n: string;
  cert?: string;
}

interface CFAccessCertsResponse {
  keys: CFAccessKey[];
  public_cert?: { kid: string; cert: string };
  public_certs?: Array<{ kid: string; cert: string }>;
}

// Cache for public keys - SCOPED BY TEAM DOMAIN (SECURITY FIX)
interface CacheEntry {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}
const domainKeyCache = new Map<string, CacheEntry>();
const KEYS_CACHE_TTL = 3600000; // 1 hour

/**
 * Fetch and cache CF Access public keys/certificates
 * Cache is scoped by team domain to prevent cross-domain key reuse
 *
 * @param teamDomain - The CF Access team domain
 * @param forceRefresh - If true, bypass cache and fetch fresh keys (used on verify failure)
 */
async function getCFAccessPublicKeys(
  teamDomain: string,
  forceRefresh = false
): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  const normalizedDomain = teamDomain.toLowerCase();

  // Check domain-specific cache (unless force refresh requested)
  if (!forceRefresh) {
    const cached = domainKeyCache.get(normalizedDomain);
    if (cached && cached.keys.size > 0 && now - cached.fetchedAt < KEYS_CACHE_TTL) {
      return cached.keys;
    }
  }

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const response = await fetch(certsUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch CF Access certs: ${response.status}`);
  }

  const data = (await response.json()) as CFAccessCertsResponse;
  const keys = new Map<string, CryptoKey>();

  // Handle public_certs array (newer format)
  if (data.public_certs && Array.isArray(data.public_certs)) {
    for (const certInfo of data.public_certs) {
      try {
        const publicKey = await importX509(certInfo.cert, 'RS256');
        keys.set(certInfo.kid, publicKey);
      } catch (err) {
        console.warn(`Failed to import cert ${certInfo.kid}:`, err);
      }
    }
  }

  // Handle single public_cert (older format)
  if (data.public_cert?.cert) {
    try {
      const publicKey = await importX509(data.public_cert.cert, 'RS256');
      keys.set(data.public_cert.kid, publicKey);
    } catch (err) {
      console.warn('Failed to import single public cert:', err);
    }
  }

  // Handle JWK keys array format (some tenants return this instead of certs)
  if (data.keys && Array.isArray(data.keys)) {
    for (const jwk of data.keys) {
      // Skip if we already have this key from cert format
      if (keys.has(jwk.kid)) continue;

      try {
        const publicKey = await importJWK(
          {
            kty: jwk.kty,
            alg: jwk.alg || 'RS256',
            use: jwk.use,
            e: jwk.e,
            n: jwk.n,
            kid: jwk.kid,
          },
          'RS256'
        );
        keys.set(jwk.kid, publicKey as CryptoKey);
      } catch (err) {
        console.warn(`Failed to import JWK ${jwk.kid}:`, err);
      }
    }
  }

  // Store in domain-specific cache
  domainKeyCache.set(normalizedDomain, { keys, fetchedAt: now });
  return keys;
}

/**
 * Try to verify JWT with a set of keys
 */
async function tryVerifyWithKeys(
  jwt: string,
  keys: Map<string, CryptoKey>,
  expectedAudience: string,
  teamDomain: string
): Promise<{ valid: true; claims: CFAccessClaims } | { valid: false }> {
  for (const [, key] of keys) {
    try {
      const { payload } = await jwtVerify(jwt, key, {
        audience: expectedAudience,
        issuer: `https://${teamDomain}`,
      });
      return { valid: true, claims: payload as CFAccessClaims };
    } catch {
      // Key didn't match, try next
      continue;
    }
  }
  return { valid: false };
}

/**
 * Validate a CF Access JWT token
 *
 * @param jwt - The JWT token from cf-access-jwt-assertion header
 * @param teamDomain - Your CF Access team domain (e.g., "yourteam.cloudflareaccess.com")
 * @param expectedAudience - The Application Audience (AUD) tag from CF Access dashboard
 * @returns Validation result with claims if valid, or error message if invalid
 *
 * NOTE: If verification fails with cached keys, automatically retries with fresh keys
 * to handle key rotation scenarios (prevents up to 1-hour outage during rotation).
 */
export async function validateCFAccessJWT(
  jwt: string,
  teamDomain: string,
  expectedAudience: string
): Promise<{ valid: true; claims: CFAccessClaims } | { valid: false; error: string }> {
  try {
    // First attempt with cached keys
    const keys = await getCFAccessPublicKeys(teamDomain);

    if (keys.size === 0) {
      return { valid: false, error: 'No CF Access public keys available' };
    }

    const firstAttempt = await tryVerifyWithKeys(jwt, keys, expectedAudience, teamDomain);
    if (firstAttempt.valid) {
      return firstAttempt;
    }

    // SECURITY FIX: Retry with fresh keys on verification failure
    // This handles key rotation scenarios where cached keys are stale
    const freshKeys = await getCFAccessPublicKeys(teamDomain, true);

    if (freshKeys.size === 0) {
      return { valid: false, error: 'No CF Access public keys available after refresh' };
    }

    const retryAttempt = await tryVerifyWithKeys(jwt, freshKeys, expectedAudience, teamDomain);
    if (retryAttempt.valid) {
      return retryAttempt;
    }

    return { valid: false, error: 'JWT signature verification failed with all available keys' };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Unknown error during JWT validation',
    };
  }
}

/**
 * Clear the cached keys (useful for testing or forced refresh)
 */
export function clearKeyCache(): void {
  domainKeyCache.clear();
}
