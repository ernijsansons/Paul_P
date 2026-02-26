# Paul P Disaster Recovery Plan

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## Objectives

- Protect trading/audit integrity under infrastructure failures
- Maintain recovery time and recovery point targets from `docs/SLO.md`
- Preserve immutable evidence and audit artifacts

## Recovery Priorities

1. Halt trading and preserve integrity
2. Restore control-plane visibility and audit verification
3. Restore execution and reconciliation safely
4. Resume strategy operation with explicit approval

## Backup Strategy

- D1 primary: scheduled exports + migration history
- D1 anchor: isolated anchor database with independent credentials
- R2 audit/evidence: immutable object retention policies
- KV cache: non-authoritative, can be rebuilt
- Durable Object state: reconstructed via reconciliation where needed

## Failover Procedure (High Level)

1. Set circuit breaker to `HALT`.
2. Verify scope of failure (D1, R2, queue, DO, or external venue outage).
3. Restore affected persistence tier from latest valid backup.
4. Re-run reconciliation to rebuild authoritative position state.
5. Verify audit chain continuity and anchor recency.
6. Re-enable execution only after go-live gate checks pass.

## DR Drill Cadence

- Quarterly full drill
- Include at least one simulated D1-primary outage scenario
- Record drill findings and remediation tasks

## Validation Checklist

- Recovered data matches expected row counts and checksums
- Reconciliation drift within policy bounds
- Critical invariants return to passing state
- Audit verification succeeds from genesis to head
- Incident report and postmortem completed
