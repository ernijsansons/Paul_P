/**
 * Order Lifecycle Workflow Tests (P-15)
 */
import { describe, it, expect } from 'vitest';
import {
  isValidTransition,
  transitionOrder,
  createOrderLifecycle,
  createFromExecutionRequest,
  calculateCLV,
  recordFill,
  stepValidate,
  stepApplyRiskResult,
  stepApplyExecutionResult,
  isTerminalState,
  canRetry,
  prepareRetry,
  serializeOrderLifecycle,
  deserializeOrderLifecycle,
  calculateWorkflowMetrics,
  type OrderState,
  type OrderLifecycle,
  type WorkflowContext,
} from '../../../src/lib/execution/workflow';
import type { ExecutionRequest, ExecutionResult } from '../../../src/lib/execution/policy';

describe('Order Lifecycle Workflow', () => {
  describe('State Machine', () => {
    describe('isValidTransition', () => {
      it('allows PENDING → VALIDATING', () => {
        expect(isValidTransition('PENDING', 'VALIDATING')).toBe(true);
      });

      it('allows PENDING → CANCELLED', () => {
        expect(isValidTransition('PENDING', 'CANCELLED')).toBe(true);
      });

      it('allows PENDING → ERROR', () => {
        expect(isValidTransition('PENDING', 'ERROR')).toBe(true);
      });

      it('allows VALIDATING → VALIDATED', () => {
        expect(isValidTransition('VALIDATING', 'VALIDATED')).toBe(true);
      });

      it('allows VALIDATING → REJECTED', () => {
        expect(isValidTransition('VALIDATING', 'REJECTED')).toBe(true);
      });

      it('allows VALIDATED → RISK_CHECK', () => {
        expect(isValidTransition('VALIDATED', 'RISK_CHECK')).toBe(true);
      });

      it('allows RISK_CHECK → RISK_APPROVED', () => {
        expect(isValidTransition('RISK_CHECK', 'RISK_APPROVED')).toBe(true);
      });

      it('allows RISK_CHECK → RISK_REJECTED', () => {
        expect(isValidTransition('RISK_CHECK', 'RISK_REJECTED')).toBe(true);
      });

      it('allows RISK_APPROVED → SUBMITTING', () => {
        expect(isValidTransition('RISK_APPROVED', 'SUBMITTING')).toBe(true);
      });

      it('allows SUBMITTING → SUBMITTED', () => {
        expect(isValidTransition('SUBMITTING', 'SUBMITTED')).toBe(true);
      });

      it('allows SUBMITTED → FILLED', () => {
        expect(isValidTransition('SUBMITTED', 'FILLED')).toBe(true);
      });

      it('allows SUBMITTED → PARTIAL_FILL', () => {
        expect(isValidTransition('SUBMITTED', 'PARTIAL_FILL')).toBe(true);
      });

      it('allows PARTIAL_FILL → FILLED', () => {
        expect(isValidTransition('PARTIAL_FILL', 'FILLED')).toBe(true);
      });

      it('allows ERROR → PENDING (retry)', () => {
        expect(isValidTransition('ERROR', 'PENDING')).toBe(true);
      });

      it('blocks invalid transitions from terminal states', () => {
        expect(isValidTransition('FILLED', 'PENDING')).toBe(false);
        expect(isValidTransition('REJECTED', 'PENDING')).toBe(false);
        expect(isValidTransition('CANCELLED', 'PENDING')).toBe(false);
        expect(isValidTransition('EXPIRED', 'PENDING')).toBe(false);
        expect(isValidTransition('RISK_REJECTED', 'PENDING')).toBe(false);
      });

      it('blocks skipping states', () => {
        expect(isValidTransition('PENDING', 'SUBMITTED')).toBe(false);
        expect(isValidTransition('VALIDATING', 'RISK_APPROVED')).toBe(false);
        expect(isValidTransition('VALIDATED', 'FILLED')).toBe(false);
      });
    });

    describe('transitionOrder', () => {
      const createTestOrder = (): OrderLifecycle => ({
        orderId: 'test-order-1',
        signalId: 'signal-1',
        strategy: 'test-strategy',
        ticker: 'TEST-MARKET',
        side: 'YES',
        requestedSize: 10,
        maxPrice: 55,
        currentState: 'PENDING',
        stateHistory: [{ from: 'PENDING', to: 'PENDING', timestamp: new Date().toISOString(), reason: 'Created' }],
        filledSize: 0,
        createdAt: new Date().toISOString(),
        evidenceHashes: [],
        retryCount: 0,
      });

      it('transitions to new state', () => {
        const order = createTestOrder();
        const updated = transitionOrder(order, 'VALIDATING', 'Starting validation');

        expect(updated.currentState).toBe('VALIDATING');
        expect(updated.stateHistory).toHaveLength(2);
      });

      it('records transition in history', () => {
        const order = createTestOrder();
        const updated = transitionOrder(order, 'VALIDATING', 'Starting validation');

        const lastTransition = updated.stateHistory[updated.stateHistory.length - 1];
        expect(lastTransition?.from).toBe('PENDING');
        expect(lastTransition?.to).toBe('VALIDATING');
        expect(lastTransition?.reason).toBe('Starting validation');
      });

      it('sets validatedAt timestamp', () => {
        const order = { ...createTestOrder(), currentState: 'VALIDATING' as OrderState };
        const updated = transitionOrder(order, 'VALIDATED', 'Validation passed');

        expect(updated.validatedAt).toBeDefined();
      });

      it('sets riskApprovedAt timestamp', () => {
        const order = { ...createTestOrder(), currentState: 'RISK_CHECK' as OrderState };
        const updated = transitionOrder(order, 'RISK_APPROVED', 'Risk passed');

        expect(updated.riskApprovedAt).toBeDefined();
      });

      it('sets submittedAt timestamp', () => {
        const order = { ...createTestOrder(), currentState: 'SUBMITTING' as OrderState };
        const updated = transitionOrder(order, 'SUBMITTED', 'Order submitted');

        expect(updated.submittedAt).toBeDefined();
      });

      it('sets filledAt and closedAt for FILLED', () => {
        const order = { ...createTestOrder(), currentState: 'SUBMITTED' as OrderState };
        const updated = transitionOrder(order, 'FILLED', 'Order filled');

        expect(updated.filledAt).toBeDefined();
        expect(updated.closedAt).toBeDefined();
      });

      it('sets closedAt for terminal states', () => {
        const states: OrderState[] = ['REJECTED', 'CANCELLED', 'EXPIRED', 'RISK_REJECTED'];
        const validFromStates: Record<OrderState, OrderState> = {
          REJECTED: 'VALIDATING',
          CANCELLED: 'PENDING',
          EXPIRED: 'SUBMITTED',
          RISK_REJECTED: 'RISK_CHECK',
        };

        for (const state of states) {
          const order = { ...createTestOrder(), currentState: validFromStates[state] as OrderState };
          const updated = transitionOrder(order, state, 'Terminal');
          expect(updated.closedAt).toBeDefined();
        }
      });

      it('throws for invalid transition', () => {
        const order = createTestOrder();
        expect(() => transitionOrder(order, 'FILLED')).toThrow('Invalid state transition');
      });

      it('includes metadata in transition', () => {
        const order = createTestOrder();
        const metadata = { exchangeOrderId: 'EX123' };
        const updated = transitionOrder(order, 'VALIDATING', 'Starting', metadata);

        const lastTransition = updated.stateHistory[updated.stateHistory.length - 1];
        expect(lastTransition?.metadata).toEqual(metadata);
      });
    });
  });

  describe('Order Lifecycle Factory', () => {
    describe('createOrderLifecycle', () => {
      it('creates order with correct initial state', () => {
        const order = createOrderLifecycle(
          'signal-1',
          'test-strategy',
          'TEST-MARKET',
          'YES',
          10,
          55
        );

        expect(order.orderId).toContain('order-');
        expect(order.signalId).toBe('signal-1');
        expect(order.strategy).toBe('test-strategy');
        expect(order.ticker).toBe('TEST-MARKET');
        expect(order.side).toBe('YES');
        expect(order.requestedSize).toBe(10);
        expect(order.maxPrice).toBe(55);
        expect(order.currentState).toBe('PENDING');
        expect(order.filledSize).toBe(0);
        expect(order.retryCount).toBe(0);
        expect(order.evidenceHashes).toEqual([]);
      });

      it('includes initial state history entry', () => {
        const order = createOrderLifecycle('s1', 'strat', 'TICK', 'NO', 5, 45);
        expect(order.stateHistory).toHaveLength(1);
        expect(order.stateHistory[0]?.to).toBe('PENDING');
      });
    });

    describe('createFromExecutionRequest', () => {
      it('creates order from execution request', () => {
        const request: ExecutionRequest = {
          orderId: 'req-order-1',
          signal: {
            marketId: 'MARKET-123',
            side: 'YES',
            modelProbability: 0.65,
            marketPrice: 0.50,
            edge: 0.15,
            confidence: 0.8,
          },
          requestedSize: 20,
          maxPrice: 60,
          orderType: 'limit',
          source: 'weather-strategy',
          timestamp: new Date().toISOString(),
        };

        const order = createFromExecutionRequest(request);

        expect(order.signalId).toBe('req-order-1');
        expect(order.strategy).toBe('weather-strategy');
        expect(order.ticker).toBe('MARKET-123');
        expect(order.side).toBe('YES');
        expect(order.requestedSize).toBe(20);
        expect(order.maxPrice).toBe(60);
      });
    });
  });

  describe('CLV Calculation', () => {
    describe('calculateCLV', () => {
      it('returns positive CLV when entry better than closing', () => {
        // Bought at 50, closed at 60 → we got a good price
        const clv = calculateCLV(50, 60);
        expect(clv).toBe(10);
      });

      it('returns negative CLV when entry worse than closing', () => {
        // Bought at 60, closed at 50 → we overpaid
        const clv = calculateCLV(60, 50);
        expect(clv).toBe(-10);
      });

      it('returns zero CLV when entry equals closing', () => {
        const clv = calculateCLV(50, 50);
        expect(clv).toBe(0);
      });
    });

    describe('recordFill', () => {
      const createSubmittedOrder = (): OrderLifecycle => ({
        orderId: 'test-1',
        signalId: 'sig-1',
        strategy: 'test',
        ticker: 'TEST',
        side: 'YES',
        requestedSize: 10,
        maxPrice: 55,
        currentState: 'SUBMITTED',
        stateHistory: [],
        filledSize: 0,
        createdAt: new Date().toISOString(),
        evidenceHashes: [],
        retryCount: 0,
      });

      it('records fill size and price', () => {
        const order = createSubmittedOrder();
        const updated = recordFill(order, 5, 52);

        expect(updated.filledSize).toBe(5);
        expect(updated.avgFillPrice).toBe(52);
        expect(updated.entryPrice).toBe(52);
      });

      it('transitions to PARTIAL_FILL when not complete', () => {
        const order = createSubmittedOrder();
        const updated = recordFill(order, 5, 52);

        expect(updated.currentState).toBe('PARTIAL_FILL');
      });

      it('transitions to FILLED when complete', () => {
        const order = createSubmittedOrder();
        const updated = recordFill(order, 10, 52);

        expect(updated.currentState).toBe('FILLED');
      });

      it('calculates weighted average fill price', () => {
        const order = createSubmittedOrder();
        let updated = recordFill(order, 5, 50);
        updated = recordFill(updated, 5, 54);

        expect(updated.avgFillPrice).toBe(52); // (5*50 + 5*54) / 10
      });

      it('calculates CLV when closing price provided', () => {
        const order = createSubmittedOrder();
        const updated = recordFill(order, 10, 52, 55);

        expect(updated.closingLinePrice).toBe(55);
        expect(updated.clv).toBe(3); // 55 - 52
      });

      it('preserves entry price across fills', () => {
        const order = createSubmittedOrder();
        let updated = recordFill(order, 5, 50);
        updated = recordFill(updated, 5, 54);

        expect(updated.entryPrice).toBe(50); // First fill price
      });
    });
  });

  describe('Workflow Steps', () => {
    const createContext = (overrides: Partial<OrderLifecycle> = {}): WorkflowContext => ({
      order: {
        orderId: 'test-1',
        signalId: 'sig-1',
        strategy: 'test',
        ticker: 'TEST-MARKET',
        side: 'YES',
        requestedSize: 10,
        maxPrice: 55,
        currentState: 'PENDING',
        stateHistory: [],
        filledSize: 0,
        createdAt: new Date().toISOString(),
        evidenceHashes: [],
        retryCount: 0,
        ...overrides,
      },
    });

    describe('stepValidate', () => {
      it('validates and transitions to VALIDATED', () => {
        const ctx = createContext();
        const result = stepValidate(ctx);

        expect(result.order.currentState).toBe('VALIDATED');
      });

      it('rejects missing ticker', () => {
        const ctx = createContext({ ticker: '' });
        const result = stepValidate(ctx);

        expect(result.order.currentState).toBe('REJECTED');
        expect(result.order.lastError).toContain('ticker');
      });

      it('rejects invalid size', () => {
        const ctx = createContext({ requestedSize: 0 });
        const result = stepValidate(ctx);

        expect(result.order.currentState).toBe('REJECTED');
        expect(result.order.lastError).toContain('size');
      });

      it('rejects invalid price', () => {
        const ctx = createContext({ maxPrice: 100 });
        const result = stepValidate(ctx);

        expect(result.order.currentState).toBe('REJECTED');
        expect(result.order.lastError).toContain('price');
      });

      it('rejects invalid side', () => {
        const ctx = createContext({ side: 'MAYBE' as 'YES' | 'NO' });
        const result = stepValidate(ctx);

        expect(result.order.currentState).toBe('REJECTED');
        expect(result.order.lastError).toContain('side');
      });
    });

    describe('stepApplyRiskResult', () => {
      it('approves and transitions to RISK_APPROVED', () => {
        const ctx = createContext({ currentState: 'VALIDATED' });
        const result = stepApplyRiskResult(ctx, true);

        expect(result.order.currentState).toBe('RISK_APPROVED');
        expect(result.order.riskCheckResult?.approved).toBe(true);
      });

      it('rejects and transitions to RISK_REJECTED', () => {
        const ctx = createContext({ currentState: 'VALIDATED' });
        const result = stepApplyRiskResult(ctx, false, undefined, ['Position too large']);

        expect(result.order.currentState).toBe('RISK_REJECTED');
        expect(result.order.riskCheckResult?.approved).toBe(false);
        expect(result.order.lastError).toContain('Position too large');
      });

      it('applies adjusted size', () => {
        const ctx = createContext({ currentState: 'VALIDATED', requestedSize: 20 });
        const result = stepApplyRiskResult(ctx, true, 10);

        expect(result.order.requestedSize).toBe(10);
        expect(result.order.riskCheckResult?.adjustedSize).toBe(10);
      });

      it('transitions through RISK_CHECK state', () => {
        const ctx = createContext({ currentState: 'VALIDATED' });
        const result = stepApplyRiskResult(ctx, true);

        const history = result.order.stateHistory;
        expect(history.some(t => t.to === 'RISK_CHECK')).toBe(true);
      });
    });

    describe('stepApplyExecutionResult', () => {
      it('handles successful submission', () => {
        const ctx = createContext({ currentState: 'RISK_APPROVED' });
        const result: ExecutionResult = {
          success: true,
          orderId: 'exchange-order-1',
          mode: 'LIVE',
          status: 'submitted',
          executionTimeMs: 100,
        };

        const updated = stepApplyExecutionResult(ctx, result);

        expect(updated.order.currentState).toBe('SUBMITTED');
        expect(updated.executionResult).toBe(result);
      });

      it('handles paper fill', () => {
        const ctx = createContext({ currentState: 'RISK_APPROVED' });
        const result: ExecutionResult = {
          success: true,
          orderId: 'paper-order-1',
          mode: 'PAPER',
          status: 'paper_filled',
          paperFill: {
            orderId: 'paper-order-1',
            ticker: 'TEST',
            side: 'yes',
            action: 'buy',
            count: 10,
            fillPrice: 52,
            slippage: 1,
            timestamp: new Date().toISOString(),
          },
          executionTimeMs: 5,
        };

        const updated = stepApplyExecutionResult(ctx, result);

        expect(updated.order.currentState).toBe('FILLED');
        expect(updated.order.filledSize).toBe(10);
        expect(updated.order.avgFillPrice).toBe(52);
      });

      it('handles rejection', () => {
        const ctx = createContext({ currentState: 'RISK_APPROVED' });
        const result: ExecutionResult = {
          success: false,
          orderId: '',
          mode: 'LIVE',
          status: 'rejected',
          rejectionReason: 'Insufficient balance',
          executionTimeMs: 50,
        };

        const updated = stepApplyExecutionResult(ctx, result);

        expect(updated.order.currentState).toBe('REJECTED');
        expect(updated.order.lastError).toBe('Insufficient balance');
      });
    });
  });

  describe('Order State Utilities', () => {
    describe('isTerminalState', () => {
      it('identifies terminal states', () => {
        expect(isTerminalState('FILLED')).toBe(true);
        expect(isTerminalState('REJECTED')).toBe(true);
        expect(isTerminalState('CANCELLED')).toBe(true);
        expect(isTerminalState('EXPIRED')).toBe(true);
        expect(isTerminalState('RISK_REJECTED')).toBe(true);
      });

      it('identifies non-terminal states', () => {
        expect(isTerminalState('PENDING')).toBe(false);
        expect(isTerminalState('VALIDATING')).toBe(false);
        expect(isTerminalState('VALIDATED')).toBe(false);
        expect(isTerminalState('RISK_CHECK')).toBe(false);
        expect(isTerminalState('RISK_APPROVED')).toBe(false);
        expect(isTerminalState('SUBMITTING')).toBe(false);
        expect(isTerminalState('SUBMITTED')).toBe(false);
        expect(isTerminalState('PARTIAL_FILL')).toBe(false);
        expect(isTerminalState('ERROR')).toBe(false);
      });
    });

    describe('canRetry', () => {
      it('allows retry from ERROR state', () => {
        const order: OrderLifecycle = {
          orderId: 'test',
          signalId: 'sig',
          strategy: 'test',
          ticker: 'TEST',
          side: 'YES',
          requestedSize: 10,
          maxPrice: 55,
          currentState: 'ERROR',
          stateHistory: [],
          filledSize: 0,
          createdAt: new Date().toISOString(),
          evidenceHashes: [],
          retryCount: 0,
        };

        expect(canRetry(order)).toBe(true);
        expect(canRetry(order, 3)).toBe(true);
      });

      it('blocks retry when max retries reached', () => {
        const order: OrderLifecycle = {
          orderId: 'test',
          signalId: 'sig',
          strategy: 'test',
          ticker: 'TEST',
          side: 'YES',
          requestedSize: 10,
          maxPrice: 55,
          currentState: 'ERROR',
          stateHistory: [],
          filledSize: 0,
          createdAt: new Date().toISOString(),
          evidenceHashes: [],
          retryCount: 3,
        };

        expect(canRetry(order, 3)).toBe(false);
      });

      it('blocks retry from non-ERROR states', () => {
        const order: OrderLifecycle = {
          orderId: 'test',
          signalId: 'sig',
          strategy: 'test',
          ticker: 'TEST',
          side: 'YES',
          requestedSize: 10,
          maxPrice: 55,
          currentState: 'PENDING',
          stateHistory: [],
          filledSize: 0,
          createdAt: new Date().toISOString(),
          evidenceHashes: [],
          retryCount: 0,
        };

        expect(canRetry(order)).toBe(false);
      });
    });

    describe('prepareRetry', () => {
      it('resets order to PENDING', () => {
        const order: OrderLifecycle = {
          orderId: 'test',
          signalId: 'sig',
          strategy: 'test',
          ticker: 'TEST',
          side: 'YES',
          requestedSize: 10,
          maxPrice: 55,
          currentState: 'ERROR',
          stateHistory: [],
          filledSize: 0,
          createdAt: new Date().toISOString(),
          evidenceHashes: [],
          retryCount: 0,
          lastError: 'Network timeout',
        };

        const retried = prepareRetry(order);

        expect(retried.currentState).toBe('PENDING');
        expect(retried.retryCount).toBe(1);
        expect(retried.lastError).toBeUndefined();
      });

      it('throws when cannot retry', () => {
        const order: OrderLifecycle = {
          orderId: 'test',
          signalId: 'sig',
          strategy: 'test',
          ticker: 'TEST',
          side: 'YES',
          requestedSize: 10,
          maxPrice: 55,
          currentState: 'ERROR',
          stateHistory: [],
          filledSize: 0,
          createdAt: new Date().toISOString(),
          evidenceHashes: [],
          retryCount: 3,
        };

        expect(() => prepareRetry(order)).toThrow('cannot be retried');
      });
    });
  });

  describe('Serialization', () => {
    it('serializes and deserializes order', () => {
      const order = createOrderLifecycle('sig-1', 'strategy', 'TICK', 'YES', 10, 55);
      const serialized = serializeOrderLifecycle(order);
      const deserialized = deserializeOrderLifecycle(serialized);

      expect(deserialized.orderId).toBe(order.orderId);
      expect(deserialized.signalId).toBe(order.signalId);
      expect(deserialized.currentState).toBe(order.currentState);
    });
  });

  describe('Workflow Metrics', () => {
    describe('calculateWorkflowMetrics', () => {
      it('counts orders by state', () => {
        const orders: OrderLifecycle[] = [
          { ...createOrderLifecycle('s1', 'st', 'T', 'YES', 10, 50), currentState: 'FILLED' },
          { ...createOrderLifecycle('s2', 'st', 'T', 'YES', 10, 50), currentState: 'FILLED' },
          { ...createOrderLifecycle('s3', 'st', 'T', 'YES', 10, 50), currentState: 'REJECTED' },
          { ...createOrderLifecycle('s4', 'st', 'T', 'YES', 10, 50), currentState: 'PENDING' },
        ];

        const metrics = calculateWorkflowMetrics(orders);

        expect(metrics.total).toBe(4);
        expect(metrics.byState.FILLED).toBe(2);
        expect(metrics.byState.REJECTED).toBe(1);
        expect(metrics.byState.PENDING).toBe(1);
      });

      it('calculates average time to fill', () => {
        const now = Date.now();
        const orders: OrderLifecycle[] = [
          {
            ...createOrderLifecycle('s1', 'st', 'T', 'YES', 10, 50),
            currentState: 'FILLED',
            createdAt: new Date(now - 10000).toISOString(),
            filledAt: new Date(now).toISOString(),
          },
          {
            ...createOrderLifecycle('s2', 'st', 'T', 'YES', 10, 50),
            currentState: 'FILLED',
            createdAt: new Date(now - 20000).toISOString(),
            filledAt: new Date(now).toISOString(),
          },
        ];

        const metrics = calculateWorkflowMetrics(orders);

        expect(metrics.avgTimeToFill).toBe(15000); // (10000 + 20000) / 2
      });

      it('calculates average CLV', () => {
        const orders: OrderLifecycle[] = [
          { ...createOrderLifecycle('s1', 'st', 'T', 'YES', 10, 50), currentState: 'FILLED', clv: 5 },
          { ...createOrderLifecycle('s2', 'st', 'T', 'YES', 10, 50), currentState: 'FILLED', clv: -3 },
          { ...createOrderLifecycle('s3', 'st', 'T', 'YES', 10, 50), currentState: 'FILLED', clv: 10 },
        ];

        const metrics = calculateWorkflowMetrics(orders);

        expect(metrics.avgCLV).toBe(4); // (5 + -3 + 10) / 3
      });

      it('calculates fill rate', () => {
        const now = Date.now();
        const orders: OrderLifecycle[] = [
          {
            ...createOrderLifecycle('s1', 'st', 'T', 'YES', 10, 50),
            currentState: 'FILLED',
            createdAt: new Date(now - 10000).toISOString(),
            filledAt: new Date(now).toISOString(),
          },
          {
            ...createOrderLifecycle('s2', 'st', 'T', 'YES', 10, 50),
            currentState: 'FILLED',
            createdAt: new Date(now - 20000).toISOString(),
            filledAt: new Date(now).toISOString(),
          },
          { ...createOrderLifecycle('s3', 'st', 'T', 'YES', 10, 50), currentState: 'SUBMITTED' },
          { ...createOrderLifecycle('s4', 'st', 'T', 'YES', 10, 50), currentState: 'PARTIAL_FILL' },
        ];

        const metrics = calculateWorkflowMetrics(orders);

        expect(metrics.fillRate).toBe(0.5); // 2 filled / 4 submitted
      });

      it('handles empty orders array', () => {
        const metrics = calculateWorkflowMetrics([]);

        expect(metrics.total).toBe(0);
        expect(metrics.avgTimeToFill).toBe(0);
        expect(metrics.avgCLV).toBe(0);
        expect(metrics.fillRate).toBe(0);
      });
    });
  });
});
