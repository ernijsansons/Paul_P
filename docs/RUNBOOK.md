# Paul P Runbook

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## Preconditions

- Cloudflare resources exist (D1, R2, KV, queues, Durable Object bindings)
- `wrangler.toml` IDs are replaced with real resource IDs
- Required secrets are configured

## Required Secrets

```bash
wrangler secret put KALSHI_API_KEY
wrangler secret put KALSHI_PRIVATE_KEY
wrangler secret put ANTHROPIC_API_KEY
```

Optional:

```bash
wrangler secret put IBKR_USERNAME
wrangler secret put IBKR_PASSWORD
wrangler secret put NOAA_CDO_TOKEN
wrangler secret put ADMIN_TOKEN
```

## Deploy Procedure

1. Validate code and tests:
```bash
npm run lint
npm test
```
2. Apply D1 migrations:
```bash
npm run db:migrate
```
3. Deploy worker:
```bash
npm run deploy
```

## Health Validation

- `GET /health`
- `GET /admin/status` (authenticated)
- `GET /admin/audit/status` (authenticated)
- `GET /admin/phase-gates` (authenticated)

## Manual Operational Triggers

- Trigger ingestion: `POST /admin/trigger/ingest`
- Trigger signal scan: `POST /admin/trigger/scan`
- Trigger execution: `POST /admin/trigger/execute`
- Trigger reconciliation: `POST /admin/reconcile`
- Trigger daily report: `POST /admin/report/daily`

## Go-Live Control

1. Run phase gate checks for current phase.
2. Confirm drift sweep has no deployment block.
3. Confirm audit chain integrity and anchor recency.
4. Complete human approval (`/admin/strategies/:id/go-live`) with required signoff policy.

## Rollback

1. Set circuit breaker to `HALT`.
2. Disable strategy execution policies.
3. Cancel outstanding open orders.
4. Run reconciliation and capture incident artifacts.
5. Open postmortem using `docs/POSTMORTEM_TEMPLATE.md`.
