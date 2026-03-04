/**
 * Paul P - Order Fill Simulator
 * Simulates order execution with realistic slippage and fill models
 */

import { createHash } from 'crypto';
import type {
  FillModel,
  Signal,
  SimulatedOrder,
  Position,
  MarketSnapshot,
  DEFAULT_FILL_MODEL,
} from './types';

// ============================================================
// ORDER SIMULATION
// ============================================================

export interface SimulationContext {
  fillModel: FillModel;
  feePerContract: number;
  currentTime: string;
  randomSeed?: number;
}

/**
 * Simulate order execution based on market snapshot
 */
export function simulateOrder(
  signal: Signal,
  snapshot: MarketSnapshot,
  context: SimulationContext
): SimulatedOrder {
  const orderId = generateOrderId(signal, context.currentTime);

  // Determine order price based on signal
  const requestedPrice = signal.entryPrice;
  const requestedSize = signal.suggestedSize;

  // Compute expected slippage
  const expectedSlippage = computeExpectedSlippage(
    requestedSize,
    snapshot,
    context.fillModel
  );

  // Determine if order fills
  const fillProbability = computeFillProbability(
    requestedPrice,
    snapshot,
    context.fillModel
  );

  const random = seededRandom(orderId + context.currentTime);
  const fills = random < fillProbability;

  if (!fills) {
    return {
      orderId,
      signalId: signal.signalId,
      timestamp: context.currentTime,
      ticker: signal.ticker,
      side: signal.side,
      action: signal.action,
      orderType: 'limit',
      requestedPrice,
      requestedSize,
      filled: false,
      fillPrice: null,
      fillSize: null,
      fillTimestamp: null,
      expectedSlippage,
      realizedSlippage: null,
      fees: 0,
    };
  }

  // Compute fill price with slippage
  let fillPrice: number;
  if (signal.action === 'buy') {
    // Buying: pay the ask + slippage
    fillPrice = Math.min(0.99, snapshot.yesAsk + expectedSlippage);
  } else {
    // Selling: receive the bid - slippage
    fillPrice = Math.max(0.01, snapshot.yesBid - expectedSlippage);
  }

  const realizedSlippage = Math.abs(fillPrice - requestedPrice);
  const fees = requestedSize * context.feePerContract;

  return {
    orderId,
    signalId: signal.signalId,
    timestamp: context.currentTime,
    ticker: signal.ticker,
    side: signal.side,
    action: signal.action,
    orderType: 'limit',
    requestedPrice,
    requestedSize,
    filled: true,
    fillPrice,
    fillSize: requestedSize,
    fillTimestamp: context.currentTime,
    expectedSlippage,
    realizedSlippage,
    fees,
  };
}

/**
 * Compute expected slippage based on fill model and market conditions
 */
function computeExpectedSlippage(
  orderSize: number,
  snapshot: MarketSnapshot,
  fillModel: FillModel
): number {
  // Base slippage
  let slippage = fillModel.baseSlippageBps / 10000;

  // Size impact: larger orders have more impact
  const sizeRatio = orderSize / (snapshot.depth || 100);
  slippage += sizeRatio * fillModel.sizeImpactFactor * 0.01;

  // Spread impact: wider spreads mean more slippage
  slippage += snapshot.spread * fillModel.spreadImpactFactor;

  // Cap slippage at reasonable level
  return Math.min(slippage, 0.10); // Max 10% slippage
}

/**
 * Compute fill probability for limit orders
 */
function computeFillProbability(
  requestedPrice: number,
  snapshot: MarketSnapshot,
  fillModel: FillModel
): number {
  // Check if price is marketable
  const isMarketable = requestedPrice >= snapshot.yesAsk;

  if (isMarketable) {
    return fillModel.marketFillProbability;
  }

  // For limit orders, probability decreases with distance from mid
  const distanceFromMid = Math.abs(requestedPrice - snapshot.midPrice);
  const halfSpread = snapshot.spread / 2;

  // If limit is better than mid, higher fill probability
  if (distanceFromMid <= halfSpread) {
    return fillModel.limitFillProbability + 0.2;
  }

  // Otherwise, probability decreases
  return fillModel.limitFillProbability * (1 - distanceFromMid / 0.20);
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================

/**
 * Open a new position from a filled order
 */
export function openPosition(order: SimulatedOrder): Position {
  if (!order.filled || order.fillPrice === null || order.fillSize === null) {
    throw new Error('Cannot open position from unfilled order');
  }

  const positionId = generatePositionId(order);

  return {
    positionId,
    ticker: order.ticker,
    side: order.side,
    entryTimestamp: order.fillTimestamp!,
    entryPrice: order.fillPrice,
    size: order.fillSize,
    cost: order.fillPrice * order.fillSize + order.fees,
    exitTimestamp: null,
    exitPrice: null,
    exitReason: null,
    realizedPnl: null,
    unrealizedPnl: null,
    closingLinePrice: null,
    clv: null,
  };
}

/**
 * Close a position at resolution
 */
export function closePositionAtResolution(
  position: Position,
  result: 'yes' | 'no',
  settlementTime: string,
  closingLinePrice?: number
): Position {
  const exitPrice = result === position.side ? 1.0 : 0.0;

  // P&L = (exit - entry) * size for YES, (entry - exit) * size for NO buyer
  const pnl = (exitPrice - position.entryPrice) * position.size;
  const realizedPnl = pnl - (position.cost - position.entryPrice * position.size); // Subtract fees

  // CLV = closing_line_price - entry_price (positive = edge)
  const clv = closingLinePrice !== undefined ? closingLinePrice - position.entryPrice : null;

  return {
    ...position,
    exitTimestamp: settlementTime,
    exitPrice,
    exitReason: 'resolution',
    realizedPnl,
    unrealizedPnl: null,
    closingLinePrice: closingLinePrice ?? null,
    clv,
  };
}

/**
 * Close a position with stop-loss
 */
export function closePositionWithStopLoss(
  position: Position,
  currentPrice: number,
  timestamp: string
): Position {
  const pnl = (currentPrice - position.entryPrice) * position.size;
  const realizedPnl = pnl - (position.cost - position.entryPrice * position.size);

  return {
    ...position,
    exitTimestamp: timestamp,
    exitPrice: currentPrice,
    exitReason: 'stop_loss',
    realizedPnl,
    unrealizedPnl: null,
    closingLinePrice: null,
    clv: null,
  };
}

// ============================================================
// EQUITY TRACKING
// ============================================================

export interface EquityState {
  timestamp: string;
  cash: number;
  positions: Map<string, Position>;
}

/**
 * Initialize equity state
 */
export function initializeEquity(initialCapital: number, timestamp: string): EquityState {
  return {
    timestamp,
    cash: initialCapital,
    positions: new Map(),
  };
}

/**
 * Update equity after order fill
 */
export function updateEquityAfterFill(
  state: EquityState,
  order: SimulatedOrder,
  position: Position
): EquityState {
  const newCash = state.cash - position.cost;

  const newPositions = new Map(state.positions);
  newPositions.set(position.positionId, position);

  return {
    timestamp: order.fillTimestamp!,
    cash: newCash,
    positions: newPositions,
  };
}

/**
 * Update equity after position close
 */
export function updateEquityAfterClose(
  state: EquityState,
  closedPosition: Position
): EquityState {
  const pnl = closedPosition.realizedPnl ?? 0;
  const newCash = state.cash + closedPosition.entryPrice * closedPosition.size + pnl;

  const newPositions = new Map(state.positions);
  newPositions.delete(closedPosition.positionId);

  return {
    timestamp: closedPosition.exitTimestamp!,
    cash: newCash,
    positions: newPositions,
  };
}

/**
 * Compute current equity value
 */
export function computeEquity(
  state: EquityState,
  currentPrices: Map<string, number>
): number {
  let positionValue = 0;

  for (const position of state.positions.values()) {
    const currentPrice = currentPrices.get(position.ticker) ?? position.entryPrice;
    positionValue += currentPrice * position.size;
  }

  return state.cash + positionValue;
}

// ============================================================
// UTILITIES
// ============================================================

function generateOrderId(signal: Signal, timestamp: string): string {
  const input = `${signal.signalId}-${timestamp}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function generatePositionId(order: SimulatedOrder): string {
  const input = `${order.orderId}-${order.ticker}-${order.side}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Seeded random number generator for reproducible simulations
 */
function seededRandom(seed: string): number {
  const hash = createHash('sha256').update(seed).digest();
  const value = hash.readUInt32BE(0);
  return value / 0xffffffff;
}
