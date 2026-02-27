# Paul P Architecture

**Version:** 1.1.0  
**Last Updated:** 2026-02-27

## System Overview

Paul P is a Cloudflare-native prediction-market research and execution system built from:

- Worker entrypoint (`src/index.ts`) for HTTP routes, queue consumers, and cron dispatch
- Durable Object agents (`src/agents/*`) for stateful orchestration and strategy logic
- D1 for transactional state and audit metadata
- R2 for immutable evidence/audit artifacts
- KV for short-lived coordination/cache
- Queues for ingestion, signal, order, and pairing fan-out

## Core Agent Responsibilities

- `PaulPOrchestrator`: lifecycle scheduling and workflow coordination
- `MarketDataAgent`: ingestion and evidence-first persistence
- `ResearchAgent`: ambiguity/equivalence governance flows
- `Strategy*Agent`: strategy-specific signal generation
- `RiskGovernorAgent`: deterministic invariant checks and veto decisions
- `KalshiExecAgent` / `IBKRExecAgent`: execution and venue integration
- `ReconciliationAgent`: position drift detection/recovery
- `AuditReporterAgent`: append-only audit handling and anchor support
- `ComplianceAgent`: policy/compliance controls

## Control-Plane Principle

- Hard controls are deterministic and code-first (P-05/P-09).
- LLM output is never a primary veto signal for hard-risk gating.
- LLM usage is restricted to analysis/enrichment/explanation paths.

## LLM Routing Layer

The routing layer lives in `src/lib/llm/routing.*` and provides deterministic, audit-grade model selection.

### Closed Run Types

- `ambiguity_score`
- `equivalence_assessment`
- `resolution_analysis`
- `invariant_explanation`
- `postmortem_summary`
- `wallet_cluster_synthesis`
- `signal_scanning`
- `general_enrichment`

### Route Classes

- `deterministic_hard_control` (no LLM allowed)
- `premium_cognition`
- `scanner_fastpath`
- `synthesis_long_context`
- `cheap_enrichment`

### Deterministic Precedence

1. Explicit forced override/testing override
2. Safety-critical or premium-cognition run types
3. Strategy-specific mappings
4. Default low-cost enrichment

### Manifest-Based Models

Model/provider IDs are centralized in `routing.manifest.ts` (no fake aliases), including:

- `anthropic:claude-opus-4-6`
- `minimax:MiniMax-M2.5-highspeed`
- `moonshot:kimi-k2.5`
- `google:gemini-3-flash-preview`

Gemini preview dependency is documented and replaceable via manifest mapping.

### Auditing and Budgets

- Every routing decision is persisted in `llm_routing_decisions`.
- Override usage is explicitly logged.
- Budgets are assumption-driven in `routing.budget.ts` (derived projections, deterministic math).

See [LLM_ROUTING.md](./LLM_ROUTING.md) for policy-level details.

## Security Boundaries

- Research/LLM and trading credential scopes are separated via scoped env types in `src/types/env.ts`.
- Runtime fail-closed behavior is required for risk/compliance checks.
- Audit integrity is mandatory for incident closure and go-live posture.
