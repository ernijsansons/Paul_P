# Paul P - LLM Routing

**Version:** 2.0.0  
**Last Updated:** 2026-02-27

## Purpose

This routing layer provides deterministic, auditable LLM selection for non-veto paths.  
Hard risk controls (P-05/P-09) remain deterministic and fail-closed in code.

## Deterministic Hard-Control Policy

- Hard invariants are never delegated to an LLM for permit/deny decisions.
- LLMs may be used after deterministic halts for explanation/memo generation.
- Route class `deterministic_hard_control` is an explicit no-LLM class.
- `routeLLMCall(...)` fails closed if a caller attempts `deterministic_hard_control`.

Error message:
`LLM route requested for deterministic hard control path; this is forbidden by policy.`

## Closed Run-Type Enum

Supported run types (closed set):

- `ambiguity_score`
- `equivalence_assessment`
- `resolution_analysis`
- `invariant_explanation`
- `postmortem_summary`
- `wallet_cluster_synthesis`
- `signal_scanning`
- `general_enrichment`

Legacy run-type aliases are not accepted in routing/governance APIs.

## Route Classes

- `deterministic_hard_control` (no LLM allowed)
- `premium_cognition`
- `scanner_fastpath`
- `synthesis_long_context`
- `cheap_enrichment`

Route class is business intent. Model IDs are provider implementation details.  
Business logic should depend on route class, not on provider-specific model strings.

## Routing Precedence (Exact)

1. Explicit forced override / testing override
2. Safety-critical / premium-cognition run types
3. Strategy-specific mappings
4. Default low-cost enrichment

This precedence is deterministic and unit-tested.

## Default Route Mapping

- `ambiguity_score` -> `premium_cognition`
- `equivalence_assessment` -> `premium_cognition`
- `resolution_analysis` -> `premium_cognition`
- `invariant_explanation` -> `premium_cognition`
- `postmortem_summary` -> `cheap_enrichment` (cost-sensitive postmortem summarization)
- `wallet_cluster_synthesis` -> `synthesis_long_context`
- `signal_scanning` -> `scanner_fastpath`
- `general_enrichment` -> `cheap_enrichment`

Strategy-specific overrides:

- `strategyId` containing `smart-money` -> `synthesis_long_context`
- `strategyId` containing `xvsignal` -> `scanner_fastpath`

## Central Model Manifest

Source of truth: `src/lib/llm/routing.manifest.ts`

Canonical model IDs:

- Anthropic: `claude-opus-4-6`
- MiniMax: `MiniMax-M2.5-highspeed`
- Moonshot: `kimi-k2.5`
- Google: `gemini-3-flash-preview`

Additional operational fallback:

- Cloudflare Workers AI: `@cf/meta/llama-3.1-70b-instruct`

Gemini preview note:

- `gemini-3-flash-preview` is a preview dependency.
- Replace it through manifest mapping only; do not hardcode Gemini model IDs in business logic.

## Cache Semantics

Cache strategy is explicit and provider-aware (not boolean):

- `none`
- `anthropic_prompt_cache`
- `gemini_context_cache`
- `minimax_prompt_cache`
- `moonshot_prompt_cache`

## Forced Override Policy

Supported override sources:

- Input-level override (`forceModel`, `forceRouteClass`)
- Environment override (`LLM_ROUTING_FORCE_MODEL`, `LLM_ROUTING_FORCE_ROUTE_CLASS`)

Rules:

- Overrides are validated against known manifest IDs / supported route classes.
- Invalid overrides fail closed.
- Override usage is persisted and audited.

## Audit Logging

Every routed call persists a routing decision in `llm_routing_decisions` with:

- run type
- strategy id (if present)
- resolved route class
- resolved provider
- resolved model ID
- override used / reason
- projected and actual cost
- success / failure reason

Override events are additionally recorded in `audit_log` as `LLM_ROUTING_OVERRIDE`.

## Budget Projection

Budget logic is assumption-driven in `src/lib/llm/routing.budget.ts`.

Projection inputs:

- calls per day
- days per month
- route mix
- category mix
- average input tokens by route class
- average output tokens by route class
- retry rate
- cache-hit rate
- safety multiplier
- model pricing from manifest

Budgets are derived from these assumptions; no contradictory fixed monthly totals are hardcoded into projection logic.

## Safe Extension Guide

### Add a New Run Type

1. Add run type to the closed union in `routing.types.ts`.
2. Add deterministic mapping in `routing.policy.ts`.
3. Add budget category mapping in `routing.policy.ts`.
4. Add/adjust tests for precedence and class mapping.
5. Update this document and architecture/security/runbook/SLO docs.

### Swap a Model Without Business-Logic Changes

1. Update route-class defaults/fallbacks in `routing.manifest.ts`.
2. Keep route-class names unchanged.
3. Run typecheck/tests and verify cost projection deltas.
4. Roll out with override guardrails if needed.

## Provider Dispatch Layer

Source of truth: `src/lib/llm/providers.ts`

The routing layer resolves WHICH model. The dispatch layer handles HOW.

### Provider API Formats

| Provider | API Format | Auth | Base URL | Timeout |
|----------|-----------|------|----------|---------|
| Anthropic | Messages API | x-api-key header | api.anthropic.com/v1/messages | 60s |
| MiniMax | OpenAI-compatible | Bearer token | api.minimax.chat/v1/text/chatcompletion_v2 | 30s |
| Moonshot | OpenAI-compatible | Bearer token | api.moonshot.cn/v1/chat/completions | 60s |
| Google | Gemini REST | API key in URL | generativelanguage.googleapis.com/v1beta | 30s |
| Cloudflare | Workers AI binding | env.AI.run | N/A (local) | N/A |

### Call Flow

1. Agent calls `routeAndExecuteGovernedLLMCall(env, input)` (canonical contract) or `runLLMScoringWithRouting` for scoring
2. Executor loads prompt template and renders variables
3. Routing layer (`routeLLMCall`) resolves model based on run type
4. Dispatch layer (`dispatchLLMRequest`) calls correct provider API
5. Response normalized to `LLMResponse` format
6. Success/failure logged to audit trail
7. Result returned with token usage and cost

### Error Types

- `LLMProviderKeyError` — Missing API key for required provider
- `LLMProviderCallError` — Provider API failure with typed codes:
  - `PROVIDER_AUTH_FAILED` (HTTP 401/403)
  - `PROVIDER_RATE_LIMITED` (HTTP 429)
  - `PROVIDER_SERVER_ERROR` (HTTP 500+)
  - `PROVIDER_TIMEOUT` (AbortController timeout)
  - `PROVIDER_PARSE_ERROR` (Invalid response format)

### Anthropic Prompt Caching

When `cacheStrategy` is `anthropic_prompt_cache`, the system prompt is sent with:

```json
{
  "system": [{ "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } }]
}
```

Cached tokens are reported separately in usage metrics.

### Adding a New Provider

1. Add provider to `LLMProvider` union in `routing.types.ts`
2. Add model ID to `ResolvedModelId` union in `routing.types.ts`
3. Add cache strategy if applicable to `LLMCacheStrategy` union
4. Add model config to `MODEL_MANIFEST` in `routing.manifest.ts`
5. Add route class mapping in `ROUTE_CLASS_CONFIG`
6. Add `call{Provider}()` function in `providers.ts`
7. Add case to `dispatchLLMRequest` switch in `providers.ts`
8. Add key to `ProviderKeys` interface and `extractProviderKeys`
9. Add secret to Env type in `src/types/env.ts`
10. Set secret: `npx wrangler secret put {PROVIDER}_API_KEY`
11. Add tests in `tests/unit/llm-providers.test.ts`
12. Update this document

### Setting Up Provider Keys

All four provider keys are required (fail-closed policy). Missing any key prevents LLM calls.

```bash
# All required (fail-closed)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put MINIMAX_API_KEY
npx wrangler secret put MOONSHOT_API_KEY
npx wrangler secret put GOOGLE_AI_API_KEY
```

## Primary Files

- `src/lib/llm/routing.types.ts`
- `src/lib/llm/routing.manifest.ts`
- `src/lib/llm/routing.policy.ts`
- `src/lib/llm/routing.budget.ts`
- `src/lib/llm/providers.ts`
- `src/lib/research/llm-governance.ts`
