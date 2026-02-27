/**
 * Paul P - Order Lifecycle Integration Tests
 *
 * Tests the complete order lifecycle workflow:
 * - Order creation
 * - State machine transitions
 * - Pre-trade checks
 * - Risk validation
 * - Execution and fills
 * - Reconciliation
 * - CLV calculation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  type OrderLifecycle,
  type OrderState,
  type PreTradeCheckResult,
  type ReconciliationResult,
  type WorkflowContext,
  createOrderLifecycle,
  transitionOrder,
  isValidTransition,
  stepValidate,
  stepPreTradeCheck,
  stepApplyRiskResult,
  stepApplyExecutionResult,
  stepReconcile,
  stepArchive,
  stepPriceMoveCancel,
  stepOrderAcknowledged,
  recordFill,
  calculateCLV,
  isTerminalState,
  canRetry,
  prepareRetry,
  calculateWorkflowMetrics,
  serializeOrderLifecycle,
  deserializeOrderLifecycle,
} from '../../src/lib/execution/workflow';

// ============================================================
// 1. Order Creation Tests
// ============================================================

describe('Order Creation', () => {
  it('should create order with PENDING state', () => {
    const order = createOrderLifecycle(
      'signal-001',
      'bonding',
      'BTCPRICE-25DEC31-T100000',
      'YES',
      10,
      55
    );

    expect(order.currentState).toBe('PENDING');
    expect(order.signalId).toBe('signal-001');
    expect(order.strategy).toBe('bonding');
    expect(order.ticker).toBe('BTCPRICE-25DEC31-T100000');
    expect(order.side).toBe('YES');
    expect(order.requestedSize).toBe(10);
    expect(order.maxPrice).toBe(55);
    expect(order.filledSize).toBe(0);
    expect(order.retryCount).toBe(0);
  });

  it('should generate deterministic order ID', () => {
    const order1 = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    const order2 = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    const order3 = createOrderLifecycle('signal-002', 'bonding', 'TICKER', 'YES', 10, 55);

    // Same inputs = same ID
    expect(order1.orderId).toBe(order2.orderId);
    // Different signal = different ID
    expect(order1.orderId).not.toBe(order3.orderId);
  });

  it('should include optional signal parameters', () => {
    const order = createOrderLifecycle(
      'signal-001',
      'bonding',
      'TICKER',
      'YES',
      10,
      55,
      0.75,  // signalModelProbability
      0.05,  // signalEdge
      0.85   // signalConfidence
    );

    expect(order.signalModelProbability).toBe(0.75);
    expect(order.signalEdge).toBe(0.05);
    expect(order.signalConfidence).toBe(0.85);
  });

  it('should initialize timestamps correctly', () => {
    const before = new Date().toISOString();
    const order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    const after = new Date().toISOString();

    expect(order.createdAt).toBeDefined();
    expect(order.createdAt >= before).toBe(true);
    expect(order.createdAt <= after).toBe(true);
  });

  it('should have initial state history entry', () => {
    const order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);

    expect(order.stateHistory).toHaveLength(1);
    expect(order.stateHistory[0]!.from).toBe('PENDING');
    expect(order.stateHistory[0]!.to).toBe('PENDING');
    expect(order.stateHistory[0]!.reason).toBe('Order created');
  });
});

// ============================================================
// 2. State Machine Transition Tests
// ============================================================

describe('State Machine Transitions', () => {
  let order: OrderLifecycle;

  beforeEach(() => {
    order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
  });

  describe('Valid Transitions', () => {
    it('should allow PENDING → PRE_TRADE_CHECK', () => {
      expect(isValidTransition('PENDING', 'PRE_TRADE_CHECK')).toBe(true);
      const updated = transitionOrder(order, 'PRE_TRADE_CHECK', 'Starting pre-trade check');
      expect(updated.currentState).toBe('PRE_TRADE_CHECK');
    });

    it('should allow PENDING → VALIDATING (skip pre-trade)', () => {
      expect(isValidTransition('PENDING', 'VALIDATING')).toBe(true);
    });

    it('should allow PRE_TRADE_CHECK → VALIDATING', () => {
      expect(isValidTransition('PRE_TRADE_CHECK', 'VALIDATING')).toBe(true);
    });

    it('should allow VALIDATING → VALIDATED', () => {
      expect(isValidTransition('VALIDATING', 'VALIDATED')).toBe(true);
    });

    it('should allow VALIDATED → RISK_CHECK', () => {
      expect(isValidTransition('VALIDATED', 'RISK_CHECK')).toBe(true);
    });

    it('should allow RISK_CHECK → RISK_APPROVED', () => {
      expect(isValidTransition('RISK_CHECK', 'RISK_APPROVED')).toBe(true);
    });

    it('should allow RISK_APPROVED → SUBMITTING', () => {
      expect(isValidTransition('RISK_APPROVED', 'SUBMITTING')).toBe(true);
    });

    it('should allow SUBMITTING → SUBMITTED', () => {
      expect(isValidTransition('SUBMITTING', 'SUBMITTED')).toBe(true);
    });

    it('should allow SUBMITTED → FILLED', () => {
      expect(isValidTransition('SUBMITTED', 'FILLED')).toBe(true);
    });

    it('should allow FILLED → RECONCILED', () => {
      expect(isValidTransition('FILLED', 'RECONCILED')).toBe(true);
    });

    it('should allow RECONCILED → ARCHIVED', () => {
      expect(isValidTransition('RECONCILED', 'ARCHIVED')).toBe(true);
    });
  });

  describe('Invalid Transitions', () => {
    it('should not allow PENDING → FILLED (skipping steps)', () => {
      expect(isValidTransition('PENDING', 'FILLED')).toBe(false);
    });

    it('should not allow ARCHIVED → PENDING (terminal state)', () => {
      expect(isValidTransition('ARCHIVED', 'PENDING')).toBe(false);
    });

    it('should not allow REJECTED → SUBMITTED', () => {
      expect(isValidTransition('REJECTED', 'SUBMITTED')).toBe(false);
    });

    it('should throw on invalid transition', () => {
      expect(() => transitionOrder(order, 'FILLED')).toThrow('Invalid state transition');
    });
  });

  describe('State History Tracking', () => {
    it('should track all transitions in history', () => {
      let updated = transitionOrder(order, 'PRE_TRADE_CHECK', 'Reason 1');
      updated = transitionOrder(updated, 'VALIDATING', 'Reason 2');
      updated = transitionOrder(updated, 'VALIDATED', 'Reason 3');

      expect(updated.stateHistory).toHaveLength(4); // Initial + 3 transitions
      expect(updated.stateHistory[1]!.from).toBe('PENDING');
      expect(updated.stateHistory[1]!.to).toBe('PRE_TRADE_CHECK');
      expect(updated.stateHistory[2]!.from).toBe('PRE_TRADE_CHECK');
      expect(updated.stateHistory[2]!.to).toBe('VALIDATING');
      expect(updated.stateHistory[3]!.from).toBe('VALIDATING');
      expect(updated.stateHistory[3]!.to).toBe('VALIDATED');
    });

    it('should include transition metadata', () => {
      const updated = transitionOrder(
        order,
        'PRE_TRADE_CHECK',
        'Test reason',
        { customField: 'value' }
      );

      const lastTransition = updated.stateHistory[updated.stateHistory.length - 1]!;
      expect(lastTransition.reason).toBe('Test reason');
      expect(lastTransition.metadata).toEqual({ customField: 'value' });
    });
  });

  describe('Timestamp Updates', () => {
    it('should update validatedAt on VALIDATED transition', () => {
      let updated = transitionOrder(order, 'PRE_TRADE_CHECK');
      updated = transitionOrder(updated, 'VALIDATING');
      updated = transitionOrder(updated, 'VALIDATED');

      expect(updated.validatedAt).toBeDefined();
    });

    it('should update filledAt on FILLED transition', () => {
      // Walk through the full happy path
      let updated = order;
      updated = transitionOrder(updated, 'PRE_TRADE_CHECK');
      updated = transitionOrder(updated, 'VALIDATING');
      updated = transitionOrder(updated, 'VALIDATED');
      updated = transitionOrder(updated, 'RISK_CHECK');
      updated = transitionOrder(updated, 'RISK_APPROVED');
      updated = transitionOrder(updated, 'SUBMITTING');
      updated = transitionOrder(updated, 'SUBMITTED');
      updated = transitionOrder(updated, 'FILLED');

      expect(updated.filledAt).toBeDefined();
      expect(updated.closedAt).toBeDefined();
    });

    it('should update closedAt on terminal states', () => {
      // Test REJECTED
      let updated = transitionOrder(order, 'PRE_TRADE_CHECK');
      updated = transitionOrder(updated, 'VALIDATING');
      updated = transitionOrder(updated, 'REJECTED', 'Validation failed');

      expect(updated.closedAt).toBeDefined();
    });
  });
});

// ============================================================
// 3. Workflow Step Tests
// ============================================================

describe('Workflow Steps', () => {
  let order: OrderLifecycle;
  let ctx: WorkflowContext;

  beforeEach(() => {
    order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    ctx = { order };
  });

  describe('Pre-Trade Check Step', () => {
    it('should pass pre-trade check with valid microstructure', () => {
      const checkResult: PreTradeCheckResult = {
        passed: true,
        spread: 0.02,
        depth: 10000,
        vpinScore: 0.3,
      };

      const result = stepPreTradeCheck(ctx, checkResult);

      expect(result.order.currentState).toBe('VALIDATING');
      expect(result.order.preTradeCheckResult).toEqual(checkResult);
    });

    it('should fail pre-trade check with high VPIN', () => {
      const checkResult: PreTradeCheckResult = {
        passed: false,
        spread: 0.02,
        depth: 10000,
        vpinScore: 0.8, // Too high
        blockReason: 'VPIN exceeds threshold',
      };

      const result = stepPreTradeCheck(ctx, checkResult);

      expect(result.order.currentState).toBe('PRE_TRADE_FAILED');
      expect(result.order.lastError).toBe('VPIN exceeds threshold');
    });

    it('should fail pre-trade check with wide spread', () => {
      const checkResult: PreTradeCheckResult = {
        passed: false,
        spread: 0.15,
        depth: 10000,
        vpinScore: 0.3,
        blockReason: 'Spread too wide',
      };

      const result = stepPreTradeCheck(ctx, checkResult);

      expect(result.order.currentState).toBe('PRE_TRADE_FAILED');
    });
  });

  describe('Validation Step', () => {
    it('should validate order with valid parameters', () => {
      const result = stepValidate(ctx);

      expect(result.order.currentState).toBe('VALIDATED');
    });

    it('should reject order with missing ticker', () => {
      order.ticker = '';
      ctx = { order };

      const result = stepValidate(ctx);

      expect(result.order.currentState).toBe('REJECTED');
      expect(result.order.lastError).toContain('Missing ticker');
    });

    it('should reject order with invalid size', () => {
      order.requestedSize = 0;
      ctx = { order };

      const result = stepValidate(ctx);

      expect(result.order.currentState).toBe('REJECTED');
      expect(result.order.lastError).toContain('Invalid size');
    });

    it('should reject order with invalid price', () => {
      order.maxPrice = 150; // > 99
      ctx = { order };

      const result = stepValidate(ctx);

      expect(result.order.currentState).toBe('REJECTED');
      expect(result.order.lastError).toContain('Invalid price');
    });
  });

  describe('Risk Check Step', () => {
    beforeEach(() => {
      // Get to VALIDATED state first
      const validatedCtx = stepValidate(ctx);
      ctx = validatedCtx;
    });

    it('should approve with no violations', () => {
      const result = stepApplyRiskResult(ctx, true);

      expect(result.order.currentState).toBe('RISK_APPROVED');
      expect(result.order.riskCheckResult?.approved).toBe(true);
    });

    it('should reject with violations', () => {
      const result = stepApplyRiskResult(
        ctx,
        false,
        undefined,
        ['I5: Daily loss limit exceeded', 'I6: Max drawdown breached']
      );

      expect(result.order.currentState).toBe('RISK_REJECTED');
      expect(result.order.riskCheckResult?.violations).toHaveLength(2);
      expect(result.order.lastError).toContain('I5');
    });

    it('should apply adjusted size when approved', () => {
      const result = stepApplyRiskResult(ctx, true, 5); // Reduced from 10 to 5

      expect(result.order.currentState).toBe('RISK_APPROVED');
      expect(result.order.requestedSize).toBe(5);
    });
  });

  describe('Execution Step', () => {
    beforeEach(() => {
      // Get to RISK_APPROVED state
      ctx = stepValidate(ctx);
      ctx = stepApplyRiskResult(ctx, true);
    });

    it('should handle successful paper fill', () => {
      const result = stepApplyExecutionResult(ctx, {
        success: true,
        orderId: 'paper-001',
        mode: 'PAPER',
        status: 'paper_filled',
        executionTimeMs: 50,
        paperFill: {
          orderId: 'paper-001',
          ticker: 'TICKER',
          side: 'yes',
          action: 'buy',
          count: 10,
          fillPrice: 54,
          slippage: 0,
          timestamp: new Date().toISOString(),
        },
      });

      expect(result.order.currentState).toBe('FILLED');
      expect(result.order.filledSize).toBe(10);
      expect(result.order.avgFillPrice).toBe(54);
    });

    it('should handle live order submission', () => {
      const result = stepApplyExecutionResult(ctx, {
        success: true,
        orderId: 'live-001',
        mode: 'LIVE',
        status: 'submitted',
        executionTimeMs: 100,
      });

      expect(result.order.currentState).toBe('SUBMITTED');
    });

    it('should handle execution rejection', () => {
      const result = stepApplyExecutionResult(ctx, {
        success: false,
        orderId: '',
        mode: 'LIVE',
        status: 'rejected',
        executionTimeMs: 50,
        rejectionReason: 'Insufficient balance',
      });

      expect(result.order.currentState).toBe('REJECTED');
      expect(result.order.lastError).toBe('Insufficient balance');
    });
  });

  describe('Order Acknowledged Step', () => {
    beforeEach(() => {
      // Get to SUBMITTED state
      ctx = stepValidate(ctx);
      ctx = stepApplyRiskResult(ctx, true);
      ctx = stepApplyExecutionResult(ctx, {
        success: true,
        orderId: 'live-001',
        mode: 'LIVE',
        status: 'submitted',
        executionTimeMs: 100,
      });
    });

    it('should transition to ORDER_ACKNOWLEDGED', () => {
      const result = stepOrderAcknowledged(ctx, 'broker-order-123');

      expect(result.order.currentState).toBe('ORDER_ACKNOWLEDGED');
      expect(result.order.acknowledgedAt).toBeDefined();
    });

    it('should throw if not in SUBMITTED state', () => {
      ctx.order.currentState = 'PENDING' as OrderState;

      expect(() => stepOrderAcknowledged(ctx, 'broker-order-123')).toThrow(
        'not in SUBMITTED state'
      );
    });
  });

  describe('Price Move Cancel Step', () => {
    beforeEach(() => {
      ctx = stepValidate(ctx);
      ctx = stepApplyRiskResult(ctx, true);
      ctx = stepApplyExecutionResult(ctx, {
        success: true,
        orderId: 'live-001',
        mode: 'LIVE',
        status: 'submitted',
        executionTimeMs: 100,
      });
    });

    it('should cancel order on price move', () => {
      const result = stepPriceMoveCancel(ctx, 5.5, 5.0);

      expect(result.order.currentState).toBe('PRICE_MOVE_CANCEL');
      expect(result.order.closedAt).toBeDefined();
    });

    it('should throw if not in valid state', () => {
      ctx.order.currentState = 'PENDING' as OrderState;

      expect(() => stepPriceMoveCancel(ctx, 5.5, 5.0)).toThrow('not in valid state');
    });
  });
});

// ============================================================
// 4. Fill and CLV Tests
// ============================================================

describe('Fill Recording and CLV Calculation', () => {
  let order: OrderLifecycle;

  beforeEach(() => {
    order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    // Advance to SUBMITTED state
    order = transitionOrder(order, 'PRE_TRADE_CHECK');
    order = transitionOrder(order, 'VALIDATING');
    order = transitionOrder(order, 'VALIDATED');
    order = transitionOrder(order, 'RISK_CHECK');
    order = transitionOrder(order, 'RISK_APPROVED');
    order = transitionOrder(order, 'SUBMITTING');
    order = transitionOrder(order, 'SUBMITTED');
  });

  describe('CLV Calculation (P-01)', () => {
    it('should calculate positive CLV when entry < closing (edge)', () => {
      const clv = calculateCLV(0.50, 0.55);
      expect(clv).toBeCloseTo(0.05); // Positive = edge
    });

    it('should calculate negative CLV when entry > closing (no edge)', () => {
      const clv = calculateCLV(0.60, 0.55);
      expect(clv).toBeCloseTo(-0.05); // Negative = overpaid
    });

    it('should calculate zero CLV when entry = closing', () => {
      const clv = calculateCLV(0.55, 0.55);
      expect(clv).toBeCloseTo(0);
    });
  });

  describe('Fill Recording', () => {
    it('should record single full fill', () => {
      const updated = recordFill(order, 10, 54);

      expect(updated.filledSize).toBe(10);
      expect(updated.avgFillPrice).toBe(54);
      expect(updated.entryPrice).toBe(54);
      expect(updated.currentState).toBe('FILLED');
    });

    it('should record partial fill', () => {
      const updated = recordFill(order, 5, 54);

      expect(updated.filledSize).toBe(5);
      expect(updated.avgFillPrice).toBe(54);
      expect(updated.currentState).toBe('PARTIAL_FILL');
    });

    it('should calculate average price on multiple fills', () => {
      let updated = recordFill(order, 5, 50); // 5 @ 50 = 250
      expect(updated.currentState).toBe('PARTIAL_FILL');

      updated = recordFill(updated, 5, 60); // 5 @ 60 = 300, total 550/10 = 55

      expect(updated.filledSize).toBe(10);
      expect(updated.avgFillPrice).toBe(55);
      expect(updated.currentState).toBe('FILLED');
    });

    it('should calculate CLV when closing price provided', () => {
      const updated = recordFill(order, 10, 50, 55);

      expect(updated.closingLinePrice).toBe(55);
      expect(updated.clv).toBeCloseTo(5); // 55 - 50 = 5 cents (positive = edge)
    });
  });
});

// ============================================================
// 5. Reconciliation Tests
// ============================================================

describe('Reconciliation', () => {
  let ctx: WorkflowContext;

  beforeEach(() => {
    let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    // Advance to FILLED state
    order = transitionOrder(order, 'PRE_TRADE_CHECK');
    order = transitionOrder(order, 'VALIDATING');
    order = transitionOrder(order, 'VALIDATED');
    order = transitionOrder(order, 'RISK_CHECK');
    order = transitionOrder(order, 'RISK_APPROVED');
    order = transitionOrder(order, 'SUBMITTING');
    order = transitionOrder(order, 'SUBMITTED');
    order = recordFill(order, 10, 54);
    ctx = { order };
  });

  it('should reconcile when positions match', () => {
    const reconciliationResult: ReconciliationResult = {
      verified: true,
      expectedSize: 10,
      brokerSize: 10,
      driftPct: 0,
    };

    const result = stepReconcile(ctx, reconciliationResult);

    expect(result.order.currentState).toBe('RECONCILED');
    expect(result.order.reconciliationResult).toEqual(reconciliationResult);
  });

  it('should detect drift when positions mismatch', () => {
    const reconciliationResult: ReconciliationResult = {
      verified: false,
      expectedSize: 10,
      brokerSize: 8,
      driftPct: 20.0,
    };

    const result = stepReconcile(ctx, reconciliationResult);

    expect(result.order.currentState).toBe('RECONCILIATION_DRIFT');
    expect(result.order.lastError).toContain('drift');
  });

  it('should throw if not in FILLED state', () => {
    ctx.order.currentState = 'PENDING' as OrderState;

    expect(() =>
      stepReconcile(ctx, { verified: true, expectedSize: 10, brokerSize: 10, driftPct: 0 })
    ).toThrow('not in FILLED state');
  });
});

// ============================================================
// 6. Archive Tests
// ============================================================

describe('Archive', () => {
  let ctx: WorkflowContext;

  beforeEach(() => {
    let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    // Advance to RECONCILED state
    order = transitionOrder(order, 'PRE_TRADE_CHECK');
    order = transitionOrder(order, 'VALIDATING');
    order = transitionOrder(order, 'VALIDATED');
    order = transitionOrder(order, 'RISK_CHECK');
    order = transitionOrder(order, 'RISK_APPROVED');
    order = transitionOrder(order, 'SUBMITTING');
    order = transitionOrder(order, 'SUBMITTED');
    order = recordFill(order, 10, 54);
    order = transitionOrder(order, 'RECONCILED');
    ctx = { order };
  });

  it('should archive reconciled position', () => {
    const result = stepArchive(ctx, 100, 'Closed at profit');

    expect(result.order.currentState).toBe('ARCHIVED');
    expect(result.order.archivedAt).toBeDefined();
    expect(result.order.closedAt).toBeDefined();
  });

  it('should include PnL in metadata', () => {
    const result = stepArchive(ctx, 150.50, 'Good trade');

    const lastTransition = result.order.stateHistory[result.order.stateHistory.length - 1]!;
    expect(lastTransition.metadata?.pnl).toBe(150.50);
  });

  it('should throw if not in RECONCILED state', () => {
    ctx.order.currentState = 'PENDING' as OrderState;

    expect(() => stepArchive(ctx)).toThrow('not in RECONCILED state');
  });
});

// ============================================================
// 7. Terminal State and Retry Tests
// ============================================================

describe('Terminal States and Retries', () => {
  describe('Terminal State Detection', () => {
    it('should identify FILLED as terminal', () => {
      expect(isTerminalState('FILLED')).toBe(true);
    });

    it('should identify REJECTED as terminal', () => {
      expect(isTerminalState('REJECTED')).toBe(true);
    });

    it('should identify ARCHIVED as terminal', () => {
      expect(isTerminalState('ARCHIVED')).toBe(true);
    });

    it('should identify CANCELLED as terminal', () => {
      expect(isTerminalState('CANCELLED')).toBe(true);
    });

    it('should identify RISK_REJECTED as terminal', () => {
      expect(isTerminalState('RISK_REJECTED')).toBe(true);
    });

    it('should identify PRICE_MOVE_CANCEL as terminal', () => {
      expect(isTerminalState('PRICE_MOVE_CANCEL')).toBe(true);
    });

    it('should not identify PENDING as terminal', () => {
      expect(isTerminalState('PENDING')).toBe(false);
    });

    it('should not identify SUBMITTED as terminal', () => {
      expect(isTerminalState('SUBMITTED')).toBe(false);
    });
  });

  describe('Retry Logic', () => {
    it('should allow retry from ERROR state', () => {
      let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
      order = transitionOrder(order, 'ERROR', 'Network timeout');

      expect(canRetry(order)).toBe(true);
    });

    it('should not allow retry from non-ERROR state', () => {
      const order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);

      expect(canRetry(order)).toBe(false);
    });

    it('should not allow retry after max retries', () => {
      let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
      order = transitionOrder(order, 'ERROR');
      order.retryCount = 3;

      expect(canRetry(order, 3)).toBe(false);
    });

    it('should prepare retry correctly', () => {
      let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
      order = transitionOrder(order, 'ERROR', 'Network timeout');
      order.lastError = 'Network timeout';

      const retried = prepareRetry(order);

      expect(retried.currentState).toBe('PENDING');
      expect(retried.retryCount).toBe(1);
      expect(retried.lastError).toBeUndefined();
    });
  });
});

// ============================================================
// 8. Full Lifecycle Integration Tests
// ============================================================

describe('Full Order Lifecycle Integration', () => {
  it('should complete happy path: signal → fill → archive', () => {
    // Create order
    let order = createOrderLifecycle(
      'signal-001',
      'bonding',
      'BTCPRICE-T100K',
      'YES',
      10,
      55,
      0.75, // model probability
      0.05, // edge
      0.85  // confidence
    );

    // Pre-trade check (transitions to VALIDATING on success)
    let ctx: WorkflowContext = { order };
    ctx = stepPreTradeCheck(ctx, {
      passed: true,
      spread: 0.02,
      depth: 15000,
      vpinScore: 0.25,
    });
    expect(ctx.order.currentState).toBe('VALIDATING');

    // Manual transition to VALIDATED (stepPreTradeCheck already moved us to VALIDATING)
    ctx.order = transitionOrder(ctx.order, 'VALIDATED', 'Validation passed');
    expect(ctx.order.currentState).toBe('VALIDATED');

    // Risk check
    ctx = stepApplyRiskResult(ctx, true);
    expect(ctx.order.currentState).toBe('RISK_APPROVED');

    // Execution
    ctx = stepApplyExecutionResult(ctx, {
      success: true,
      orderId: 'paper-001',
      mode: 'PAPER',
      status: 'paper_filled',
      executionTimeMs: 50,
      paperFill: {
        orderId: 'paper-001',
        ticker: 'BTCUSD-2024',
        side: 'yes',
        action: 'buy',
        count: 10,
        fillPrice: 52,
        slippage: 0,
        timestamp: new Date().toISOString(),
      },
    });
    expect(ctx.order.currentState).toBe('FILLED');
    expect(ctx.order.filledSize).toBe(10);
    expect(ctx.order.avgFillPrice).toBe(52);

    // Reconciliation
    ctx = stepReconcile(ctx, {
      verified: true,
      expectedSize: 10,
      brokerSize: 10,
      driftPct: 0,
    });
    expect(ctx.order.currentState).toBe('RECONCILED');

    // Archive
    const pnl = (55 - 52) * 10; // Assuming YES resolved and max price was fair value
    ctx = stepArchive(ctx, pnl, 'Position closed successfully');
    expect(ctx.order.currentState).toBe('ARCHIVED');

    // Verify full history
    expect(ctx.order.stateHistory.length).toBeGreaterThan(5);
    expect(ctx.order.archivedAt).toBeDefined();
  });

  it('should handle rejection path: signal → risk reject', () => {
    let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 100, 95);

    let ctx: WorkflowContext = { order };
    ctx = stepValidate(ctx);

    // Risk check fails
    ctx = stepApplyRiskResult(ctx, false, undefined, [
      'I1: Position size exceeds 5% limit',
      'I5: Would exceed daily loss budget',
    ]);

    expect(ctx.order.currentState).toBe('RISK_REJECTED');
    expect(ctx.order.closedAt).toBeDefined();
    expect(ctx.order.riskCheckResult?.violations).toHaveLength(2);
  });

  it('should handle pre-trade failure path', () => {
    let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);

    let ctx: WorkflowContext = { order };
    ctx = stepPreTradeCheck(ctx, {
      passed: false,
      spread: 0.20, // Too wide
      depth: 500,   // Too thin
      vpinScore: 0.75, // Too toxic
      blockReason: 'Market conditions unfavorable: wide spread, low depth, high toxicity',
    });

    expect(ctx.order.currentState).toBe('PRE_TRADE_FAILED');
    expect(ctx.order.closedAt).toBeDefined();
  });
});

// ============================================================
// 9. Serialization Tests
// ============================================================

describe('Serialization', () => {
  it('should serialize and deserialize order correctly', () => {
    let order = createOrderLifecycle('signal-001', 'bonding', 'TICKER', 'YES', 10, 55);
    order = transitionOrder(order, 'PRE_TRADE_CHECK');
    order = transitionOrder(order, 'VALIDATING');

    const serialized = serializeOrderLifecycle(order);
    const deserialized = deserializeOrderLifecycle(serialized);

    expect(deserialized.orderId).toBe(order.orderId);
    expect(deserialized.currentState).toBe(order.currentState);
    expect(deserialized.stateHistory).toHaveLength(order.stateHistory.length);
  });
});

// ============================================================
// 10. Metrics Tests
// ============================================================

describe('Workflow Metrics', () => {
  it('should calculate metrics from orders', () => {
    const orders: OrderLifecycle[] = [
      {
        ...createOrderLifecycle('s1', 'bonding', 'T1', 'YES', 10, 55),
        currentState: 'FILLED',
        filledSize: 10,
        filledAt: new Date(Date.now() + 5000).toISOString(),
        clv: 0.03,
      },
      {
        ...createOrderLifecycle('s2', 'bonding', 'T2', 'YES', 10, 55),
        currentState: 'FILLED',
        filledSize: 10,
        filledAt: new Date(Date.now() + 10000).toISOString(),
        clv: 0.05,
      },
      {
        ...createOrderLifecycle('s3', 'bonding', 'T3', 'YES', 10, 55),
        currentState: 'REJECTED',
      },
    ];

    const metrics = calculateWorkflowMetrics(orders);

    expect(metrics.total).toBe(3);
    expect(metrics.byState.FILLED).toBe(2);
    expect(metrics.byState.REJECTED).toBe(1);
    expect(metrics.avgCLV).toBe(0.04); // (0.03 + 0.05) / 2
  });

  it('should handle empty order list', () => {
    const metrics = calculateWorkflowMetrics([]);

    expect(metrics.total).toBe(0);
    expect(metrics.avgCLV).toBe(0);
    expect(metrics.fillRate).toBe(0);
  });
});
