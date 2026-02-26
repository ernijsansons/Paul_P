/**
 * Paul P - Kalshi RSA-PSS Authentication
 *
 * Kalshi requires RSA-PSS signatures on trading endpoints
 * Headers: x-kalshi-api-key, x-kalshi-signature, x-kalshi-timestamp
 * Signature: RSA-PSS(SHA-256) over: timestamp + method + path + body
 */

import type { Env } from '../../types/env';
import { Result, Ok, Err } from '../../types/env';

/**
 * Generate authentication headers for Kalshi API requests
 */
export async function generateKalshiAuthHeaders(
  env: Env,
  method: string,
  path: string,
  body?: string
): Promise<Result<Record<string, string>, Error>> {
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Construct the message to sign: timestamp + method + path + body
    const message = timestamp + method.toUpperCase() + path + (body ?? '');

    // Import the private key
    const privateKeyPem = env.KALSHI_PRIVATE_KEY;
    if (!privateKeyPem) {
      return Err(new Error('KALSHI_PRIVATE_KEY not configured'));
    }

    // Parse PEM to get raw key bytes
    const pemContents = privateKeyPem
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace('-----BEGIN RSA PRIVATE KEY-----', '')
      .replace('-----END RSA PRIVATE KEY-----', '')
      .replace(/\s/g, '');

    const keyBytes = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    // Import as CryptoKey for RSA-PSS
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      keyBytes,
      {
        name: 'RSA-PSS',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );

    // Sign the message using RSA-PSS with SHA-256
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(message);

    const signature = await crypto.subtle.sign(
      {
        name: 'RSA-PSS',
        saltLength: 32, // SHA-256 output length
      },
      privateKey,
      messageBytes
    );

    // Encode signature as base64
    const signatureBase64 = btoa(
      String.fromCharCode(...new Uint8Array(signature))
    );

    return Ok({
      'x-kalshi-api-key': env.KALSHI_API_KEY,
      'x-kalshi-timestamp': timestamp,
      'x-kalshi-signature': signatureBase64,
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Check if an endpoint requires authentication
 *
 * IMPORTANT: Always strip query strings before path matching
 * Default to requiring auth (fail-closed) for any unknown paths
 */
export function requiresAuth(endpoint: string): boolean {
  // Strip query string before path matching to avoid bypasses
  const pathOnly = endpoint.split('?')[0] ?? endpoint;

  // Explicit public path prefixes (Kalshi docs specify these as unauthenticated)
  const publicPathPrefixes = [
    '/trade-api/v2/markets',    // Market listing and details
    '/trade-api/v2/events',     // Event listing and details
    '/trade-api/v2/series',     // Series listing and details
    '/trade-api/v2/exchange',   // Exchange status
  ];

  // Explicit paths/patterns that require authentication (checked first for safety)
  const authRequiredPatterns = [
    '/portfolio',     // User portfolio data
    '/orders',        // Order management
    '/positions',     // Position data
    '/fills',         // Fill history
    '/balance',       // Balance info
    '/account',       // Account info
    '/notifications', // User notifications
    '/users',         // User endpoints
  ];

  // Check auth-required patterns first (fail-closed: if it might need auth, require it)
  for (const pattern of authRequiredPatterns) {
    if (pathOnly.includes(pattern)) {
      return true;
    }
  }

  // Check if it's a known public path prefix
  for (const prefix of publicPathPrefixes) {
    if (pathOnly.startsWith(prefix)) {
      // Orderbook, trades, candlesticks for specific markets are public
      // These are subpaths of /markets like /markets/{ticker}/orderbook
      if (pathOnly.includes('/orderbook') ||
          pathOnly.includes('/trades') ||
          pathOnly.includes('/candlesticks') ||
          pathOnly.includes('/history')) {
        return false;
      }
      return false;
    }
  }

  // Default to requiring auth for safety (fail-closed)
  return true;
}

/**
 * Validate API key format
 */
export function validateApiKey(apiKey: string): boolean {
  // Kalshi API keys are typically UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(apiKey);
}
