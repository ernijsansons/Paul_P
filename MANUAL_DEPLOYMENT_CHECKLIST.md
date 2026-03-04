# 🚀 Phase D: Manual Deployment Checklist

**Status**: Ready for Live Deployment
**Capital**: $250.00
**Date**: 2026-03-03
**Action Required**: USER AUTHORIZATION & EXECUTION

---

## ⚠️ CRITICAL AUTHORIZATION GATE

**This deployment will commit REAL CAPITAL to LIVE TRADING.**

Before proceeding, you must explicitly authorize each step. This is not automatic.

### What You're Authorizing:

- ✅ Deploy $250.00 REAL CAPITAL to Kalshi
- ✅ Execute LIVE TRADES with automated trading signals
- ✅ Risk up to $37.50 (15% of capital) in drawdown
- ✅ Risk up to $7.50 (3%) loss per day
- ✅ Automatic circuit breaker position throttling
- ✅ 10-day validation period before scaling

### What Could Go Wrong:

- ❌ Signal generation could fail (check logs immediately)
- ❌ Market conditions could shift (volatility spike → circuit breaker activation)
- ❌ Execution could degrade (slippage > 50% edge → kill switch blocks market)
- ❌ Worst case: Lose $37.50 (15% of $250) in drawdown during validation

### What Makes This Safe:

- ✅ Paper trading validated edge (70% win rate)
- ✅ 18 fail-closed risk invariants tested
- ✅ Per-position stops at -3% (automatic loss limit)
- ✅ Daily loss cap at $7.50 (automatic halt if exceeded)
- ✅ Circuit breaker throttles position size on losses
- ✅ Kill switch blocks markets on bad execution quality
- ✅ 10-day validation period before capital scaling

---

## Pre-Deployment Checklist (Do Before Running Deploy Script)

### 🔧 Environment Setup

- [ ] **Kalshi API Credentials**
  - [ ] API key loaded in environment variable `KALSHI_API_KEY`
  - [ ] API secret loaded in environment variable `KALSHI_API_SECRET`
  - [ ] Test API connectivity: `curl -H "Authorization: Bearer $KALSHI_API_KEY" https://api.kalshi.com/health` → 200 OK response
  - Command to verify:
    ```bash
    echo "API Key loaded: ${KALSHI_API_KEY:0:10}..."
    ```

- [ ] **D1 Database Connection**
  - [ ] Cloudflare credentials configured in `wrangler.toml`
  - [ ] Database ID set correctly: `paul-p-primary`
  - [ ] Test connection: `npx wrangler d1 execute paul-p-primary --command "SELECT 1"`
  - Expected output: Query executed successfully

- [ ] **R2 Storage**
  - [ ] Bucket name configured: `paul-p-audit`
  - [ ] R2 API token loaded
  - [ ] Test write access: Create test file in R2

- [ ] **KV Cache**
  - [ ] Namespace configured: `paul-p-cache`
  - [ ] Cache enabled for market data

### 🏗️ Code Verification

- [ ] **Build Compilation**
  - [ ] Run: `npm run build`
  - [ ] Expected result: ✅ Build successful, 0 TypeScript errors
  - [ ] If errors: Do NOT deploy, fix errors first

- [ ] **Test Suite**
  - [ ] Run: `npm run test`
  - [ ] Expected result: ✅ 786+ tests passing
  - [ ] Check specifically:
    ```bash
    npm run test | grep -E "passing|failing"
    ```
  - [ ] If any failures: Do NOT deploy, fix test failures first

- [ ] **Type Checking**
  - [ ] Run: `npm run type-check`
  - [ ] Expected result: ✅ 0 type errors
  - [ ] If errors: Do NOT deploy

### 💰 Capital Configuration

- [ ] **Account Setup**
  - [ ] Kalshi account created and verified
  - [ ] Account linked to deployment credentials
  - [ ] Account contains $250.00 available capital
  - Verify:
    ```bash
    # This would be your actual verification
    # curl -H "Authorization: Bearer $KALSHI_API_KEY" \
    #   https://api.kalshi.com/account \
    #   | jq '.balance'
    # Expected: 250.00
    ```

- [ ] **Risk Limits Configured**
  - [ ] Max position: $12.50 (5% of $250)
  - [ ] Daily loss limit: $7.50 (3% of $250)
  - [ ] Max drawdown: $37.50 (15% of $250)
  - [ ] Verify in database:
    ```sql
    SELECT parameter_name, parameter_value, status
    FROM risk_limits
    WHERE capital_amount = 250
    ORDER BY parameter_name;
    ```
    Expected: 18 rows, all values correct

### 📊 Market Verification

- [ ] **Target Markets Online**
  - [ ] BONDING_YES_MARCH: Online, liquidity > $500
  - [ ] BONDING_NO_MARCH: Online, liquidity > $500
  - [ ] BONDING_YES_APRIL: Online, liquidity > $500
  - [ ] WEATHER_TEMP_72F: Online, liquidity > $500
  - [ ] WEATHER_RAIN_TOMORROW: Online, liquidity > $500
  - [ ] WEATHER_SNOW_WEEK: Online, liquidity > $500
  - Verify spread < 0.5% on each
  - Verify VPIN < 0.6 on each

- [ ] **Price Data Freshness**
  - [ ] All market prices updated within last 5 minutes
  - [ ] No stale data (>60 min old)

### 🔐 Security & Audit Trail

- [ ] **Audit Trail Active**
  - [ ] R2 evidence buckets created and accessible
  - [ ] Database audit_trail table ready for logging
  - [ ] All API calls will be logged before execution

- [ ] **Monitoring Active**
  - [ ] Dashboard endpoints configured
  - [ ] Daily P&L tracking ready
  - [ ] Circuit breaker state tracking ready
  - [ ] Kill switch monitoring armed

---

## 🚀 DEPLOYMENT EXECUTION (4 Steps)

### Step 1: Final Authorization Check

**Read this carefully:**

I am about to deploy $250.00 REAL CAPITAL to Kalshi prediction markets for automated trading.

This deployment will:
- Execute LIVE TRADES with real money
- Risk up to $37.50 (15% drawdown) during validation
- Be governed by 18 automated risk invariants
- Be monitored daily for 10 days before scaling

**Do you authorize this deployment?**

If YES, type the confirmation below and execute the deploy script.

### Step 2: Run Pre-Flight Checks

```bash
# From project root:

# Build check
npm run build
# Expected: ✅ Build successful

# Test check
npm run test
# Expected: ✅ 786+ tests passing

# Environment check
echo "Kalshi API: ${KALSHI_API_KEY:0:10}..."
echo "D1 Database: Configured"
echo "R2 Bucket: paul-p-audit"
echo "Capital: \$250.00"
```

**If all checks PASS (✅), proceed to Step 3**
**If any checks FAIL (❌), DO NOT PROCEED - fix issues first**

### Step 3: Execute Deployment Script

```bash
# Make script executable
chmod +x scripts/DEPLOY_PHASE_D.sh

# Run deployment
scripts/DEPLOY_PHASE_D.sh

# This will:
# 1. Run pre-flight validation
# 2. Request explicit authorization (type: yes-deploy-250)
# 3. Show 30-second countdown
# 4. Execute deployment (if you confirm)
# 5. Create PHASE_D_DEPLOYMENT_RECORD.txt
```

**IMPORTANT**: When prompted, type exactly: `yes-deploy-250`

This confirms you authorize live deployment with $250 capital.

### Step 4: Verify Deployment Success

```bash
# Check deployment record was created
ls -la PHASE_D_DEPLOYMENT_RECORD.txt

# Check deployment timestamp
cat PHASE_D_DEPLOYMENT_RECORD.txt | grep "DEPLOYMENT TIMESTAMP"

# Verify system is LIVE
tail -20 PHASE_D_DEPLOYMENT_RECORD.txt
```

Expected output:
```
✅ DEPLOYMENT COMPLETE
System Status: LIVE
Capital: $250.00
Execution Mode: LIVE
Risk Controls: ARMED (18/18)
```

---

## 📋 Post-Deployment Actions (Immediate)

### Within 5 Minutes After Deployment

- [ ] Check for first market signal
  - [ ] Is BONDING or WEATHER strategy generating signals?
  - [ ] Check logs for signal generation activity

- [ ] Monitor first trade execution
  - [ ] Expected: 1-3 trades within first 5-10 minutes
  - [ ] Check trade entry time, price, size
  - [ ] Verify stop-loss and take-profit levels set correctly

- [ ] Check dashboard endpoints
  ```bash
   curl http://localhost:8000/api/dashboard/summary
   curl http://localhost:8000/api/dashboard/positions
   curl http://localhost:8000/api/dashboard/daily-pnl
   curl http://localhost:8000/api/dashboard/execution-quality
  ```
  Expected: 4 endpoints responding with JSON data

### Within 1 Hour After Deployment

- [ ] First checkpoint (1 hour in)
  - [ ] Number of trades executed: ________
  - [ ] Total P&L: $________
  - [ ] Win rate: ____%
  - [ ] Circuit breaker state: NORMAL / CAUTION / HALT
  - [ ] Any alerts triggered: YES / NO

- [ ] Log to PHASE_D_DAILY_LOG.md (copy from monitoring template)

- [ ] Review first trades
  - [ ] Execution quality: EXCELLENT / GOOD / ACCEPTABLE / POOR
  - [ ] Slippage: Within budget? YES / NO
  - [ ] Stop-losses working? YES / NO
  - [ ] Take-profits working? YES / NO

### Within 24 Hours After Deployment (Day 1 End-of-Day)

- [ ] Complete Day 1 daily log
  - [ ] Total trades: ________
  - [ ] Wins: _____ (____%)
  - [ ] Losses: _____
  - [ ] Daily P&L: $________
  - [ ] Max drawdown: ____%
  - [ ] Circuit breaker: NORMAL / CAUTION / HALT

- [ ] Check all 18 invariants
  - [ ] All tests passed during trading? YES / NO
  - [ ] Any false positives? YES / NO

- [ ] Verify audit trail
  - [ ] Evidence logged to R2: YES / NO
  - [ ] Database records created: YES / NO
  - [ ] Execution reports populated: YES / NO

---

## 🚨 CRITICAL ALERTS - What to Do If They Happen

### Alert 1: Circuit Breaker Enters CAUTION

**If this happens**:
Position size is halved to $6.25 automatically

**Action**:
- [ ] Investigate why (2 consecutive losses?)
- [ ] Check market conditions (volatility spike?)
- [ ] Monitor closely next 60 minutes
- [ ] Expect automatic recovery or manual intervention needed

### Alert 2: Kill Switch Triggers on a Market

**If this happens**:
That market is blocked from new orders (execution quality degraded)

**Action**:
- [ ] Review the slippage on that market
- [ ] Check if market conditions changed (depth dropped, spread widened)
- [ ] Reduce position size on that market, or
- [ ] Skip that market entirely, trade other markets

### Alert 3: Daily Loss Exceeds $5.00 (67% of daily limit)

**If this happens**:
You're approaching the $7.50 daily loss limit

**Action**:
- [ ] Reduce position sizing immediately
- [ ] Monitor closely - next loss might trigger HALT
- [ ] Check if there's a market regime issue
- [ ] Consider suspending new orders if losses continue

### Alert 4: Daily Loss Hits $7.50 (Daily Loss Limit)

**If this happens**:
HALT state is triggered, all new orders blocked

**Action**:
- [ ] STOP - no new orders
- [ ] Let existing positions close via stops/take-profits
- [ ] Wait 1-2 hours for positions to close
- [ ] Investigate what went wrong
- [ ] Do NOT resume trading until root cause identified

### Alert 5: Win Rate Below 40% After 10 Trades

**If this happens**:
Signal quality degraded or market regime changed

**Action**:
- [ ] Review the failing strategy (BONDING or WEATHER?)
- [ ] Check for macro events (market surprise, news event)
- [ ] Consider suspending that strategy temporarily
- [ ] Continue with other strategy only

---

## ✅ Sign-Off Before Deployment

**I understand and accept the following:**

- [ ] I have reviewed all pre-deployment checklist items
- [ ] I have verified code compiles (0 errors) and tests pass (786+)
- [ ] I have verified Kalshi API credentials are configured
- [ ] I have verified D1 database is ready
- [ ] I have verified I have $250.00 capital available
- [ ] I understand this is LIVE TRADING with REAL CAPITAL at risk
- [ ] I understand risk tolerance: max 15% drawdown ($37.50)
- [ ] I understand daily loss limit: $7.50 (3% of capital)
- [ ] I understand this is a 10-day validation window
- [ ] I understand scaling to $500+ depends on Day 10 results
- [ ] I will monitor daily and log results to PHASE_D_DAILY_LOG.md
- [ ] I will check alerts and take immediate action if thresholds exceeded
- [ ] I will NOT intervene with manual trades (system is fully automated)
- [ ] I authorize the deployment script to execute

---

## Manual Deployment Approval

To proceed with deployment, you must explicitly confirm:

1. **Type the authorization phrase below exactly as written:**
   ```
   I AUTHORIZE PHASE D DEPLOYMENT - $250 CAPITAL TO KALSHI
   ```

2. **Execute the deployment script:**
   ```bash
   scripts/DEPLOY_PHASE_D.sh
   ```

3. **When prompted for confirmation, type:**
   ```
   yes-deploy-250
   ```

4. **Wait for 30-second countdown, then system goes LIVE**

---

## After Deployment - What Happens Next

### Automated Operations (Require No Action)
- ✅ Market data feeds stream continuously
- ✅ Bonding & Weather signals generate automatically
- ✅ LLM resolution scoring runs continuously
- ✅ All 18 risk invariants checked on every order
- ✅ Orders submitted automatically based on signals
- ✅ Stop-losses, take-profits, time-exits enforced automatically
- ✅ Circuit breaker state machine manages position sizing
- ✅ Kill switches block bad markets automatically
- ✅ Audit trail logs all transactions

### Manual Operations (You Must Do)
- [ ] Daily checkpoint (morning & end-of-day)
- [ ] Log daily metrics to PHASE_D_DAILY_LOG.md
- [ ] Monitor for alert conditions
- [ ] Take action if any alert thresholds exceeded
- [ ] Day 5: Mid-week review and assessment
- [ ] Day 10: Calculate Sharpe ratio, decide on scaling

### Expected Performance (First 10 Days)

Based on Phase C paper trading results:

**Conservative Estimate**:
- Win rate: 50% (vs paper 70%)
- 3 trades/day × 10 days = 30 trades
- Expected P&L: +$0 to +$10 (conservative)
- Max drawdown: 2-8% (well within 15% limit)

**Base Estimate** (Most Likely):
- Win rate: 60-70% (matching paper)
- 3-4 trades/day × 10 days = 30-40 trades
- Expected P&L: +$20 to +$40 (from paper baseline)
- Max drawdown: 2-8%

**Optimistic Estimate**:
- Win rate: 75%+
- 4 trades/day × 10 days = 40 trades
- Expected P&L: +$40+ (above paper)
- Max drawdown: <5%

---

## Questions to Consider Before Deploying

**Am I ready to lose $37.50 (15% of capital) during validation?**
- YES: Proceed
- NO: Scale down capital, or delay deployment until more confident

**Do I trust the 70% win rate from paper trading?**
- YES: Paper testing showed real edge
- NO: Consider additional backtesting first

**Can I commit 10 days of daily monitoring?**
- YES: I can check daily and log metrics
- NO: Delay deployment until you have capacity

**Do I understand the automation?**
- YES: System is fully automated, no manual intervention needed
- NO: Review the system architecture first

**Am I prepared for the worst case?**
- YES: I understand $37.50 (15%) drawdown is possible
- NO: Reduce capital or risk tolerance first

---

## 🚀 Ready to Deploy?

If you've completed all checklist items and answered YES to all questions above:

**Run this command:**
```bash
scripts/DEPLOY_PHASE_D.sh
```

And follow the prompts to authorize and deploy Phase D with $250 capital to Kalshi.

---

**Document Version**: 1.0
**Status**: Ready for User Execution
**Created**: 2026-03-03 22:50 UTC
**Next Step**: User reviews and executes deployment script

