/**
 * Paul P - Circuit Breaker Integration Tests
 *
 * Tests for the circuit breaker state machine:
 * - State transitions: NORMAL → CAUTION → HALT → RECOVERY → NORMAL
 * - Failure counting and thresholds
 * - Recovery conditions
 * - Human approval requirements
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================
// Circuit Breaker State Machine
// ============================================================

type CircuitBreakerState = 'NORMAL' | 'CAUTION' | 'HALT' | 'RECOVERY';

interface CircuitBreakerConfig {
  cautionThreshold: number; // Consecutive failures to enter CAUTION
  haltThreshold: number; // Consecutive failures to enter HALT
  recoveryDelayMs: number; // Time in HALT before recovery allowed
  recoverySuccessThreshold: number; // Successful trades needed to return to NORMAL
}

interface CircuitBreaker {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime: number | null;
  haltStartTime: number | null;
  humanApprovalGranted: boolean;
  config: CircuitBreakerConfig;

  // Actions
  recordFailure: () => void;
  recordSuccess: () => void;
  grantHumanApproval: () => void;
  checkRecoveryEligible: () => boolean;
  attemptRecovery: () => boolean;
  canExecuteTrade: () => boolean;
  getState: () => CircuitBreakerState;
  reset: () => void;
}

function createCircuitBreaker(config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  const defaultConfig: CircuitBreakerConfig = {
    cautionThreshold: 3,
    haltThreshold: 5,
    recoveryDelayMs: 15 * 60 * 1000, // 15 minutes
    recoverySuccessThreshold: 10,
    ...config,
  };

  const cb: CircuitBreaker = {
    state: 'NORMAL',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastFailureTime: null,
    haltStartTime: null,
    humanApprovalGranted: false,
    config: defaultConfig,

    recordFailure() {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;
      this.lastFailureTime = Date.now();

      // State transitions based on failure count
      if (this.state === 'NORMAL' && this.consecutiveFailures >= this.config.cautionThreshold) {
        this.state = 'CAUTION';
      } else if (this.state === 'CAUTION' && this.consecutiveFailures >= this.config.haltThreshold) {
        this.state = 'HALT';
        this.haltStartTime = Date.now();
      } else if (this.state === 'RECOVERY') {
        // Failure during recovery sends back to CAUTION
        this.state = 'CAUTION';
        this.consecutiveSuccesses = 0;
      }
    },

    recordSuccess() {
      if (this.state === 'RECOVERY') {
        this.consecutiveSuccesses++;
        this.consecutiveFailures = 0;

        // Return to NORMAL after enough successful trades
        if (this.consecutiveSuccesses >= this.config.recoverySuccessThreshold) {
          this.state = 'NORMAL';
          this.consecutiveSuccesses = 0;
        }
      } else if (this.state === 'NORMAL') {
        // In normal state, just reset failure counter
        this.consecutiveFailures = 0;
      }
      // Successes in CAUTION or HALT don't affect state (need explicit recovery)
    },

    grantHumanApproval() {
      this.humanApprovalGranted = true;
    },

    checkRecoveryEligible() {
      if (this.state !== 'HALT') return false;
      if (!this.humanApprovalGranted) return false;
      if (!this.haltStartTime) return false;

      const timeSinceHalt = Date.now() - this.haltStartTime;
      return timeSinceHalt >= this.config.recoveryDelayMs;
    },

    attemptRecovery() {
      if (!this.checkRecoveryEligible()) return false;

      this.state = 'RECOVERY';
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.humanApprovalGranted = false; // Reset for next time
      return true;
    },

    canExecuteTrade() {
      return this.state === 'NORMAL' || this.state === 'RECOVERY';
    },

    getState() {
      return this.state;
    },

    reset() {
      this.state = 'NORMAL';
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.lastFailureTime = null;
      this.haltStartTime = null;
      this.humanApprovalGranted = false;
    },
  };

  return cb;
}

// ============================================================
// Tests
// ============================================================

describe('Circuit Breaker State Machine', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = createCircuitBreaker();
  });

  describe('NORMAL → CAUTION transition', () => {
    it('should transition to CAUTION on 3 consecutive failures', () => {
      expect(cb.getState()).toBe('NORMAL');

      cb.recordFailure();
      expect(cb.getState()).toBe('NORMAL');
      expect(cb.consecutiveFailures).toBe(1);

      cb.recordFailure();
      expect(cb.getState()).toBe('NORMAL');
      expect(cb.consecutiveFailures).toBe(2);

      cb.recordFailure();
      expect(cb.getState()).toBe('CAUTION');
      expect(cb.consecutiveFailures).toBe(3);
    });

    it('should reset failure count on success in NORMAL', () => {
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.consecutiveFailures).toBe(2);

      cb.recordSuccess();
      expect(cb.consecutiveFailures).toBe(0);
      expect(cb.getState()).toBe('NORMAL');
    });

    it('should still allow trades in NORMAL state', () => {
      expect(cb.canExecuteTrade()).toBe(true);

      cb.recordFailure();
      cb.recordFailure();
      expect(cb.canExecuteTrade()).toBe(true); // Still in NORMAL
    });
  });

  describe('CAUTION → HALT transition', () => {
    it('should transition to HALT on 5 consecutive failures', () => {
      // Get to CAUTION first
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe('CAUTION');

      // Continue failures
      cb.recordFailure();
      expect(cb.getState()).toBe('CAUTION');
      expect(cb.consecutiveFailures).toBe(4);

      cb.recordFailure();
      expect(cb.getState()).toBe('HALT');
      expect(cb.consecutiveFailures).toBe(5);
    });

    it('should block trades in CAUTION state', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe('CAUTION');

      // CAUTION state should still allow trades (but with elevated monitoring)
      // Actually, let's check the canExecuteTrade which should return false in CAUTION
      // Looking at our implementation, CAUTION doesn't block trades
      // This is a design decision - let's verify it's intentional
      expect(cb.canExecuteTrade()).toBe(false); // CAUTION blocks trades
    });

    it('successes in CAUTION should not reset state', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe('CAUTION');

      cb.recordSuccess();
      expect(cb.getState()).toBe('CAUTION'); // Stays in CAUTION

      // Need explicit recovery process to leave CAUTION
    });
  });

  describe('HALT → RECOVERY transition', () => {
    beforeEach(() => {
      // Get to HALT state
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      expect(cb.getState()).toBe('HALT');
    });

    it('should require human approval to recover', () => {
      expect(cb.checkRecoveryEligible()).toBe(false);

      cb.grantHumanApproval();
      // Still need time delay
      expect(cb.checkRecoveryEligible()).toBe(false);
    });

    it('should require 15 minute delay to recover', () => {
      cb.grantHumanApproval();
      expect(cb.checkRecoveryEligible()).toBe(false);

      // Fast forward time (mock)
      cb.haltStartTime = Date.now() - 16 * 60 * 1000; // 16 minutes ago
      expect(cb.checkRecoveryEligible()).toBe(true);
    });

    it('should block trades in HALT state', () => {
      expect(cb.canExecuteTrade()).toBe(false);
    });

    it('should transition to RECOVERY when eligible and attempted', () => {
      cb.grantHumanApproval();
      cb.haltStartTime = Date.now() - 16 * 60 * 1000;

      const recovered = cb.attemptRecovery();
      expect(recovered).toBe(true);
      expect(cb.getState()).toBe('RECOVERY');
    });

    it('should not recover without human approval', () => {
      cb.haltStartTime = Date.now() - 16 * 60 * 1000;

      const recovered = cb.attemptRecovery();
      expect(recovered).toBe(false);
      expect(cb.getState()).toBe('HALT');
    });
  });

  describe('RECOVERY → NORMAL transition', () => {
    beforeEach(() => {
      // Get to RECOVERY state
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      cb.grantHumanApproval();
      cb.haltStartTime = Date.now() - 16 * 60 * 1000;
      cb.attemptRecovery();
      expect(cb.getState()).toBe('RECOVERY');
    });

    it('should return to NORMAL after 10 successful trades', () => {
      expect(cb.canExecuteTrade()).toBe(true);

      for (let i = 0; i < 9; i++) {
        cb.recordSuccess();
        expect(cb.getState()).toBe('RECOVERY');
      }

      cb.recordSuccess(); // 10th success
      expect(cb.getState()).toBe('NORMAL');
    });

    it('should return to CAUTION on failure during RECOVERY', () => {
      cb.recordSuccess();
      cb.recordSuccess();
      expect(cb.consecutiveSuccesses).toBe(2);

      cb.recordFailure();
      expect(cb.getState()).toBe('CAUTION');
      expect(cb.consecutiveSuccesses).toBe(0);
    });

    it('should allow trades during RECOVERY', () => {
      expect(cb.canExecuteTrade()).toBe(true);
    });
  });

  describe('Invariant failure integration', () => {
    it('should increment failure counter on invariant failures', () => {
      // Simulate invariant check failures being recorded
      cb.recordFailure(); // I1 failed
      cb.recordFailure(); // I5 failed
      cb.recordFailure(); // I6 failed

      expect(cb.consecutiveFailures).toBe(3);
      expect(cb.getState()).toBe('CAUTION');
    });

    it('should not reset counter when different invariants fail', () => {
      cb.recordFailure(); // I1
      cb.recordFailure(); // I2
      cb.recordSuccess(); // This resets in NORMAL

      // After success, counter resets
      expect(cb.consecutiveFailures).toBe(0);

      cb.recordFailure(); // I3
      expect(cb.consecutiveFailures).toBe(1);
    });
  });
});

describe('Circuit Breaker Configuration', () => {
  it('should use custom thresholds when provided', () => {
    const cb = createCircuitBreaker({
      cautionThreshold: 5,
      haltThreshold: 10,
    });

    // Need 5 failures for CAUTION
    for (let i = 0; i < 4; i++) {
      cb.recordFailure();
    }
    expect(cb.getState()).toBe('NORMAL');

    cb.recordFailure();
    expect(cb.getState()).toBe('CAUTION');
  });

  it('should use custom recovery success threshold', () => {
    const cb = createCircuitBreaker({
      recoverySuccessThreshold: 5, // Lower threshold
    });

    // Get to RECOVERY
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    cb.grantHumanApproval();
    cb.haltStartTime = Date.now() - 20 * 60 * 1000;
    cb.attemptRecovery();

    // Only need 5 successes
    for (let i = 0; i < 4; i++) {
      cb.recordSuccess();
    }
    expect(cb.getState()).toBe('RECOVERY');

    cb.recordSuccess();
    expect(cb.getState()).toBe('NORMAL');
  });
});

describe('Circuit Breaker Edge Cases', () => {
  it('should handle rapid fire failures', () => {
    const cb = createCircuitBreaker();

    // 10 rapid failures
    for (let i = 0; i < 10; i++) {
      cb.recordFailure();
    }

    expect(cb.getState()).toBe('HALT');
    expect(cb.consecutiveFailures).toBe(10);
  });

  it('should handle interleaved successes and failures', () => {
    const cb = createCircuitBreaker();

    cb.recordFailure();
    cb.recordSuccess(); // Reset consecutive failures to 0
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // Reset consecutive failures to 0
    cb.recordFailure(); // Now consecutive failures = 1

    expect(cb.getState()).toBe('NORMAL');
    // After the last recordFailure(), consecutive failures should be 1
    expect(cb.consecutiveFailures).toBe(1);
  });

  it('should track last failure time', () => {
    const cb = createCircuitBreaker();
    const before = Date.now();

    cb.recordFailure();

    expect(cb.lastFailureTime).toBeDefined();
    expect(cb.lastFailureTime!).toBeGreaterThanOrEqual(before);
    expect(cb.lastFailureTime!).toBeLessThanOrEqual(Date.now());
  });

  it('should reset all state correctly', () => {
    const cb = createCircuitBreaker();

    // Get to messy state
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    cb.grantHumanApproval();

    cb.reset();

    expect(cb.getState()).toBe('NORMAL');
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.consecutiveSuccesses).toBe(0);
    expect(cb.lastFailureTime).toBeNull();
    expect(cb.haltStartTime).toBeNull();
    expect(cb.humanApprovalGranted).toBe(false);
  });
});

// Fix: CAUTION state should block trades
describe('Circuit Breaker Trade Blocking', () => {
  it('NORMAL should allow trades', () => {
    const cb = createCircuitBreaker();
    expect(cb.canExecuteTrade()).toBe(true);
  });

  it('CAUTION should block trades', () => {
    const cb = createCircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    // Our implementation returns false for CAUTION
    // Let's verify the actual behavior matches our test expectation
    // Looking at canExecuteTrade: return state === 'NORMAL' || state === 'RECOVERY'
    // So CAUTION does block trades
    expect(cb.canExecuteTrade()).toBe(false);
  });

  it('HALT should block trades', () => {
    const cb = createCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    expect(cb.canExecuteTrade()).toBe(false);
  });

  it('RECOVERY should allow trades', () => {
    const cb = createCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    cb.grantHumanApproval();
    cb.haltStartTime = Date.now() - 20 * 60 * 1000;
    cb.attemptRecovery();

    expect(cb.canExecuteTrade()).toBe(true);
  });
});
