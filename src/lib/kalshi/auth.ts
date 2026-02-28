/**
 * Paul P - Kalshi RSA-PSS Authentication
 *
 * Kalshi requires RSA-PSS signatures on trading endpoints
 * Headers: KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP
 * Signature: RSA-PSS(SHA-256) over: timestamp + method + path + body
 */

import { constants as cryptoConstants, sign as nodeSign } from 'node:crypto';
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
    const apiKey = env.KALSHI_API_KEY?.trim();
    if (!apiKey) {
      return Err(new Error('KALSHI_API_KEY not configured'));
    }

    const privateKeyPem = env.KALSHI_PRIVATE_KEY?.trim();
    if (!privateKeyPem) {
      return Err(new Error('KALSHI_PRIVATE_KEY not configured'));
    }

    // Kalshi expects millisecond epoch timestamps.
    const timestamp = Date.now().toString();

    // Construct the message to sign: timestamp + method + path + body
    const message = timestamp + method.toUpperCase() + path + (body ?? '');

    const signature = nodeSign(
      'sha256',
      Buffer.from(message, 'utf8'),
      {
        key: privateKeyPem,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      }
    );
    const signatureBase64 = signature.toString('base64');

    return Ok({
      'KALSHI-ACCESS-KEY': apiKey,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signatureBase64,
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
