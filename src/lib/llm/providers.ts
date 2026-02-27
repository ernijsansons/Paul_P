/**
 * Paul P - LLM Provider Dispatch Layer
 *
 * Multi-provider HTTP dispatch with typed errors, timeouts, and cache support.
 * This module bridges routing decisions to actual provider API calls.
 *
 * @see P-07 — LLM Governance
 * @see P-22 — Security (key scope separation)
 */

import type { LLMCacheStrategy, LLMProvider } from './routing.types';

// ============================================================
// TYPES
// ============================================================

/**
 * Provider-agnostic LLM request built from routing decision + user prompt.
 */
export interface LLMRequest {
  readonly modelId: string;
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly cacheStrategy: LLMCacheStrategy;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Provider-agnostic LLM response with normalized token usage.
 */
export interface LLMResponse {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly modelId: string;
  readonly provider: LLMProvider;
  readonly latencyMs: number;
  readonly rawResponse: Record<string, unknown>;
}

/**
 * All provider API keys extracted from env.
 * ALL 4 external providers are REQUIRED (fail-closed per P-22).
 * Cloudflare Workers AI is always available as last resort.
 */
export interface ProviderKeys {
  readonly anthropic: string;
  readonly minimax: string;
  readonly moonshot: string;
  readonly google: string;
}

// ============================================================
// ERROR CLASSES
// ============================================================

/**
 * Thrown when a required provider API key is missing or empty.
 */
export class LLMProviderKeyError extends Error {
  readonly code = 'PROVIDER_KEY_MISSING' as const;
  readonly name = 'LLMProviderKeyError' as const;

  constructor(
    message: string,
    readonly provider: LLMProvider,
    readonly secretName: string
  ) {
    super(message);
  }
}

/**
 * Thrown when a provider API call fails.
 */
export class LLMProviderCallError extends Error {
  readonly name = 'LLMProviderCallError' as const;

  constructor(
    message: string,
    readonly provider: LLMProvider,
    readonly code:
      | 'PROVIDER_AUTH_FAILED'
      | 'PROVIDER_RATE_LIMITED'
      | 'PROVIDER_SERVER_ERROR'
      | 'PROVIDER_TIMEOUT'
      | 'PROVIDER_PARSE_ERROR',
    readonly httpStatus?: number
  ) {
    super(message);
  }
}

// ============================================================
// KEY EXTRACTION
// ============================================================

/**
 * Extract and validate provider keys from environment.
 * ALL 4 external providers are REQUIRED (fail-closed per P-22).
 *
 * @throws LLMProviderKeyError if ANY provider key is missing
 */
export function extractProviderKeys(env: {
  ANTHROPIC_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  GOOGLE_AI_API_KEY?: string;
}): ProviderKeys {
  const missing: string[] = [];

  if (!env.ANTHROPIC_API_KEY?.trim()) missing.push('ANTHROPIC_API_KEY');
  if (!env.MINIMAX_API_KEY?.trim()) missing.push('MINIMAX_API_KEY');
  if (!env.MOONSHOT_API_KEY?.trim()) missing.push('MOONSHOT_API_KEY');
  if (!env.GOOGLE_AI_API_KEY?.trim()) missing.push('GOOGLE_AI_API_KEY');

  if (missing.length > 0) {
    throw new LLMProviderKeyError(
      `Missing required LLM provider keys: ${missing.join(', ')}. ` +
        `Run: npx wrangler secret put <KEY_NAME>`,
      'anthropic', // primary provider
      missing.join(',')
    );
  }

  return {
    anthropic: env.ANTHROPIC_API_KEY!.trim(),
    minimax: env.MINIMAX_API_KEY!.trim(),
    moonshot: env.MOONSHOT_API_KEY!.trim(),
    google: env.GOOGLE_AI_API_KEY!.trim(),
  };
}

/**
 * Get the key for a specific provider.
 * Since all keys are required, this always returns a valid key.
 *
 * @throws LLMProviderKeyError if the key is somehow missing (defensive)
 */
export function requireProviderKey(
  keys: ProviderKeys,
  provider: Exclude<LLMProvider, 'cloudflare'>
): string {
  const keyMap: Record<Exclude<LLMProvider, 'cloudflare'>, { key: string; secretName: string }> = {
    anthropic: { key: keys.anthropic, secretName: 'ANTHROPIC_API_KEY' },
    minimax: { key: keys.minimax, secretName: 'MINIMAX_API_KEY' },
    moonshot: { key: keys.moonshot, secretName: 'MOONSHOT_API_KEY' },
    google: { key: keys.google, secretName: 'GOOGLE_AI_API_KEY' },
  };

  const { key, secretName } = keyMap[provider];

  // Defensive check - should never happen since all keys are required
  if (!key || key.trim() === '') {
    throw new LLMProviderKeyError(
      `Missing API key for LLM provider "${provider}". ` +
        `Run: npx wrangler secret put ${secretName}`,
      provider,
      secretName
    );
  }

  return key;
}

// ============================================================
// FETCH HELPERS
// ============================================================

/**
 * Fetch with timeout using AbortController.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: LLMProvider
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new LLMProviderCallError(
        `${provider} request timed out after ${timeoutMs}ms`,
        provider,
        'PROVIDER_TIMEOUT'
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handle provider HTTP errors with typed error codes.
 */
async function handleProviderError(
  response: Response,
  provider: LLMProvider
): Promise<void> {
  if (response.ok) return;

  const status = response.status;
  let body = '';
  try {
    body = await response.text();
  } catch {
    /* ignore read errors */
  }

  if (status === 401 || status === 403) {
    throw new LLMProviderCallError(
      `${provider} auth failed (HTTP ${status}). Check API key. Body: ${body.slice(0, 200)}`,
      provider,
      'PROVIDER_AUTH_FAILED',
      status
    );
  }

  if (status === 429) {
    throw new LLMProviderCallError(
      `${provider} rate limited (HTTP 429). Body: ${body.slice(0, 200)}`,
      provider,
      'PROVIDER_RATE_LIMITED',
      status
    );
  }

  if (status >= 500) {
    throw new LLMProviderCallError(
      `${provider} server error (HTTP ${status}). Body: ${body.slice(0, 200)}`,
      provider,
      'PROVIDER_SERVER_ERROR',
      status
    );
  }

  throw new LLMProviderCallError(
    `${provider} unexpected error (HTTP ${status}). Body: ${body.slice(0, 200)}`,
    provider,
    'PROVIDER_SERVER_ERROR',
    status
  );
}

// ============================================================
// PROVIDER CALLERS
// ============================================================

/**
 * Call Anthropic Messages API.
 * Supports prompt caching when cacheStrategy is 'anthropic_prompt_cache'.
 */
async function callAnthropic(
  req: LLMRequest,
  apiKey: string,
  startMs: number
): Promise<LLMResponse> {
  // Build system content with cache control if enabled
  const systemContent =
    req.cacheStrategy === 'anthropic_prompt_cache'
      ? [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : req.systemPrompt;

  const body = {
    model: req.modelId,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    system: systemContent,
    messages: [{ role: 'user', content: req.userMessage }],
  };

  const response = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    60_000,
    'anthropic'
  );

  await handleProviderError(response, 'anthropic');

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };

  return {
    content: data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
    cachedInputTokens:
      (data.usage.cache_read_input_tokens ?? 0) +
      (data.usage.cache_creation_input_tokens ?? 0),
    modelId: req.modelId,
    provider: 'anthropic',
    latencyMs: Date.now() - startMs,
    rawResponse: data as unknown as Record<string, unknown>,
  };
}

/**
 * Call MiniMax API (OpenAI-compatible).
 */
async function callMiniMax(
  req: LLMRequest,
  apiKey: string,
  startMs: number
): Promise<LLMResponse> {
  const body = {
    model: req.modelId,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userMessage },
    ],
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };

  const response = await fetchWithTimeout(
    'https://api.minimax.chat/v1/text/chatcompletion_v2',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    30_000,
    'minimax'
  );

  await handleProviderError(response, 'minimax');

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices[0]?.message?.content ?? '',
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
    cachedInputTokens: 0,
    modelId: req.modelId,
    provider: 'minimax',
    latencyMs: Date.now() - startMs,
    rawResponse: data as unknown as Record<string, unknown>,
  };
}

/**
 * Call Moonshot (Kimi) API (OpenAI-compatible).
 */
async function callMoonshot(
  req: LLMRequest,
  apiKey: string,
  startMs: number
): Promise<LLMResponse> {
  const body = {
    model: req.modelId,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userMessage },
    ],
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };

  const response = await fetchWithTimeout(
    'https://api.moonshot.cn/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    60_000, // Kimi is long-context, may take longer
    'moonshot'
  );

  await handleProviderError(response, 'moonshot');

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices[0]?.message?.content ?? '',
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
    cachedInputTokens: 0,
    modelId: req.modelId,
    provider: 'moonshot',
    latencyMs: Date.now() - startMs,
    rawResponse: data as unknown as Record<string, unknown>,
  };
}

/**
 * Call Google Gemini API.
 * API key is passed in URL query parameter (not header).
 */
async function callGoogle(
  req: LLMRequest,
  apiKey: string,
  startMs: number
): Promise<LLMResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.modelId}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: req.userMessage }] }],
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    generationConfig: {
      temperature: req.temperature,
      maxOutputTokens: req.maxTokens,
    },
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    30_000,
    'google'
  );

  await handleProviderError(response, 'google');

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata: {
      promptTokenCount: number;
      candidatesTokenCount: number;
      cachedContentTokenCount?: number;
    };
  };

  return {
    content:
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '',
    inputTokens: data.usageMetadata.promptTokenCount,
    outputTokens: data.usageMetadata.candidatesTokenCount,
    cachedInputTokens: data.usageMetadata.cachedContentTokenCount ?? 0,
    modelId: req.modelId,
    provider: 'google',
    latencyMs: Date.now() - startMs,
    rawResponse: data as unknown as Record<string, unknown>,
  };
}

// ============================================================
// MAIN DISPATCHER
// ============================================================

/**
 * Dispatch an LLM request to the appropriate provider.
 *
 * Uses exhaustive switch to ensure all providers are handled.
 * Cloudflare is NOT included here — it uses Workers AI binding, not HTTP fetch.
 *
 * @throws LLMProviderKeyError if the required key is missing
 * @throws LLMProviderCallError if the provider call fails
 */
export async function dispatchLLMRequest(
  request: LLMRequest,
  keys: ProviderKeys
): Promise<LLMResponse> {
  const startMs = Date.now();

  switch (request.provider) {
    case 'anthropic': {
      const key = requireProviderKey(keys, 'anthropic');
      return callAnthropic(request, key, startMs);
    }
    case 'minimax': {
      const key = requireProviderKey(keys, 'minimax');
      return callMiniMax(request, key, startMs);
    }
    case 'moonshot': {
      const key = requireProviderKey(keys, 'moonshot');
      return callMoonshot(request, key, startMs);
    }
    case 'google': {
      const key = requireProviderKey(keys, 'google');
      return callGoogle(request, key, startMs);
    }
    case 'cloudflare': {
      // Cloudflare Workers AI uses env.AI binding, not HTTP fetch.
      // It should be handled separately in llm-governance.ts.
      throw new LLMProviderCallError(
        'Cloudflare Workers AI must be called via env.AI binding, not dispatchLLMRequest',
        'cloudflare',
        'PROVIDER_SERVER_ERROR'
      );
    }
    default: {
      // Exhaustive check - TypeScript will error if a provider is missed
      const _exhaustive: never = request.provider;
      throw new Error(`Unknown LLM provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Check if a provider key is available.
 * Since all keys are required, this always returns true for valid providers.
 */
export function hasProviderKey(
  keys: ProviderKeys,
  provider: Exclude<LLMProvider, 'cloudflare'>
): boolean {
  switch (provider) {
    case 'anthropic':
      return Boolean(keys.anthropic);
    case 'minimax':
      return Boolean(keys.minimax);
    case 'moonshot':
      return Boolean(keys.moonshot);
    case 'google':
      return Boolean(keys.google);
    default: {
      // Exhaustive check - TypeScript will error if a provider is missed
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${exhaustive}`);
    }
  }
}

/**
 * Get list of available providers based on configured keys.
 * Since all 4 keys are required, this always returns all 4 providers.
 */
export function getAvailableProviders(
  _keys: ProviderKeys
): Array<Exclude<LLMProvider, 'cloudflare'>> {
  // All 4 keys are required, so all 4 providers are always available
  return ['anthropic', 'minimax', 'moonshot', 'google'];
}
