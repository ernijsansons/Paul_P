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

## Primary Files

- `src/lib/llm/routing.types.ts`
- `src/lib/llm/routing.manifest.ts`
- `src/lib/llm/routing.policy.ts`
- `src/lib/llm/routing.budget.ts`
- `src/lib/research/llm-governance.ts`
