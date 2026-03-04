#!/usr/bin/env npx tsx
/**
 * Kalshi Auth Validation Script
 *
 * Validates that Kalshi trading credentials are properly configured and working.
 * Uses the SAME auth mechanism as production trading: RSA-PSS signed requests.
 *
 * Exit codes:
 *   0 = Auth validated successfully
 *   1 = Auth failed (credentials invalid or API unreachable)
 *   2 = Missing credentials (KALSHI_API_KEY or KALSHI_PRIVATE_KEY not set)
 *
 * Usage:
 *   npx tsx scripts/validate-kalshi-auth.ts
 *
 * Environment variables required:
 *   KALSHI_API_KEY      - Your Kalshi API key (UUID format)
 *   KALSHI_PRIVATE_KEY  - Your RSA private key (PEM format)
 */

import { constants as cryptoConstants, sign as nodeSign } from 'node:crypto';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

interface AuthHeaders {
  'KALSHI-ACCESS-KEY': string;
  'KALSHI-ACCESS-TIMESTAMP': string;
  'KALSHI-ACCESS-SIGNATURE': string;
}

/**
 * Generate Kalshi auth headers using RSA-PSS signature
 */
function generateAuthHeaders(
  apiKey: string,
  privateKeyPem: string,
  method: string,
  path: string,
  body?: string
): AuthHeaders {
  const timestamp = Date.now().toString();
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

  return {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
  };
}

/**
 * Test auth by calling a protected endpoint
 */
async function validateAuth(): Promise<{ success: boolean; message: string; details?: string }> {
  const apiKey = process.env.KALSHI_API_KEY?.trim();
  const privateKeyPem = process.env.KALSHI_PRIVATE_KEY?.trim();

  // Check for missing credentials
  if (!apiKey) {
    return { success: false, message: 'KALSHI_API_KEY not set' };
  }
  if (!privateKeyPem) {
    return { success: false, message: 'KALSHI_PRIVATE_KEY not set' };
  }

  // Validate API key format (UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(apiKey)) {
    return { success: false, message: 'KALSHI_API_KEY invalid format (expected UUID)' };
  }

  // Validate private key format
  if (!privateKeyPem.includes('-----BEGIN') || !privateKeyPem.includes('PRIVATE KEY-----')) {
    return { success: false, message: 'KALSHI_PRIVATE_KEY invalid format (expected PEM)' };
  }

  // Call a protected endpoint: /portfolio/balance
  // This is a simple read-only endpoint that requires auth
  const path = '/trade-api/v2/portfolio/balance';
  const method = 'GET';

  try {
    const authHeaders = generateAuthHeaders(apiKey, privateKeyPem, method, path);

    const response = await fetch(KALSHI_API_BASE + '/portfolio/balance', {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Paul-P/1.0 (auth-validation)',
        ...authHeaders,
      },
    });

    if (response.ok) {
      const data = await response.json() as { balance?: number };
      return {
        success: true,
        message: 'Auth validated successfully',
        details: `Account balance endpoint accessible (status ${response.status})`,
      };
    }

    if (response.status === 401) {
      const errorBody = await response.text();
      return {
        success: false,
        message: 'Auth failed: Invalid credentials',
        details: `HTTP 401 - ${errorBody.substring(0, 200)}`,
      };
    }

    if (response.status === 403) {
      return {
        success: false,
        message: 'Auth failed: Forbidden (check API key permissions)',
        details: `HTTP 403`,
      };
    }

    return {
      success: false,
      message: `Auth check failed with status ${response.status}`,
      details: await response.text().then(t => t.substring(0, 200)),
    };

  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        return {
          success: false,
          message: 'Cannot reach Kalshi API',
          details: error.message,
        };
      }
      if (error.message.includes('PEM') || error.message.includes('key')) {
        return {
          success: false,
          message: 'Invalid private key format',
          details: error.message,
        };
      }
      return {
        success: false,
        message: 'Auth validation error',
        details: error.message,
      };
    }
    return {
      success: false,
      message: 'Unknown error during auth validation',
    };
  }
}

// Main execution
async function main() {
  console.log('Kalshi Auth Validation');
  console.log('======================');
  console.log(`API Base: ${KALSHI_API_BASE}`);
  console.log(`Auth Method: RSA-PSS signed requests (same as production trading)`);
  console.log('');

  const result = await validateAuth();

  if (result.success) {
    console.log(`✅ ${result.message}`);
    if (result.details) {
      console.log(`   ${result.details}`);
    }
    process.exit(0);
  } else {
    console.log(`❌ ${result.message}`);
    if (result.details) {
      console.log(`   ${result.details}`);
    }

    // Exit code 2 for missing credentials, 1 for auth failure
    if (result.message.includes('not set') || result.message.includes('invalid format')) {
      process.exit(2);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
