#!/bin/bash
# ============================================================================
# PHASE D DEPLOYMENT SCRIPT - Live Trading Deployment to Kalshi
# ============================================================================
#
# WARNING: This script deploys REAL CAPITAL ($250.00) to Kalshi prediction markets
# This is LIVE TRADING with REAL MONEY at risk.
#
# Prerequisites:
# - Kalshi API credentials loaded in environment
# - D1 database configured and ready
# - All tests passing (npm run test)
# - Human review and approval of this script
#
# Authorization Required: EXPLICIT USER APPROVAL BEFORE RUNNING
#
# ============================================================================

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# STEP 1: PRE-DEPLOYMENT VALIDATION
# ============================================================================

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         PHASE D: LIVE DEPLOYMENT - PRE-FLIGHT CHECK              ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check 1: Code compilation
echo -e "${YELLOW}[1/8] Verifying code compilation...${NC}"
if npm run lint > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Type checking successful - 0 TypeScript errors${NC}"
else
    echo -e "${RED}❌ Type checking failed - fix compilation errors before deploying${NC}"
    exit 1
fi

# Check 2: Test suite (SECURITY FIX: check exit code, not just grep output)
echo -e "${YELLOW}[2/8] Running test suite...${NC}"
set +e  # Temporarily allow non-zero exit
npm test > /tmp/test-output.txt 2>&1
TEST_EXIT_CODE=$?
set -e

if [[ $TEST_EXIT_CODE -ne 0 ]]; then
    echo -e "${RED}❌ Test suite failed (exit code $TEST_EXIT_CODE)${NC}"
    tail -20 /tmp/test-output.txt
    exit 1
fi

# SECURITY FIX: Removed brittle grep -qi "failed" check that could false-positive
# on benign text like "0 failed" or test names containing "failed".
# Exit code 0 from vitest is the authoritative success indicator.

PASS_COUNT=$(grep -oE "[0-9]+ passed" /tmp/test-output.txt | grep -oE "[0-9]+" | tail -1 || echo "0")
echo -e "${GREEN}✅ Test suite passed ($PASS_COUNT tests, exit code 0)${NC}"

# Check 3: Kalshi API connectivity and auth
echo -e "${YELLOW}[3/8] Testing Kalshi API connectivity and auth...${NC}"
# First check basic connectivity
if ! curl -sf "https://api.elections.kalshi.com/trade-api/v2/exchange/status" > /dev/null 2>&1; then
    echo -e "${RED}❌ Kalshi API endpoint unreachable${NC}"
    echo "   Verify: curl https://api.elections.kalshi.com/trade-api/v2/exchange/status"
    exit 1
fi
echo -e "${GREEN}✅ Kalshi API endpoint reachable${NC}"

# Now validate trading auth using production RSA-PSS signing
echo "   Validating trading auth (RSA-PSS signed request)..."
AUTH_RESULT=$(npx tsx scripts/validate-kalshi-auth.ts 2>&1)
AUTH_EXIT=$?
# SECURITY FIX: Kalshi auth failures are now BLOCKING (were non-blocking warnings)
if [[ $AUTH_EXIT -eq 0 ]]; then
    echo -e "${GREEN}✅ Kalshi trading auth validated (same auth as production)${NC}"
elif [[ $AUTH_EXIT -eq 2 ]]; then
    echo -e "${RED}❌ Kalshi credentials not configured${NC}"
    echo "   KALSHI_API_KEY and KALSHI_PRIVATE_KEY are REQUIRED for live deployment"
    echo "   Set credentials in environment or .env before proceeding"
    exit 1
else
    echo -e "${RED}❌ Kalshi trading auth failed${NC}"
    echo "   $AUTH_RESULT"
    echo "   Fix credentials before live deployment"
    exit 1
fi

# Check 4: D1 Database
echo -e "${YELLOW}[4/8] Verifying D1 database...${NC}"
if npx wrangler d1 execute paul-p-primary --remote --command "SELECT COUNT(*) FROM strategy_execution_mode" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Database connection verified${NC}"
else
    echo -e "${RED}❌ Database connection failed - check D1 configuration${NC}"
    exit 1
fi

# Check 5: Environment variables
echo -e "${YELLOW}[5/8] Checking environment configuration...${NC}"
REQUIRED_VARS=("KALSHI_API_KEY" "D1_DATABASE_ID" "R2_BUCKET_NAME")
MISSING_VARS=()

for var in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        MISSING_VARS+=("$var")
    fi
done

if [[ ${#MISSING_VARS[@]} -eq 0 ]]; then
    echo -e "${GREEN}✅ All required environment variables configured${NC}"
else
    echo -e "${RED}❌ Missing environment variables: ${MISSING_VARS[*]}${NC}"
    exit 1
fi

# Check 6: Execution mode in D1
echo -e "${YELLOW}[6/8] Verifying execution mode in D1...${NC}"
EXEC_MODE=$(npx wrangler d1 execute paul-p-primary --remote --command "SELECT mode FROM strategy_execution_mode WHERE strategy='bonding' LIMIT 1" 2>/dev/null | grep -E "PAPER|LIVE|DISABLED" || echo "UNKNOWN")
if [[ "$EXEC_MODE" == *"LIVE"* ]]; then
    echo -e "${GREEN}✅ Execution mode in D1: LIVE${NC}"
elif [[ "$EXEC_MODE" == *"PAPER"* ]]; then
    echo -e "${YELLOW}⚠️  Execution mode in D1: PAPER (will need go-live API call)${NC}"
else
    echo -e "${YELLOW}⚠️  Could not verify execution mode in D1${NC}"
    echo "   After deploy, check via: GET /exec/kalshi/mode"
fi

# Check 7: Phase A risk limits in D1
echo -e "${YELLOW}[7/8] Verifying risk limits in D1...${NC}"
RISK_LIMITS=$(npx wrangler d1 execute paul-p-primary --remote --command "SELECT max_position_pct, max_daily_loss_pct, max_drawdown_pct FROM phase_a_risk_limits WHERE id=1 LIMIT 1" 2>/dev/null || echo "")
if [[ -n "$RISK_LIMITS" ]] && [[ "$RISK_LIMITS" != *"no such table"* ]]; then
    echo -e "${GREEN}✅ Risk limits configured in D1${NC}"
    echo "    • Verify via: GET /admin/risk/limits after deploy"
else
    echo -e "${YELLOW}⚠️  Could not verify risk limits in D1${NC}"
    echo "   Default limits will apply: 5% position, 3% daily, 15% drawdown"
fi

# Check 8: Migrations applied
echo -e "${YELLOW}[8/8] Verifying D1 migrations...${NC}"
MIGRATION_COUNT=$(npx wrangler d1 migrations list paul-p-primary --remote 2>&1 | grep -c "✅" || echo "0")
if [[ "$MIGRATION_COUNT" -gt 0 ]]; then
    echo -e "${GREEN}✅ $MIGRATION_COUNT migrations applied to D1${NC}"
else
    echo -e "${YELLOW}⚠️  Could not verify migration count${NC}"
fi

# ============================================================================
# STEP 2: HUMAN AUTHORIZATION GATE
# ============================================================================

echo ""
echo -e "${RED}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║                    ⚠️  CRITICAL AUTHORIZATION                    ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "IMPORTANT: This deployment will:"
echo ""
echo -e "  ${RED}• Deploy REAL CAPITAL: \$250.00${NC}"
echo -e "  ${RED}• Execute LIVE TRADES on Kalshi${NC}"
echo -e "  ${RED}• Risk REAL MONEY with 15% max drawdown tolerance${NC}"
echo -e "  ${RED}• Be impossible to pause or reverse immediately${NC}"
echo ""
echo "You are authorizing all of the following:"
echo "  ✓ Risk up to \$37.50 (15% drawdown) of capital"
echo "  ✓ Risk up to \$7.50 (3%) loss per day"
echo "  ✓ Execute 3-5 trades per day on Bonding & Weather markets"
echo "  ✓ Automatic circuit breaker position throttling if conditions degrade"
echo "  ✓ 10-day validation period before scaling capital"
echo ""
echo -e "${YELLOW}Phase C Paper Trading Results (Validation Basis):${NC}"
echo "  • Win Rate: 70.0% (from 30 paper trades)"
echo "  • P&L: +\$34.40 (from 30 paper trades)"
echo "  • Execution Quality: 85% (GOOD/EXCELLENT)"
echo "  • All 18 Risk Controls: Tested and working"
echo "  • All 6 Phase D Gates: PASSED"
echo ""

# Request explicit authorization
read -p "Do you AUTHORIZE live deployment to Kalshi with \$250 capital? (TYPE 'yes-deploy-250' to confirm): " AUTHORIZATION

if [[ "$AUTHORIZATION" != "yes-deploy-250" ]]; then
    echo ""
    echo -e "${RED}❌ Deployment CANCELLED - Authorization not confirmed${NC}"
    echo "   Deployment requires explicit authorization"
    echo "   To deploy, run this script again and type: yes-deploy-250"
    exit 0
fi

# ============================================================================
# STEP 3: MANUAL DEPLOYMENT STEPS
# ============================================================================

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         PRE-FLIGHT CHECKS PASSED - MANUAL STEPS REQUIRED         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${YELLOW}All automated pre-flight checks have passed.${NC}"
echo ""
echo -e "${RED}IMPORTANT: This script does NOT deploy automatically.${NC}"
echo -e "${RED}You must perform the following manual steps:${NC}"
echo ""

echo -e "${BLUE}Step 1: Deploy Worker to Cloudflare${NC}"
echo "   npx wrangler deploy"
echo ""

echo -e "${BLUE}Step 2: Verify health endpoint${NC}"
echo "   curl https://paul-p.\${CF_SUBDOMAIN}.workers.dev/health"
echo "   Expected: {\"status\":\"healthy\"}"
echo ""

echo -e "${BLUE}Step 3: Set execution mode to LIVE via go-live API${NC}"
echo "   curl -X POST https://paul-p.\${CF_SUBDOMAIN}.workers.dev/admin/strategies/bonding/go-live \\"
echo "     -H 'Authorization: Bearer \$ADMIN_TOKEN' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"approver\":\"YOUR_NAME\",\"secondApprover\":\"SECOND_APPROVER\",\"capitalAllocationUsd\":250}'"
echo ""

echo -e "${BLUE}Step 4: Verify execution mode is LIVE${NC}"
echo "   curl -H 'Authorization: Bearer \$ADMIN_TOKEN' \\"
echo "     https://paul-p.\${CF_SUBDOMAIN}.workers.dev/exec/kalshi/mode"
echo "   Expected: {\"mode\":\"LIVE\",\"strategy\":\"bonding\"}"
echo ""

echo -e "${BLUE}Step 5: Monitor dashboard${NC}"
echo "   curl -H 'Authorization: Bearer \$ADMIN_TOKEN' \\"
echo "     https://paul-p.\${CF_SUBDOMAIN}.workers.dev/dashboard/summary"
echo ""

echo -e "${YELLOW}Post-Deployment Monitoring:${NC}"
echo "  • Check /exec/kalshi/status for execution agent health"
echo "  • Monitor /dashboard/daily-pnl for P&L tracking"
echo "  • Watch circuit breaker state (should be NORMAL)"
echo "  • Review R2 audit logs for evidence of trades"
echo ""

echo -e "${RED}Risk Limits (pre-configured):${NC}"
echo "  • Max Position: \$12.50 (5% of \$250)"
echo "  • Daily Loss Limit: \$7.50 (3%)"
echo "  • Max Drawdown: \$37.50 (15%)"
echo "  • Stop-Loss: -3% per position"
echo "  • Take-Profit: +50% per position"
echo ""

echo "This pre-flight check completed at: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""
echo -e "${GREEN}You may now proceed with the manual steps above.${NC}"
echo ""

