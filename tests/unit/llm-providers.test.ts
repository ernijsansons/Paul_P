import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  extractProviderKeys,
  requireProviderKey,
  dispatchLLMRequest,
  hasProviderKey,
  getAvailableProviders,
  LLMProviderKeyError,
  LLMProviderCallError,
  type LLMRequest,
  type ProviderKeys,
} from '../../src/lib/llm/providers';

// ============================================================
// MOCK HELPERS
// ============================================================

function mockFetch(responseBody: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

function mockFetchError(status: number, body = ''): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

function mockFetchTimeout(): typeof fetch {
  return vi.fn().mockImplementation(() => {
    return new Promise((_, reject) => {
      const error = new DOMException('The operation was aborted.', 'AbortError');
      reject(error);
    });
  });
}

const ALL_KEYS: ProviderKeys = {
  anthropic: 'sk-ant-test-key',
  minimax: 'minimax-test-key',
  moonshot: 'moonshot-test-key',
  google: 'google-test-key',
};

// ============================================================
// PROVIDER KEY EXTRACTION (7 tests)
// ============================================================

describe('Provider Key Extraction', () => {
  it('extractProviderKeys succeeds with all 4 keys', () => {
    const keys = extractProviderKeys({
      ANTHROPIC_API_KEY: 'sk-ant-key',
      MINIMAX_API_KEY: 'minimax-key',
      MOONSHOT_API_KEY: 'moonshot-key',
      GOOGLE_AI_API_KEY: 'google-key',
    });

    expect(keys.anthropic).toBe('sk-ant-key');
    expect(keys.minimax).toBe('minimax-key');
    expect(keys.moonshot).toBe('moonshot-key');
    expect(keys.google).toBe('google-key');
  });

  it('extractProviderKeys throws LLMProviderKeyError if anthropic key empty', () => {
    expect(() =>
      extractProviderKeys({
        ANTHROPIC_API_KEY: '',
        MINIMAX_API_KEY: 'minimax-key',
        MOONSHOT_API_KEY: 'moonshot-key',
        GOOGLE_AI_API_KEY: 'google-key',
      })
    ).toThrow(LLMProviderKeyError);
  });

  it('extractProviderKeys throws if any key is missing (all 4 required)', () => {
    // Missing all keys except anthropic
    expect(() =>
      extractProviderKeys({
        ANTHROPIC_API_KEY: 'sk-ant-key',
      })
    ).toThrow(LLMProviderKeyError);

    // Missing minimax
    expect(() =>
      extractProviderKeys({
        ANTHROPIC_API_KEY: 'sk-ant-key',
        MOONSHOT_API_KEY: 'moonshot-key',
        GOOGLE_AI_API_KEY: 'google-key',
      })
    ).toThrow(/MINIMAX_API_KEY/);

    // Missing moonshot
    expect(() =>
      extractProviderKeys({
        ANTHROPIC_API_KEY: 'sk-ant-key',
        MINIMAX_API_KEY: 'minimax-key',
        GOOGLE_AI_API_KEY: 'google-key',
      })
    ).toThrow(/MOONSHOT_API_KEY/);

    // Missing google
    expect(() =>
      extractProviderKeys({
        ANTHROPIC_API_KEY: 'sk-ant-key',
        MINIMAX_API_KEY: 'minimax-key',
        MOONSHOT_API_KEY: 'moonshot-key',
      })
    ).toThrow(/GOOGLE_AI_API_KEY/);
  });

  it('extractProviderKeys error message includes secret name to set', () => {
    try {
      extractProviderKeys({
        ANTHROPIC_API_KEY: '',
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderKeyError);
      expect((err as LLMProviderKeyError).message).toContain('ANTHROPIC_API_KEY');
      expect((err as LLMProviderKeyError).message).toContain('npx wrangler secret put');
    }
  });

  it('extractProviderKeys error includes provider name', () => {
    try {
      extractProviderKeys({
        ANTHROPIC_API_KEY: '',
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderKeyError);
      expect((err as LLMProviderKeyError).provider).toBe('anthropic');
    }
  });

  it('requireProviderKey returns key for all providers when all present', () => {
    // Since all 4 keys are required, ProviderKeys always has all 4
    expect(requireProviderKey(ALL_KEYS, 'anthropic')).toBe('sk-ant-test-key');
    expect(requireProviderKey(ALL_KEYS, 'minimax')).toBe('minimax-test-key');
    expect(requireProviderKey(ALL_KEYS, 'moonshot')).toBe('moonshot-test-key');
    expect(requireProviderKey(ALL_KEYS, 'google')).toBe('google-test-key');
  });

  it('requireProviderKey returns key for available provider', () => {
    expect(requireProviderKey(ALL_KEYS, 'anthropic')).toBe('sk-ant-test-key');
    expect(requireProviderKey(ALL_KEYS, 'minimax')).toBe('minimax-test-key');
    expect(requireProviderKey(ALL_KEYS, 'moonshot')).toBe('moonshot-test-key');
    expect(requireProviderKey(ALL_KEYS, 'google')).toBe('google-test-key');
  });
});

// ============================================================
// PROVIDER DISPATCH ROUTING (4 tests)
// ============================================================

describe('Provider Dispatch Routing', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatchLLMRequest routes anthropic provider to Anthropic URL', async () => {
    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.any(Object)
    );
  });

  it('dispatchLLMRequest routes minimax provider to MiniMax URL', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        choices: [{ message: { content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'MiniMax-M2.5-highspeed',
      provider: 'minimax',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.minimax.chat/v1/text/chatcompletion_v2',
      expect.any(Object)
    );
  });

  it('dispatchLLMRequest routes moonshot provider to Moonshot URL', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        choices: [{ message: { content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'kimi-k2.5',
      provider: 'moonshot',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.moonshot.ai/v1/chat/completions',
      expect.any(Object)
    );
  });

  it('dispatchLLMRequest routes google provider to Gemini URL with key in query param', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'gemini-3-flash-preview',
      provider: 'google',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.any(Object)
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('key=google-test-key'),
      expect.any(Object)
    );
  });
});

// ============================================================
// REQUEST HEADERS (4 tests)
// ============================================================

describe('Request Headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Anthropic request has x-api-key header (not Authorization Bearer)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(headers['x-api-key']).toBe('sk-ant-test-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('MiniMax request has Authorization Bearer header', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        choices: [{ message: { content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'MiniMax-M2.5-highspeed',
      provider: 'minimax',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(headers['Authorization']).toBe('Bearer minimax-test-key');
  });

  it('Moonshot request has Authorization Bearer header', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        choices: [{ message: { content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'kimi-k2.5',
      provider: 'moonshot',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(headers['Authorization']).toBe('Bearer moonshot-test-key');
  });

  it('Google request has NO Authorization header (key is in URL)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'gemini-3-flash-preview',
      provider: 'google',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(headers['Authorization']).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
  });
});

// ============================================================
// CACHE STRATEGY (3 tests)
// ============================================================

describe('Cache Strategy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Anthropic adds cache_control when cacheStrategy is anthropic_prompt_cache', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 5,
        },
      })
    );

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'anthropic_prompt_cache',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string);

    expect(body.system).toBeInstanceOf(Array);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('Anthropic does NOT add cache_control when cacheStrategy is none', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string);

    expect(body.system).toBe('You are helpful.');
  });

  it('Google does not add cache fields when cacheStrategy is none', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'gemini-3-flash-preview',
      provider: 'google',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await dispatchLLMRequest(request, ALL_KEYS);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string);

    expect(body.cachedContent).toBeUndefined();
  });
});

// ============================================================
// RESPONSE PARSING (5 tests)
// ============================================================

describe('Response Parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Anthropic response extracts text from content blocks', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'World' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    const response = await dispatchLLMRequest(request, ALL_KEYS);

    expect(response.content).toBe('Hello World');
  });

  it('MiniMax response extracts text from choices[0].message.content', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        choices: [{ message: { content: 'MiniMax response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'MiniMax-M2.5-highspeed',
      provider: 'minimax',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    const response = await dispatchLLMRequest(request, ALL_KEYS);

    expect(response.content).toBe('MiniMax response');
  });

  it('Moonshot response extracts text from choices[0].message.content', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        choices: [{ message: { content: 'Moonshot response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'kimi-k2.5',
      provider: 'moonshot',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    const response = await dispatchLLMRequest(request, ALL_KEYS);

    expect(response.content).toBe('Moonshot response');
  });

  it('Google response extracts text from candidates[0].content.parts', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        candidates: [
          {
            content: {
              parts: [{ text: 'Google ' }, { text: 'response' }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      })
    );

    const request: LLMRequest = {
      modelId: 'gemini-3-flash-preview',
      provider: 'google',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    const response = await dispatchLLMRequest(request, ALL_KEYS);

    expect(response.content).toBe('Google response');
  });

  it('Token counts extracted correctly per provider format', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 25,
        },
      })
    );

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'anthropic_prompt_cache',
    };

    const response = await dispatchLLMRequest(request, ALL_KEYS);

    expect(response.inputTokens).toBe(100);
    expect(response.outputTokens).toBe(50);
    expect(response.cachedInputTokens).toBe(25);
  });
});

// ============================================================
// ERROR HANDLING (5 tests)
// ============================================================

describe('Error Handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('HTTP 401 from any provider throws PROVIDER_AUTH_FAILED', async () => {
    vi.stubGlobal('fetch', mockFetchError(401, 'Unauthorized'));

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await expect(dispatchLLMRequest(request, ALL_KEYS)).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
    });
  });

  it('HTTP 429 from any provider throws PROVIDER_RATE_LIMITED', async () => {
    vi.stubGlobal('fetch', mockFetchError(429, 'Rate limited'));

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await expect(dispatchLLMRequest(request, ALL_KEYS)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
  });

  it('HTTP 500 from any provider throws PROVIDER_SERVER_ERROR', async () => {
    vi.stubGlobal('fetch', mockFetchError(500, 'Internal Server Error'));

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await expect(dispatchLLMRequest(request, ALL_KEYS)).rejects.toMatchObject({
      code: 'PROVIDER_SERVER_ERROR',
    });
  });

  it('Timeout throws PROVIDER_TIMEOUT', async () => {
    vi.stubGlobal('fetch', mockFetchTimeout());

    const request: LLMRequest = {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await expect(dispatchLLMRequest(request, ALL_KEYS)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
  });

  it('Error includes provider name in message', async () => {
    vi.stubGlobal('fetch', mockFetchError(401, 'Unauthorized'));

    const request: LLMRequest = {
      modelId: 'kimi-k2.5',
      provider: 'moonshot',
      systemPrompt: 'You are helpful.',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    try {
      await dispatchLLMRequest(request, ALL_KEYS);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderCallError);
      expect((err as LLMProviderCallError).provider).toBe('moonshot');
      expect((err as LLMProviderCallError).message).toContain('moonshot');
    }
  });
});

// ============================================================
// INTEGRATION (5 tests)
// ============================================================

describe('Integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Different providers dispatch to different URLs', async () => {
    // Track all fetch calls
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        fetchCalls.push(url);
        if (url.includes('anthropic')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                content: [{ type: 'text', text: 'Hello' }],
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          );
        }
        if (url.includes('minimax')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { content: 'Hello' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          );
        }
        return Promise.reject(new Error('Unknown URL'));
      })
    );

    await dispatchLLMRequest(
      {
        modelId: 'claude-opus-4-6',
        provider: 'anthropic',
        systemPrompt: 'Test',
        userMessage: 'Hello',
        temperature: 0.1,
        maxTokens: 1000,
        cacheStrategy: 'none',
      },
      ALL_KEYS
    );

    await dispatchLLMRequest(
      {
        modelId: 'MiniMax-M2.5-highspeed',
        provider: 'minimax',
        systemPrompt: 'Test',
        userMessage: 'Hello',
        temperature: 0.1,
        maxTokens: 1000,
        cacheStrategy: 'none',
      },
      ALL_KEYS
    );

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toContain('anthropic.com');
    expect(fetchCalls[1]).toContain('minimax.chat');
  });

  it('Response includes latencyMs', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );

    const response = await dispatchLLMRequest(
      {
        modelId: 'claude-opus-4-6',
        provider: 'anthropic',
        systemPrompt: 'Test',
        userMessage: 'Hello',
        temperature: 0.1,
        maxTokens: 1000,
        cacheStrategy: 'none',
      },
      ALL_KEYS
    );

    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('Response includes provider and modelId', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );

    const response = await dispatchLLMRequest(
      {
        modelId: 'claude-opus-4-6',
        provider: 'anthropic',
        systemPrompt: 'Test',
        userMessage: 'Hello',
        temperature: 0.1,
        maxTokens: 1000,
        cacheStrategy: 'none',
      },
      ALL_KEYS
    );

    expect(response.provider).toBe('anthropic');
    expect(response.modelId).toBe('claude-opus-4-6');
  });

  it('hasProviderKey returns true for all providers (all 4 required)', () => {
    // Since all 4 keys are required, hasProviderKey should return true for all
    expect(hasProviderKey(ALL_KEYS, 'anthropic')).toBe(true);
    expect(hasProviderKey(ALL_KEYS, 'minimax')).toBe(true);
    expect(hasProviderKey(ALL_KEYS, 'moonshot')).toBe(true);
    expect(hasProviderKey(ALL_KEYS, 'google')).toBe(true);
  });

  it('getAvailableProviders returns all 4 providers (all required)', () => {
    // Since all 4 keys are required, all 4 providers are always available
    const available = getAvailableProviders(ALL_KEYS);

    expect(available).toContain('anthropic');
    expect(available).toContain('minimax');
    expect(available).toContain('moonshot');
    expect(available).toContain('google');
    expect(available).toHaveLength(4);
  });
});

// ============================================================
// CLOUDFLARE PROVIDER (2 tests)
// ============================================================

describe('Cloudflare Provider', () => {
  it('dispatchLLMRequest throws for cloudflare provider', async () => {
    const request: LLMRequest = {
      modelId: '@cf/meta/llama-3.1-70b-instruct',
      provider: 'cloudflare',
      systemPrompt: 'Test',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    await expect(dispatchLLMRequest(request, ALL_KEYS)).rejects.toThrow(
      LLMProviderCallError
    );
  });

  it('cloudflare error message explains Workers AI binding', async () => {
    const request: LLMRequest = {
      modelId: '@cf/meta/llama-3.1-70b-instruct',
      provider: 'cloudflare',
      systemPrompt: 'Test',
      userMessage: 'Hello',
      temperature: 0.1,
      maxTokens: 1000,
      cacheStrategy: 'none',
    };

    try {
      await dispatchLLMRequest(request, ALL_KEYS);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderCallError);
      expect((err as LLMProviderCallError).message).toContain('env.AI');
    }
  });
});
