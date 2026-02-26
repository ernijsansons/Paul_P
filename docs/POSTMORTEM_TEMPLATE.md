# Incident Postmortem: [INCIDENT_ID]

**Date:** YYYY-MM-DD
**Severity:** [S1/S2/S3/S4]
**Author:** [Name]
**Reviewed By:** [Names]

## Summary

[1-2 sentence description of what happened]

## Impact

- **Duration:** [Start time] to [End time] ([X hours/minutes])
- **Affected Systems:** [List affected components]
- **Financial Impact:** $[amount] (if applicable)
- **Users/Positions Affected:** [count]

## Timeline (UTC)

| Time | Event |
|------|-------|
| HH:MM | [What happened] |
| HH:MM | [What happened] |
| HH:MM | [Resolution] |

## Root Cause Analysis

### What Happened

[Detailed technical explanation of the failure]

### Why It Happened

[Chain of causation - use 5 Whys technique]

1. Why? [Direct cause]
2. Why? [Contributing factor]
3. Why? [Deeper cause]
4. Why? [Systemic issue]
5. Why? [Root cause]

### Detection

- **How was this detected?** [Monitoring alert / User report / Manual observation]
- **Detection delay:** [Time between incident start and detection]
- **Was this detected by our monitoring?** [Yes/No - if No, explain why]

## Response

### Immediate Actions

1. [Action taken]
2. [Action taken]

### What Went Well

- [Positive aspect of response]
- [Positive aspect of response]

### What Could Have Been Better

- [Area for improvement]
- [Area for improvement]

## Invariant Analysis

### Invariants Tested During Incident

| Invariant | Status | Notes |
|-----------|--------|-------|
| I-01 (Max Position) | PASS/FAIL | [Notes] |
| I-02 (Max Concentration) | PASS/FAIL | [Notes] |
| [etc.] | | |

### Invariants That Should Have Caught This

| Invariant | Expected Behavior | Actual Behavior | Gap Analysis |
|-----------|------------------|-----------------|--------------|
| [ID] | [Expected] | [Actual] | [Why gap exists] |

## Action Items

### Immediate (< 24 hours)

| Action | Owner | Status | Due Date |
|--------|-------|--------|----------|
| [Action] | [Name] | TODO/DONE | [Date] |

### Short-term (< 1 week)

| Action | Owner | Status | Due Date |
|--------|-------|--------|----------|
| [Action] | [Name] | TODO/DONE | [Date] |

### Long-term (< 1 month)

| Action | Owner | Status | Due Date |
|--------|-------|--------|----------|
| [Action] | [Name] | TODO/DONE | [Date] |

## Prevention

### Code Changes Required

- [ ] [Change 1 - link to PR]
- [ ] [Change 2 - link to PR]

### Process Changes Required

- [ ] [Process change 1]
- [ ] [Process change 2]

### Monitoring Improvements

- [ ] [New alert or dashboard]
- [ ] [Threshold adjustment]

### Runbook Updates

- [ ] [Update runbook X]
- [ ] [Create new runbook Y]

## Circuit Breaker Analysis

### State Transitions During Incident

```
[State] -> [State] @ HH:MM (reason)
[State] -> [State] @ HH:MM (reason)
```

### Should Circuit Breaker Have Activated Earlier?

[Yes/No - explain]

## Audit Trail Verification

- **Audit chain intact during incident:** [Yes/No]
- **All events captured:** [Yes/No]
- **Evidence stored in R2:** [Yes/No]
- **Anchor verification:** [Last anchor before incident]

## Lessons Learned

1. [Key lesson]
2. [Key lesson]
3. [Key lesson]

## References

- [Link to relevant docs]
- [Link to monitoring dashboards]
- [Link to related PRs]

---

## Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Incident Commander | | | |
| Engineering Lead | | | |
| Risk Owner | | | |

---

**Severity Definitions:**

- **S1 (Critical):** Trading halted, capital at risk, data integrity compromised
- **S2 (High):** Significant trading degradation, partial system failure
- **S3 (Medium):** Minor trading impact, non-critical system issues
- **S4 (Low):** Minimal impact, cosmetic issues, documentation gaps
