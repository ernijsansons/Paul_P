# Paul P Security

**Version:** 1.1.0  
**Last Updated:** 2026-02-27

## Scope

Runtime security controls for credential scoping, deterministic control-path behavior, and routing/audit safeguards.

## Credential Scope Model

Scoped env projections in `src/types/env.ts`:

- `ResearchEnv`: LLM/research access
- `TradingEnv`: execution credentials
- `IngestionEnv`: ingestion-only bindings
- `AuditEnv`: audit/compliance paths

### LLM Provider Key Scoping (P-22)

All LLM provider keys are scoped to ResearchAgent via the unified routing layer.

| Secret | Provider | Route Class | Scoped To |
|--------|----------|-------------|-----------|
| `ANTHROPIC_API_KEY` | Anthropic | premium_cognition | ResearchAgent |
| `MINIMAX_API_KEY` | MiniMax | scanner_fastpath | ResearchAgent |
| `MOONSHOT_API_KEY` | Moonshot | synthesis_long_context | ResearchAgent |
| `GOOGLE_AI_API_KEY` | Google | cheap_enrichment | ResearchAgent |

Key rules:
- LLM keys: ONLY accessible by ResearchAgent (via `dispatchLLMRequest`)
- Trading keys: ONLY accessible by KalshiExecAgent
- NO agent has access to both LLM and trading keys
- Agents NEVER call providers directly — all calls go through routing layer

Required (fail-closed): `ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, `GOOGLE_AI_API_KEY`
Missing any of these keys fails closed at LLM execution time.

## Platform Constraint

Current topology is a single Worker script. Scoped env types are compile-time guardrails, not hard runtime isolation by themselves.

## Deterministic Control-Path Requirement

- P-05/P-09 hard invariants are deterministic code checks.
- LLM responses are forbidden as hard-veto authority.
- Routing class `deterministic_hard_control` is enforced as no-LLM fail-closed.

## LLM Routing Security Controls

- Closed run-type and route-class enums reduce ambiguous routing behavior.
- Forced overrides are explicitly validated; invalid values fail closed.
- Override usage is audit logged (`LLM_ROUTING_OVERRIDE`).
- Model IDs are centrally defined in a manifest to prevent shadow aliases.
- Provider cache semantics are explicit (not `cache_enabled: boolean`).

## Audit and Forensics

- Every routed decision is stored in `llm_routing_decisions`.
- Fields include run type, route class, resolved provider/model, override flags, and failure reason.
- Budget enforcement and routing failures are persisted for post-incident reconstruction.

## Admin and Webhook Auth

- Admin API requires either:
  - `Authorization: Bearer <ADMIN_TOKEN>`, or
  - Cloudflare Access headers (`cf-access-authenticated-user-email` + `cf-access-jwt-assertion`)
- Optional allowlist: `ADMIN_ALLOWED_EMAILS` (comma-separated).
- Optional IP allowlist: `ADMIN_ALLOWED_IPS` (comma-separated).
- Optional second factor on mutating admin routes: `ADMIN_TURNSTILE_SECRET`.
- `/webhooks/trigger/*` requires bearer auth (`WEBHOOK_TRIGGER_TOKEN`, or `ADMIN_TOKEN` fallback).
- `/webhooks/kalshi/events` requires shared secret header (`KALSHI_WEBHOOK_SECRET`, or `WEBHOOK_SHARED_SECRET` fallback).

## Operational Hardening Recommendations

1. Split research and execution into separate Worker deployments with distinct secret sets.
2. Enforce least-privilege provider API keys.
3. Protect admin routes with Cloudflare Access + strong auth.
4. Require two-person approval for go-live and risk-limit changes.
5. Rotate secrets and run DR/security drills quarterly.

## Incident Response

- Set circuit breaker `HALT` when trade integrity is uncertain.
- Preserve evidence and audit artifacts before remediation.
- Reconcile positions before resume.
- Track corrective action in postmortem.
