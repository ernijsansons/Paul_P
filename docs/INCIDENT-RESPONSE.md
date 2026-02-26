# Paul P Incident Response

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## Severity Levels

- `S1`: Trading integrity risk, data corruption risk, or uncontrolled exposure
- `S2`: Material execution degradation or repeated risk-control failures
- `S3`: Partial feature outage with bounded risk impact
- `S4`: Non-critical issue, no direct trading risk

## Immediate Actions

1. Declare incident and assign incident commander.
2. If risk integrity is uncertain, halt trading immediately.
3. Preserve current logs, evidence, and audit state.
4. Start timeline capture in UTC.

## Emergency Controls

- Halt trading:
```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetState":"HALT","reason":"incident-response"}' \
  https://<worker-domain>/admin/circuit-breaker/transition
```

- Force reconciliation:
```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<worker-domain>/admin/reconcile
```

- Verify audit chain status:
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<worker-domain>/admin/audit/status
```

## Investigation Checklist

- Confirm affected strategies, venues, and time window.
- Validate invariant outcomes around the incident interval.
- Compare internal order lifecycle state vs venue-reported positions.
- Validate evidence hash integrity for key source payloads.
- Check latest drift sweep and prompt regression results for governance regressions.

## Recovery Criteria

- Root cause identified and patched.
- Reconciliation drift resolved to within tolerance.
- Audit chain integrity verified.
- Required approvals recorded before resuming live mode.

## Closure

1. Document full postmortem using `docs/POSTMORTEM_TEMPLATE.md`.
2. Track corrective actions with owners and due dates.
3. Update runbook/SLO/security docs if controls changed.
