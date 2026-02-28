# Paul P Runbook

**Version:** 1.1.1  
**Last Updated:** 2026-02-28

## Preconditions

- Cloudflare resources exist (D1, R2, KV, queues, Durable Objects).
- `wrangler.toml` bindings use real resource IDs.
- Required secrets are configured.

## Required Secrets

```bash
wrangler secret put KALSHI_API_KEY
wrangler secret put KALSHI_PRIVATE_KEY

# LLM provider keys (all 4 required - fail-closed policy)
wrangler secret put ANTHROPIC_API_KEY
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
wrangler secret put WEBHOOK_TRIGGER_TOKEN
wrangler secret put KALSHI_WEBHOOK_SECRET
```

Optional admin hardening:

```bash
wrangler secret put ADMIN_ALLOWED_EMAILS
wrangler secret put ADMIN_ALLOWED_IPS
wrangler secret put ADMIN_TURNSTILE_SECRET
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
npm run db:migrate:anchor
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

### View Recent Trades

```bash
curl "https://paul-p.ernijs-ansons.workers.dev/admin/trades?limit=100" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Common filters:

```bash
# One venue only
curl "https://paul-p.ernijs-ansons.workers.dev/admin/trades?venue=kalshi&limit=50" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Strategy + status + mode
curl "https://paul-p.ernijs-ansons.workers.dev/admin/trades?strategy=bonding&status=filled&mode=PAPER&limit=100" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Budget Alert Response

1. Identify impacted budget category.
2. Confirm route mix/call volume deltas.
3. Wait for period reset (daily UTC midnight, monthly UTC day 1) or adjust assumptions.
4. Recompute derived envelopes in `src/lib/llm/routing.budget.ts` and deploy.

## Webhook Operations

### Manual Trigger Authentication

`/webhooks/trigger/*` requires bearer auth:

```bash
curl -X POST https://paul-p.ernijs-ansons.workers.dev/webhooks/trigger/ingest \
  -H "Authorization: Bearer $WEBHOOK_TRIGGER_TOKEN"
```

### Kalshi Relay Authentication

`/webhooks/kalshi/events` requires shared secret header:

```bash
curl -X POST https://paul-p.ernijs-ansons.workers.dev/webhooks/kalshi/events \
  -H "X-Kalshi-Webhook-Secret: $KALSHI_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"order_update","payload":{}}'
```

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

## LLM Provider Operations

### Check Configured Secrets

```bash
npx wrangler secret list
```

### Rotate a Provider Key

```bash
# 1. Generate new key at provider dashboard
# 2. Update in Workers Secrets
npx wrangler secret put ANTHROPIC_API_KEY
# 3. Worker automatically picks up new key on next request
```

### Force All LLM Calls to One Model

```bash
# Set override (emergency/testing only)
npx wrangler secret put LLM_ROUTING_FORCE_MODEL
# Enter model ID: anthropic:claude-opus-4-6

# Remove override
npx wrangler secret delete LLM_ROUTING_FORCE_MODEL
```

### Provider Error Troubleshooting

| Error Code | Cause | Action |
|------------|-------|--------|
| `PROVIDER_AUTH_FAILED` | API key invalid/expired | Rotate key via provider dashboard |
| `PROVIDER_RATE_LIMITED` | Too many requests | Check budget assumptions, increase intervals |
| `PROVIDER_SERVER_ERROR` | Provider outage | Check status page, force override to different provider |
| `PROVIDER_TIMEOUT` | Slow response | Check prompt size, increase timeout for long-context |
| `PROVIDER_KEY_MISSING` | Secret not set | `npx wrangler secret put <KEY_NAME>` |

### Check Provider Availability

The system uses fallback chains. If primary provider fails, next in chain is tried:

- `premium_cognition`: Anthropic → Moonshot → Google → Cloudflare
- `scanner_fastpath`: MiniMax → Google → Moonshot → Cloudflare
- `synthesis_long_context`: Moonshot → Google → Anthropic → Cloudflare
- `cheap_enrichment`: Google → MiniMax → Moonshot → Cloudflare

Cloudflare Workers AI is always available as last resort (uses env.AI binding, not API key).

## Rollback

1. Set circuit breaker to `HALT`.
2. Disable strategy execution policies.
3. Cancel outstanding orders.
4. Run reconciliation and preserve evidence.
5. Open postmortem using `docs/POSTMORTEM_TEMPLATE.md`.

---

## Deployment Validation History

### 2026-02-28: LLM Governance Hardening Deployment

**Deployment ID:** aa4dbcb9-064d-401c-b9d7-b3dac5b956ef
**Commits:** ad18ee4, 1621b23, 3d10aa0, 46aad5b, d7f0d66

**Components Deployed:**
- LLM executor with fail-closed policy (`src/lib/llm/executor.ts` - 424 lines)
- Complete routing policy engine (`src/lib/llm/routing.policy.ts` - 833 lines)
- Drift sweep detection and blocking (`src/lib/llm/drift-sweeps.ts` - 188 lines)
- Hardened admin routes with phase gates (`src/routes/admin.ts` - 884 lines)
- Fail-closed Kalshi RSA-PSS auth (`src/lib/kalshi/auth.ts`)
- Database migrations 0018-0019 (LLM routing tables)

**Validation Results:**

**Phase 1: Deployment Validation** ✅
- Full Test Suite: **667 tests passed** across 25 test files
- No regressions detected
- Test Duration: 36.76s

**Database Migrations:** ✅
- Migration 0018 (llm_routing.sql): Applied successfully
- Migration 0019 (llm_routing_audit_fields.sql): Applied successfully
- Tables created:
  - `llm_routing_decisions` (routing audit log)
  - `llm_budget_usage` (budget tracking)
  - `llm_drift_sweeps` (drift detection)
- Views created:
  - `v_daily_budget_summary`
  - `v_monthly_budget_summary`
  - `v_routing_success_rate`

**Critical Test Coverage Validated:**
- CLV computation (P-01): 26 tests ✓
- Risk invariants (all 17 checks): 57 tests ✓
- LLM routing policy: 16 unit tests, 3 integration tests ✓
- Order lifecycle state machine: 73 tests ✓
- Kalshi RSA-PSS auth: 5 tests ✓
- Admin trade history: 4 tests ✓
- Account skill scoring: 19 tests ✓
- Evidence-first pattern: 20 tests ✓
- Kelly sizing: 23 tests ✓
- Circuit breaker state machine: 26 tests ✓
- LLM governance: 55 tests ✓

**Deployment Health:** ✅
- Worker deployed successfully
- All Cloudflare bindings configured:
  - D1 Databases: paul-p-primary, paul-p-anchor
  - R2 Buckets: paul-p-audit, paul-p-evidence
  - KV Namespace: KV_CACHE
  - Queues: 4 producers + 4 consumers
  - Durable Objects: 14 classes
  - Cron Triggers: 7 scheduled jobs

**LLM Provider Failover Chain:**
- Premium Cognition: Anthropic → Moonshot → Google → Cloudflare Workers AI
- Scanner Fastpath: MiniMax → Google → Moonshot → Cloudflare Workers AI
- Synthesis Long Context: Moonshot → Google → Anthropic → Cloudflare Workers AI
- Cheap Enrichment: Google → MiniMax → Moonshot → Cloudflare Workers AI

**Fail-Closed Mechanisms Verified:**
- LLM routing: Invalid overrides → reject request ✓
- Budget enforcement: Exhausted provider → skip to next in chain ✓
- Drift sweeps: Score >0.7 → block request ✓
- Kalshi auth: Missing credentials → fail-closed ✓
- Admin auth: Invalid token → 401 Unauthorized ✓

**Next Steps:**
- Phase 2→3 Gate Preparation:
  - Complete bonding + weather strategy E2E tests
  - Validate evidence-first pattern in all API calls
  - Paper trading validation (10+ simulated trades)
  - Risk Governor integration testing

**Operational Notes:**
- All LLM provider keys must be configured (fail-closed policy)
- Circuit breaker state: NORMAL (default)
- No drift sweeps detected
- Budget tracking enabled for all 4 categories
