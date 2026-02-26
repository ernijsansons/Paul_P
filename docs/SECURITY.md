# Paul P Security

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## Scope

This document defines runtime security controls for Paul P, including key-scope handling, operational safeguards, and incident actions.

## Credential Scope Model

Paul P uses scoped environment projections in `src/types/env.ts`:

- `ResearchEnv`: AI/LLM + research data paths
- `TradingEnv`: trading credentials + execution paths
- `IngestionEnv`: source ingestion without trading/LLM keys
- `AuditEnv`: audit/compliance storage paths

## Important Platform Constraint

Current deployment model is a single Worker script. At runtime, the script has access to all configured bindings/secrets.  
Scoped env types reduce accidental misuse in code paths but are not hard isolation boundaries by themselves.

## Practical Controls in Place

- Fail-closed risk and compliance checks block unsafe progression
- Admin routes require explicit authentication
- Evidence-first ingestion stores raw payloads before parsing
- Audit chain and anchor verification required for go-live
- Deterministic IDs and immutable evidence hashes support traceability

## Recommended Hardening for Production

1. Split research and execution into separate Worker deployments with distinct secret sets.
2. Restrict API keys at provider level to minimum required permissions.
3. Use Cloudflare Access for all admin endpoints.
4. Enforce two-person approvals for go-live and risk-limit changes.
5. Run quarterly credential rotation and DR drills.

## Security Event Response

- Set circuit breaker `HALT` if trade integrity is uncertain.
- Preserve evidence and audit artifacts.
- Reconcile positions before any resume decision.
- Track corrective actions through incident postmortem.
