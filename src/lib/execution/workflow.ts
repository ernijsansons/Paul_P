/**
 * Paul P - Order Lifecycle Workflow (P-15)
 *
 * Orchestrates the complete signal-to-execution flow:
 * 1. Signal Generation → Strategy Agents
 * 2. Risk Validation → RiskGovernorAgent
 * 3. Order Execution → KalshiExecAgent
 * 4. Fill Tracking → Order state machine
 * 5. CLV Calculation → Closing Line Value scoring
 *
 * Order State Machine:
 * PENDING → VALIDATED → RISK_APPROVED → SUBMITTED → FILLED/REJECTED/CANCELLED
 */

import type { ExecutionRequest, ExecutionResult } from './policy';
import { deterministicId } from '../utils/deterministic-id';

// ============================================================
// ORDER STATE MACHINE
// ============================================================

export type OrderState =
  | 'PENDING'              // Initial state, signal received
  | 'PRE_TRADE_CHECK'      // Microstructure validation (spread, depth, VPIN)
  | 'PRE_TRADE_FAILED'     // Failed microstructure check
  | 'VALIDATING'           // Being validated by policy engine
  | 'VALIDATED'            // Passed validation
  | 'RISK_CHECK'           // Awaiting risk governor approval
  | 'RISK_APPROVED'        // Risk check passed
  | 'RISK_REJECTED'        // Risk check failed
  | 'RISK_TIMEOUT'         // Risk check timed out
  | 'SUBMITTING'           // Being submitted to exchange
  | 'SUBMITTED'            // Order submitted, awaiting fill
  | 'ORDER_ACKNOWLEDGED'   // Broker returned order_id
  | 'PARTIAL_FILL'         // Partially filled
  | 'FILLED'               // Fully filled
  | 'PRICE_MOVE_CANCEL'    // Cancelled due to price move > threshold
  | 'RECONCILED'           // Position verified with broker
  | 'RECONCILIATION_DRIFT' // Position mismatch detected
  | 'ARCHIVED'             // Position closed, PnL computed
  | 'REJECTED'             // Rejected by exchange
  | 'CANCELLED'            // Cancelled by user or system
  | 'EXPIRED'              // Order expired without fill
  | 'ERROR';               // System error

export interface OrderStateTransition {
  from: OrderState;
  to: OrderState;
  timestamp: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderLifecycle {
  orderId: string;
  signalId: string;
  strategy: string;
  ticker: string;
  side: 'YES' | 'NO';
  requestedSize: number;
  maxPrice: number;

  // State tracking
  currentState: OrderState;
  stateHistory: OrderStateTransition[];

  // Execution details
  entryPrice?: number;
  filledSize: number;
  avgFillPrice?: number;
  closingLinePrice?: number;
  clv?: number;
  signalModelProbability?: number;
  signalEdge?: number;
  signalConfidence?: number;

  // Timestamps
  createdAt: string;
  preTradeCheckedAt?: string;
  validatedAt?: string;
  riskApprovedAt?: string;
  submittedAt?: string;
  acknowledgedAt?: string;
  filledAt?: string;
  reconciledAt?: string;
  archivedAt?: string;
  closedAt?: string;

  // Pre-trade check results
  preTradeCheckResult?: {
    passed: boolean;
    spread?: number;
    depth?: number;
    vpinScore?: number;
    blockReason?: string;
  };

  // Reconciliation results
  reconciliationResult?: {
    verified: boolean;
    expectedSize: number;
    brokerSize: number;
    driftPct: number;
  };

  // Risk check results
  riskCheckResult?: {
    approved: boolean;
    adjustedSize?: number;
    violations?: string[];
  };

  // Evidence
  evidenceHashes: string[];

  // Error tracking
  lastError?: string;
  retryCount: number;
}

// ============================================================
// STATE MACHINE
// ============================================================

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS: Record<OrderState, OrderState[]> = {
  PENDING: ['PRE_TRADE_CHECK', 'VALIDATING', 'CANCELLED', 'ERROR'],
  PRE_TRADE_CHECK: ['VALIDATING', 'PRE_TRADE_FAILED', 'ERROR'],
  PRE_TRADE_FAILED: [], // Terminal
  VALIDATING: ['VALIDATED', 'REJECTED', 'ERROR'],
  VALIDATED: ['RISK_CHECK', 'CANCELLED', 'ERROR'],
  RISK_CHECK: ['RISK_APPROVED', 'RISK_REJECTED', 'RISK_TIMEOUT', 'ERROR'],
  RISK_APPROVED: ['SUBMITTING', 'CANCELLED', 'ERROR'],
  RISK_REJECTED: [], // Terminal
  RISK_TIMEOUT: ['RISK_CHECK', 'CANCELLED'], // Can retry or cancel
  SUBMITTING: ['SUBMITTED', 'REJECTED', 'ERROR'],
  SUBMITTED: ['ORDER_ACKNOWLEDGED', 'PARTIAL_FILL', 'FILLED', 'PRICE_MOVE_CANCEL', 'CANCELLED', 'EXPIRED', 'ERROR'],
  ORDER_ACKNOWLEDGED: ['PARTIAL_FILL', 'FILLED', 'PRICE_MOVE_CANCEL', 'CANCELLED', 'EXPIRED', 'ERROR'],
  PARTIAL_FILL: ['FILLED', 'CANCELLED', 'EXPIRED', 'ERROR'],
  FILLED: ['RECONCILED', 'RECONCILIATION_DRIFT'],
  PRICE_MOVE_CANCEL: [], // Terminal
  RECONCILED: ['ARCHIVED'],
  RECONCILIATION_DRIFT: ['RECONCILED'], // Can recover after manual fix
  ARCHIVED: [], // Terminal
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
  ERROR: ['PENDING'], // Allow retry from error state
};

/**
 * Check if a state transition is valid
 */
export function isValidTransition(from: OrderState, to: OrderState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Transition order to a new state
 */
export function transitionOrder(
  order: OrderLifecycle,
  newState: OrderState,
  reason?: string,
  metadata?: Record<string, unknown>
): OrderLifecycle {
  if (!isValidTransition(order.currentState, newState)) {
    throw new Error(
      `Invalid state transition: ${order.currentState} → ${newState} for order ${order.orderId}`
    );
  }

  const transition: OrderStateTransition = {
    from: order.currentState,
    to: newState,
    timestamp: new Date().toISOString(),
    reason,
    metadata,
  };

  const updatedOrder: OrderLifecycle = {
    ...order,
    currentState: newState,
    stateHistory: [...order.stateHistory, transition],
  };

  // Update timestamps based on state
  switch (newState) {
    case 'PRE_TRADE_CHECK':
      updatedOrder.preTradeCheckedAt = transition.timestamp;
      break;
    case 'VALIDATED':
      updatedOrder.validatedAt = transition.timestamp;
      break;
    case 'RISK_APPROVED':
      updatedOrder.riskApprovedAt = transition.timestamp;
      break;
    case 'SUBMITTED':
      updatedOrder.submittedAt = transition.timestamp;
      break;
    case 'ORDER_ACKNOWLEDGED':
      updatedOrder.acknowledgedAt = transition.timestamp;
      break;
    case 'FILLED':
      updatedOrder.filledAt = transition.timestamp;
      updatedOrder.closedAt = transition.timestamp;
      break;
    case 'RECONCILED':
      updatedOrder.reconciledAt = transition.timestamp;
      break;
    case 'ARCHIVED':
      updatedOrder.archivedAt = transition.timestamp;
      updatedOrder.closedAt = transition.timestamp;
      break;
    case 'REJECTED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'RISK_REJECTED':
    case 'PRE_TRADE_FAILED':
    case 'PRICE_MOVE_CANCEL':
      updatedOrder.closedAt = transition.timestamp;
      break;
  }

  return updatedOrder;
}

// ============================================================
// ORDER LIFECYCLE FACTORY
// ============================================================

/**
 * Create a new order lifecycle from a signal
 */
export function createOrderLifecycle(
  signalId: string,
  strategy: string,
  ticker: string,
  side: 'YES' | 'NO',
  requestedSize: number,
  maxPrice: number,
  signalModelProbability?: number,
  signalEdge?: number,
  signalConfidence?: number
): OrderLifecycle {
  const now = new Date().toISOString();
  const orderId = deterministicId(
    'order',
    signalId,
    strategy,
    ticker,
    side,
    requestedSize,
    maxPrice
  );

  return {
    orderId,
    signalId,
    strategy,
    ticker,
    side,
    requestedSize,
    maxPrice,
    signalModelProbability,
    signalEdge,
    signalConfidence,

    currentState: 'PENDING',
    stateHistory: [{
      from: 'PENDING' as OrderState,
      to: 'PENDING',
      timestamp: now,
      reason: 'Order created',
    }],

    filledSize: 0,

    createdAt: now,

    evidenceHashes: [],
    retryCount: 0,
  };
}

/**
 * Create order lifecycle from execution request
 */
export function createFromExecutionRequest(request: ExecutionRequest): OrderLifecycle {
  return createOrderLifecycle(
    request.orderId,
    request.source,
    request.signal.marketId,
    request.signal.side,
    request.requestedSize,
    request.maxPrice
  );
}

// ============================================================
// CLV CALCULATION
// ============================================================

/**
 * Calculate Closing Line Value (CLV)
 *
 * CLV = closing_line_price − entry_price (P-01 sign convention)
 *
 * Positive CLV = entry price was favorable (model beat closing line)
 * Negative CLV = entry price was unfavorable
 */
export function calculateCLV(
  entryPrice: number,
  closingLinePrice: number
): number {
  return closingLinePrice - entryPrice;
}

/**
 * Update order with fill and calculate CLV if closing price available
 */
export function recordFill(
  order: OrderLifecycle,
  fillSize: number,
  fillPrice: number,
  closingLinePrice?: number
): OrderLifecycle {
  const totalCost = (order.avgFillPrice ?? 0) * order.filledSize + fillPrice * fillSize;
  const newFilledSize = order.filledSize + fillSize;
  const newAvgPrice = newFilledSize > 0 ? totalCost / newFilledSize : 0;

  const updated: OrderLifecycle = {
    ...order,
    filledSize: newFilledSize,
    avgFillPrice: newAvgPrice,
    entryPrice: order.entryPrice ?? fillPrice,
  };

  // Calculate CLV if closing price is available
  if (closingLinePrice !== undefined && updated.entryPrice !== undefined) {
    updated.closingLinePrice = closingLinePrice;
    updated.clv = calculateCLV(updated.entryPrice, closingLinePrice);
  }

  // Transition to appropriate state
  if (newFilledSize >= order.requestedSize) {
    return transitionOrder(updated, 'FILLED', `Full fill at ${fillPrice}`);
  } else if (order.currentState === 'SUBMITTED') {
    return transitionOrder(updated, 'PARTIAL_FILL', `Partial fill: ${fillSize} at ${fillPrice}`);
  }

  return updated;
}

// ============================================================
// WORKFLOW STEPS
// ============================================================

export interface WorkflowContext {
  order: OrderLifecycle;
  executionRequest?: ExecutionRequest;
  executionResult?: ExecutionResult;
}

/**
 * Workflow step: Validate order
 */
export function stepValidate(ctx: WorkflowContext): WorkflowContext {
  const { order } = ctx;

  // Transition to validating
  let updated = transitionOrder(order, 'VALIDATING', 'Starting validation');

  // Basic validation
  const errors: string[] = [];

  if (!order.ticker) errors.push('Missing ticker');
  if (order.requestedSize <= 0) errors.push('Invalid size');
  if (order.maxPrice < 1 || order.maxPrice > 99) errors.push('Invalid price');
  if (!['YES', 'NO'].includes(order.side)) errors.push('Invalid side');

  if (errors.length > 0) {
    updated = transitionOrder(updated, 'REJECTED', errors.join('; '));
    updated.lastError = errors.join('; ');
  } else {
    updated = transitionOrder(updated, 'VALIDATED', 'Validation passed');
  }

  return { ...ctx, order: updated };
}

/**
 * Workflow step: Apply risk check result
 */
export function stepApplyRiskResult(
  ctx: WorkflowContext,
  approved: boolean,
  adjustedSize?: number,
  violations?: string[]
): WorkflowContext {
  let { order } = ctx;

  // First transition to RISK_CHECK state if not already there
  if (order.currentState === 'VALIDATED') {
    order = transitionOrder(order, 'RISK_CHECK', 'Awaiting risk approval');
  }

  // Store risk check result
  order.riskCheckResult = { approved, adjustedSize, violations };

  if (approved) {
    order = transitionOrder(order, 'RISK_APPROVED', 'Risk check passed');
    // Apply adjusted size if needed
    if (adjustedSize && adjustedSize < order.requestedSize) {
      order.requestedSize = adjustedSize;
    }
  } else {
    order = transitionOrder(
      order,
      'RISK_REJECTED',
      violations?.join('; ') ?? 'Risk check failed'
    );
    order.lastError = violations?.join('; ');
  }

  return { ...ctx, order };
}

/**
 * Workflow step: Apply execution result
 */
export function stepApplyExecutionResult(
  ctx: WorkflowContext,
  result: ExecutionResult
): WorkflowContext {
  let { order } = ctx;

  // Transition to SUBMITTING if risk approved
  if (order.currentState === 'RISK_APPROVED') {
    order = transitionOrder(order, 'SUBMITTING', 'Submitting to exchange');
  }

  if (result.success) {
    if (result.status === 'paper_filled' && result.paperFill) {
      // Paper trading - immediate fill
      order = transitionOrder(order, 'SUBMITTED', 'Paper order submitted');
      order = recordFill(order, result.paperFill.count, result.paperFill.fillPrice);
    } else if (result.status === 'submitted') {
      // Live order - awaiting fill
      order = transitionOrder(order, 'SUBMITTED', `Order ${result.orderId} submitted`);
    }
  } else {
    order = transitionOrder(order, 'REJECTED', result.rejectionReason ?? 'Execution failed');
    order.lastError = result.rejectionReason;
  }

  return { ...ctx, order, executionResult: result };
}

/**
 * Pre-trade check result interface
 */
export interface PreTradeCheckResult {
  passed: boolean;
  spread?: number;
  depth?: number;
  vpinScore?: number;
  blockReason?: string;
}

/**
 * Workflow step: Pre-trade microstructure check
 * Validates spread, depth, and VPIN before submitting order
 */
export function stepPreTradeCheck(
  ctx: WorkflowContext,
  checkResult: PreTradeCheckResult
): WorkflowContext {
  let { order } = ctx;

  // Transition to PRE_TRADE_CHECK state if pending
  if (order.currentState === 'PENDING') {
    order = transitionOrder(order, 'PRE_TRADE_CHECK', 'Starting pre-trade microstructure check');
  }

  // Store check result
  order.preTradeCheckResult = checkResult;

  if (checkResult.passed) {
    order = transitionOrder(order, 'VALIDATING', 'Pre-trade check passed');
  } else {
    order = transitionOrder(
      order,
      'PRE_TRADE_FAILED',
      checkResult.blockReason ?? 'Pre-trade check failed'
    );
    order.lastError = checkResult.blockReason;
  }

  return { ...ctx, order };
}

/**
 * Reconciliation result interface
 */
export interface ReconciliationResult {
  verified: boolean;
  expectedSize: number;
  brokerSize: number;
  driftPct: number;
}

/**
 * Workflow step: Reconcile position with broker
 * Verifies filled position matches broker records
 */
export function stepReconcile(
  ctx: WorkflowContext,
  reconciliationResult: ReconciliationResult
): WorkflowContext {
  let { order } = ctx;

  // Must be in FILLED state to reconcile
  if (order.currentState !== 'FILLED') {
    throw new Error(
      `Cannot reconcile order ${order.orderId}: not in FILLED state (current: ${order.currentState})`
    );
  }

  // Store reconciliation result
  order.reconciliationResult = reconciliationResult;

  if (reconciliationResult.verified) {
    order = transitionOrder(order, 'RECONCILED', 'Position verified with broker');
  } else {
    order = transitionOrder(
      order,
      'RECONCILIATION_DRIFT',
      `Position drift detected: expected ${reconciliationResult.expectedSize}, broker ${reconciliationResult.brokerSize} (${reconciliationResult.driftPct.toFixed(2)}%)`
    );
    order.lastError = `Position drift: ${reconciliationResult.driftPct.toFixed(2)}%`;
  }

  return { ...ctx, order };
}

/**
 * Workflow step: Archive completed position
 * Marks position as archived after closing and PnL computation
 */
export function stepArchive(
  ctx: WorkflowContext,
  pnl?: number,
  closingNotes?: string
): WorkflowContext {
  let { order } = ctx;

  // Must be in RECONCILED state to archive
  if (order.currentState !== 'RECONCILED') {
    throw new Error(
      `Cannot archive order ${order.orderId}: not in RECONCILED state (current: ${order.currentState})`
    );
  }

  const metadata: Record<string, unknown> = {};
  if (pnl !== undefined) {
    metadata.pnl = pnl;
  }
  if (closingNotes) {
    metadata.closingNotes = closingNotes;
  }

  order = transitionOrder(
    order,
    'ARCHIVED',
    'Position closed and archived',
    Object.keys(metadata).length > 0 ? metadata : undefined
  );

  return { ...ctx, order };
}

/**
 * Workflow step: Handle price move cancellation
 * Cancels order when market price moves beyond threshold
 */
export function stepPriceMoveCancel(
  ctx: WorkflowContext,
  priceMovePct: number,
  threshold: number
): WorkflowContext {
  let { order } = ctx;

  // Can cancel from ORDER_ACKNOWLEDGED or SUBMITTED states
  if (!['ORDER_ACKNOWLEDGED', 'SUBMITTED'].includes(order.currentState)) {
    throw new Error(
      `Cannot price-move cancel order ${order.orderId}: not in valid state (current: ${order.currentState})`
    );
  }

  order = transitionOrder(
    order,
    'PRICE_MOVE_CANCEL',
    `Price moved ${priceMovePct.toFixed(2)}% > ${threshold}% threshold`,
    { priceMovePct, threshold }
  );

  return { ...ctx, order };
}

/**
 * Workflow step: Handle broker order acknowledgement
 * Transitions order to ORDER_ACKNOWLEDGED when broker returns order_id
 */
export function stepOrderAcknowledged(
  ctx: WorkflowContext,
  brokerOrderId: string
): WorkflowContext {
  let { order } = ctx;

  if (order.currentState !== 'SUBMITTED') {
    throw new Error(
      `Cannot acknowledge order ${order.orderId}: not in SUBMITTED state (current: ${order.currentState})`
    );
  }

  order = transitionOrder(
    order,
    'ORDER_ACKNOWLEDGED',
    `Broker acknowledged with ID: ${brokerOrderId}`,
    { brokerOrderId }
  );

  return { ...ctx, order };
}

// ============================================================
// BATCH WORKFLOW
// ============================================================

export interface BatchWorkflowResult {
  processed: number;
  successful: number;
  rejected: number;
  orders: OrderLifecycle[];
  errors: Array<{ orderId: string; error: string }>;
}

/**
 * Check if order is in a terminal state
 */
export function isTerminalState(state: OrderState): boolean {
  return [
    'FILLED',
    'REJECTED',
    'CANCELLED',
    'EXPIRED',
    'RISK_REJECTED',
    'PRE_TRADE_FAILED',
    'PRICE_MOVE_CANCEL',
    'ARCHIVED',
  ].includes(state);
}

/**
 * Check if order can be retried
 */
export function canRetry(order: OrderLifecycle, maxRetries: number = 3): boolean {
  if (order.currentState !== 'ERROR') return false;
  return order.retryCount < maxRetries;
}

/**
 * Prepare order for retry
 */
export function prepareRetry(order: OrderLifecycle): OrderLifecycle {
  if (!canRetry(order)) {
    throw new Error(`Order ${order.orderId} cannot be retried`);
  }

  return {
    ...transitionOrder(order, 'PENDING', `Retry #${order.retryCount + 1}`),
    retryCount: order.retryCount + 1,
    lastError: undefined,
  };
}

// ============================================================
// SERIALIZATION
// ============================================================

/**
 * Serialize order lifecycle for storage
 */
export function serializeOrderLifecycle(order: OrderLifecycle): string {
  return JSON.stringify(order);
}

/**
 * Deserialize order lifecycle from storage
 */
export function deserializeOrderLifecycle(json: string): OrderLifecycle {
  return JSON.parse(json) as OrderLifecycle;
}

// ============================================================
// METRICS
// ============================================================

/**
 * Calculate workflow metrics from orders
 */
export function calculateWorkflowMetrics(orders: OrderLifecycle[]): {
  total: number;
  byState: Record<OrderState, number>;
  avgTimeToFill: number;
  avgCLV: number;
  fillRate: number;
} {
  const byState: Record<OrderState, number> = {
    PENDING: 0,
    PRE_TRADE_CHECK: 0,
    PRE_TRADE_FAILED: 0,
    VALIDATING: 0,
    VALIDATED: 0,
    RISK_CHECK: 0,
    RISK_APPROVED: 0,
    RISK_REJECTED: 0,
    RISK_TIMEOUT: 0,
    SUBMITTING: 0,
    SUBMITTED: 0,
    ORDER_ACKNOWLEDGED: 0,
    PARTIAL_FILL: 0,
    FILLED: 0,
    PRICE_MOVE_CANCEL: 0,
    RECONCILED: 0,
    RECONCILIATION_DRIFT: 0,
    ARCHIVED: 0,
    REJECTED: 0,
    CANCELLED: 0,
    EXPIRED: 0,
    ERROR: 0,
  };

  let totalTimeToFill = 0;
  let filledCount = 0;
  let totalCLV = 0;
  let clvCount = 0;

  for (const order of orders) {
    byState[order.currentState]++;

    if (order.currentState === 'FILLED' && order.createdAt && order.filledAt) {
      const timeToFill = new Date(order.filledAt).getTime() - new Date(order.createdAt).getTime();
      totalTimeToFill += timeToFill;
      filledCount++;
    }

    if (order.clv !== undefined) {
      totalCLV += order.clv;
      clvCount++;
    }
  }

  const submitted = byState.SUBMITTED + byState.PARTIAL_FILL + byState.FILLED;

  return {
    total: orders.length,
    byState,
    avgTimeToFill: filledCount > 0 ? totalTimeToFill / filledCount : 0,
    avgCLV: clvCount > 0 ? totalCLV / clvCount : 0,
    fillRate: submitted > 0 ? filledCount / submitted : 0,
  };
}
