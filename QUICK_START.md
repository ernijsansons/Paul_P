# Paul P: Quick Start Guide

**For**: Executing Phases C, D, E from this point forward
**Time to Read**: 5 minutes
**Prerequisites**: All Phases A-B-C completed (see PROJECT_STATUS.md)

---

## TL;DR - What To Do Now

### Option 1: Execute Phase C (48-Hour Paper Trading)

```bash
# Start Phase C tests
./run-phase-c.sh

# Monitor progress
# - Check logs in output directory
# - Update PHASE_C_AUDIT.md with results
# - Evaluate Phase C gate decision (top of PHASE_C_AUDIT.md)

# Expected outcome after 48 hours:
# - All 8 scenarios (S1-S8) executed
# - 30 paper trades completed
# - SQL validation run (8 groups)
# - Dashboard verified (4 endpoints)
# - Phase D decision: GO or NO-GO
```

### Option 2: Deploy Phase D Live (If Phase C Passed)

```bash
# Follow PHASE_D_DEPLOYMENT.md step-by-step:
# 1. Pre-deployment verification (30 min)
# 2. Switch execution mode: PAPER → LIVE
# 3. Deploy Risk Governor Agent
# 4. Start Position Monitor (5-min intervals)
# 5. Test dashboard endpoints
# 6. Enable alerts (Slack + Email)
# 7. Final health check
# 8. GO LIVE with $250 capital

# Duration: ~2 hours total

# Then monitor for 10 days using daily templates in PHASE_D_DEPLOYMENT.md
```

### Option 3: Scale Phase E (If Phase D Passed)

```bash
# Day 15: Scale $250 → $500
# Day 25: Scale $500 → $1K
# Day 31+: Conditional scaling to $5K+

# Follow PHASE_E_SCALING.md for procedures
```

---

## Document Map (Where To Find What)

### Execution Documents

| Need | Document | Purpose |
|------|----------|---------|
| **How to run Phase C tests** | PHASE_C_EXECUTION.md | Hour-by-hour 48-hour timeline |
| **Before starting Phase C** | PHASE_C_EXECUTION_READY.md | 15-item pre-flight checklist |
| **Recording Phase C results** | PHASE_C_AUDIT.md | Audit template to populate |
| **How to deploy Phase D** | PHASE_D_DEPLOYMENT.md | 8-step deployment + 10-day validation |
| **How to scale Phase E** | PHASE_E_SCALING.md | Scaling procedures and gates |
| **Overall project status** | PROJECT_STATUS.md | Comprehensive project overview |

### Running Tests & Deployment

| File | Purpose |
|------|---------|
| `run-phase-c.sh` | Automated Phase C test execution (48 hours) |
| `src/lib/testing/paper-harness.ts` | Paper trading test harness (8 scenarios) |
| `src/scripts/phase-c-validation.sql` | SQL validation suite (8 groups, 30+ queries) |

### Reference Documents

| Document | Use When |
|----------|----------|
| COMPLETION_SUMMARY.md | Need quick overview of what was built |
| This file (QUICK_START.md) | Getting started or need quick navigation |

---

## Decision Tree: Which Phase Are You In?

### Haven't Started Phase C Yet?

```
START HERE → PHASE_C_EXECUTION_READY.md
  ↓
  Run 15-item pre-flight checklist
  ↓
  All items green? → YES → Proceed
                  → NO  → Remediate issues
  ↓
PHASE_C_EXECUTION.md
  ↓
  Run: ./run-phase-c.sh
  ↓
  Monitor for 48 hours
  ↓
PHASE_C_AUDIT.md
  ↓
  Record results
  ↓
  Evaluate Phase C gates:
  - Scenarios: 8/8? ✓
  - Win rate ≥50%? ✓
  - P&L ≥$0? ✓
  - Quality ≥80%? ✓
  - CB working? ✓
  - Errors: 0? ✓
  ↓
  ALL YES → Phase C GO → Proceed to Phase D
  ANY NO  → Phase C NO-GO → Fix and retry Phase C
```

### Phase C Complete & GO Decision Made?

```
START HERE → PHASE_D_DEPLOYMENT.md
  ↓
  Pre-deployment verification (Step 1, 30 min)
  ↓
  All checks pass? → YES → Proceed
                  → NO  → Remediate
  ↓
  Follow 8-step deployment (Steps 2-8, ~90 min total)
  ↓
  LIVE with $250 capital
  ↓
  Monitor for 10 days using daily templates
  ↓
  Day 10 evaluation:
  - Win rate ≥50%? ✓
  - P&L ≥$0? ✓
  - DD ≤15%? ✓
  - Quality ≥80%? ✓
  - CB no false pos? ✓
  - Errors: 0? ✓
  ↓
  ALL YES → Phase D GO → Proceed to Phase E
  ANY NO  → Phase D NO-GO → Hold at $250, analyze
```

### Phase D Complete & Successful?

```
START HERE → PHASE_E_SCALING.md
  ↓
  Day 15: Scale to $500
  ↓
  Monitor Days 15-20
  ↓
  Continued success? → YES → Proceed to $1K
                   → NO  → Hold at $500, analyze
  ↓
  Day 25: Scale to $1K
  ↓
  Monitor Days 25-30
  ↓
  Continued success? → YES → Evaluate for $5K+ scaling
                   → NO  → Hold at $1K, analyze
  ↓
  Day 31+: Conditional scaling based on:
  - 20+ days consistent success
  - Sharpe > 1.0
  - Drawdown < 10%
  ↓
  Scale to $5K+ per decision matrix in PHASE_E_SCALING.md
```

---

## Critical Gates & Decision Points

### Phase C Gate (After 48-Hour Tests)

**GO Decision** (ALL must be true):
- [ ] Test Scenarios: 8/8 passed
- [ ] Win Rate: ≥50%
- [ ] P&L: ≥$0
- [ ] Execution Quality: ≥80% GOOD/EXCELLENT
- [ ] Circuit Breaker: No false positives
- [ ] Critical Errors: 0

**NO-GO Decision** (Any is true):
- [ ] Test Scenarios: <8/8 passed
- [ ] Win Rate: <50%
- [ ] P&L: <$0
- [ ] Execution Quality: <80%
- [ ] Circuit Breaker: False positives detected
- [ ] Critical Errors: >0

**If NO-GO**: Analyze failure mode and remediate (typically 1-2 weeks)

---

### Phase D Gate (After 10-Day Live Trading)

**GO Decision to Phase E** (ALL must be true):
- [ ] Win Rate (10 days): ≥50%
- [ ] Cumulative P&L: ≥$0
- [ ] Max Drawdown: ≤15% ($37.50)
- [ ] Execution Quality: ≥80% GOOD/EXCELLENT
- [ ] Circuit Breaker: No false positives
- [ ] Critical Errors: 0

**NO-GO Decision** (Hold at $250):
- [ ] Win Rate: <50%
- [ ] P&L: <$0
- [ ] Drawdown: >15%
- [ ] Quality: <80%
- [ ] False positives detected
- [ ] Errors detected

**If NO-GO**: Extend Phase D validation or analyze strategy issues (2-4 weeks)

---

### Phase E Tier 1 Gate (After 10-Day $500 Trading)

**GO Decision to Tier 2 ($1K)** (ALL must be true):
- [ ] Win Rate (Days 11-20): ≥50%
- [ ] Cumulative P&L: ≥$0
- [ ] Sharpe Ratio: >1.0
- [ ] Max Drawdown: ≤15%
- [ ] No circuit breaker issues

**HOLD Decision** (Stay at $500):
- [ ] Any gate not passed
- [ ] Need more data (fewer than 10 days)

---

## Emergency Procedures

### If Something Goes Wrong

**Circuit Breaker HALT Triggered?**
```
HALT = All new orders blocked automatically

Action:
1. Check audit log: why did it trigger?
2. Is it legitimate? (2+ max-loss days = legitimate)
3. Wait 60 minutes for automatic timeout recovery
4. OR manually override: npm run config:set circuit_breaker_state NORMAL

Decision:
- If legitimate: Investigate strategy/market conditions
- If false positive: Debug and report as bug
```

**High Slippage on Trade?**
```
Slippage > 50% of edge = Kill Switch triggers

Action:
1. Market is halted automatically
2. Check order log for what went wrong
3. Verify depth estimate was correct
4. Check if Kalshi market liquidity unusually low

Decision:
- Resume normal trading
- OR reduce position sizes on illiquid markets
```

**System Crashes or Error?**
```
Action:
1. Switch to PAPER mode immediately:
   npm run config:set execution_mode PAPER

2. Investigate error in logs

3. Fix if possible

4. Restart system:
   npx wrangler deploy

5. Test on paper mode before going live again
```

---

## Quick Commands Reference

### Start Phase C
```bash
./run-phase-c.sh
```

### Check Current State
```bash
# Circuit breaker state
npm run config:get circuit_breaker_state
# Expected: NORMAL (before Phase D), LIVE (during Phase D)

# Execution mode
npm run config:get execution_mode
# Expected: PAPER (Phase C), LIVE (Phase D+)

# Capital
npm run db:query "SELECT total_capital FROM accounts WHERE id=1"
# Expected: 250 (Phase D), 500 (Day 15+), 1000 (Day 25+)
```

### Emergency Stop
```bash
# Switch to safe mode
npm run config:set execution_mode PAPER
npm run config:set circuit_breaker_state HALT
```

### Rebuild & Redeploy
```bash
npm run build
npx wrangler deploy
```

---

## Timeline At A Glance

```
NOW:           Phase A-B-C Complete
Day 1-2:       Execute Phase C (48-hour tests)
Day 2 Evening: Phase C GO/NO-GO decision
Day 3:         Phase D deployment (if Phase C GO)
Days 3-12:     Phase D validation (10 days)
Day 12 Evening: Phase D GO/NO-GO decision
Day 13-15:     Prepare to scale (if Phase D GO)
Day 15 AM:     Scale to $500
Days 15-24:    Phase E Tier 1 validation (10 days)
Day 24 Evening: Tier 1 GO/NO-GO decision
Day 25 AM:     Scale to $1K (if Tier 1 GO)
Days 25-34:    Phase E Tier 2 validation (10 days)
Day 34 Evening: Tier 2 GO/NO-GO decision
Day 35 AM:     Consider scale to $5K+ (if Tier 2 GO)
Days 35+:      Long-term operations

CRITICAL DATES:
- Day 2 evening: Phase C gate decision
- Day 12 evening: Phase D gate decision
- Day 24 evening: Phase E Tier 1 gate decision
- Day 34 evening: Phase E Tier 2 gate decision
```

---

## Success Looks Like

### Phase C Success (After 48 Hours)
- ✅ All 8 test scenarios passed
- ✅ 30 paper trades executed
- ✅ Win rate ≥50% (aim for 60%+)
- ✅ P&L ≥$0 (aim for +$5-30)
- ✅ Execution quality ≥80%
- ✅ Dashboard accurate
- ✅ Zero critical errors

### Phase D Success (After 10 Days)
- ✅ Live trading at $250 works
- ✅ Win rate ≥50% (aim for 55%+)
- ✅ P&L ≥$0 (aim for +$5-15)
- ✅ Drawdown ≤15% (aim for <5%)
- ✅ Execution quality ≥80%
- ✅ Circuit breaker functional
- ✅ Daily monitoring possible

### Phase E Tier 1 Success (After 10 More Days)
- ✅ $500 capital deployed
- ✅ Continued win rate ≥50%
- ✅ Sharpe ratio >1.0
- ✅ Consistent execution quality
- ✅ Ready to scale to $1K

### Phase E Tier 2 Success (After 10 More Days)
- ✅ $1K capital deployed
- ✅ 20+ days consistent edge
- ✅ Sharpe ratio >1.0
- ✅ Drawdown <10%
- ✅ Ready for $5K+ conditional scaling

---

## Monitoring Dashboard URLs

Once Phase D goes live, monitor these endpoints:

```
Summary:        http://localhost:8787/api/dashboard/summary
Positions:      http://localhost:8787/api/dashboard/positions
Daily P&L:      http://localhost:8787/api/dashboard/daily-pnl
Exec Quality:   http://localhost:8787/api/dashboard/execution-quality
```

Each shows:
- Current P&L
- Win rate
- Open positions
- Execution grades
- Slippage metrics
- Circuit breaker state

---

## Common Questions

**Q: What if Phase C fails?**
A: Extend Phase C, diagnose the issue (signal quality? execution? risk controls?), fix it, retry. Typically 2-3 weeks.

**Q: What if Phase D fails?**
A: Analyze which gate failed. If win rate low, check signal accuracy. If slippage high, verify execution algorithm. If drawdown excessive, verify position sizing. Then retry with improvements.

**Q: What's the minimum to start Phase D?**
A: Must have Phase C with all 6 gates passing AND pre-deployment checklist (15 items) all green.

**Q: Can I skip steps?**
A: No. Phase C validates assumptions. Phase D proves live execution. Phase E scaling only after D success. Each phase is gated.

**Q: How often should I check on things?**
A: Phase C: Monitor start, every 12 hours, then at end. Phase D: Daily. Phase E: Daily in first week, then weekly.

---

## Next Action

**Choose one**:

1. **If starting Phase C**: Read PHASE_C_EXECUTION_READY.md (pre-flight), then run `./run-phase-c.sh`

2. **If Phase C completed successfully**: Read PHASE_D_DEPLOYMENT.md (deployment), then execute 8-step procedure

3. **If Phase D completed successfully**: Read PHASE_E_SCALING.md (scaling), then execute scaling procedures on Day 15

---

**Status**: All Phases A-B-C complete. Ready to execute Phase C, D, or E per your timeline.

**Time to First Result**: 48 hours (Phase C completion)
