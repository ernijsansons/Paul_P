# Paul P Runbook

**Version:** 1.1.0  
**Last Updated:** 2026-02-27

## Preconditions

- Cloudflare resources exist (D1, R2, KV, queues, Durable Objects).
- `wrangler.toml` bindings use real resource IDs.
- Required secrets are configured.

## Required Secrets

```bash
wrangler secret put KALSHI_API_KEY
wrangler secret put KALSHI_PRIVATE_KEY
wrangler secret put ANTHROPIC_API_KEY
```

Optional LLM provider keys:

```bash
wrangler secret put MINIMAX_API_KEY
wrangler secret put MOONSHOT_API_KEY
wrangler secret put GOOGLE_AI_API_KEY
```

Optional routing overrides (emergency/testing only):

```bash
wrangler secret put LLM_ROUTING_FORCE_MODEL
wrangler secret put LLM_ROUTING_FORCE_ROUTE_CLASS
```

Optional operational secrets:

```bash
wrangler secret put IBKR_USERNAME
wrangler secret put IBKR_PASSWORD
wrangler secret put NOAA_CDO_TOKEN
wrangler secret put ADMIN_TOKEN
```

## Deploy Procedure

1. Validate typecheck/tests:
```bash
npm run lint
npm test
```
2. Apply migrations:
```bash
npm run db:migrate
```
3. Deploy worker:
```bash
npm run deploy
```

## Routing Operations

### Check Routing Budget State

```bash
curl https://paul-p.ernijs-ansons.workers.dev/admin/routing/budget \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Budget Alert Response

1. Identify impacted budget category.
2. Confirm route mix/call volume deltas.
3. Wait for period reset (daily UTC midnight, monthly UTC day 1) or adjust assumptions.
4. Recompute derived envelopes in `src/lib/llm/routing.budget.ts` and deploy.

### Override Usage Policy

- Use overrides only for controlled testing or emergency rerouting.
- All overrides must map to known manifest model IDs / supported route classes.
- Invalid override requests fail closed.
- Override usage is audit-logged.

## Deterministic Hard-Control Rule

- Do not route hard risk-control veto paths through LLM calls.
- If `deterministic_hard_control` is requested in the LLM wrapper, request is blocked by policy.
- Use LLM only for post-halt explanation/analysis workflows.

## Budget Categories

- `research_scoring`
- `trading_validation`
- `ingestion_classification`
- `governance_audit`

Budgets are derived from assumptions (calls/day, route mix, token assumptions, retry/cache rates, pricing) instead of static magic totals.

## Rollback

1. Set circuit breaker to `HALT`.
2. Disable strategy execution policies.
3. Cancel outstanding orders.
4. Run reconciliation and preserve evidence.
5. Open postmortem using `docs/POSTMORTEM_TEMPLATE.md`.
