/**
 * Paul P - Market Pairing Workflow
 *
 * Manages cross-venue pair discovery and human approval flow.
 */

import type { Env } from '../types/env';
import type { CanonicalMarket } from '../lib/research/market-pairing';

export interface MarketPairCandidate {
  polymarketId: string;
  polymarketTitle: string;
  kalshiId: string;
  kalshiTitle: string;
  matchScore: number;
}

export class MarketPairingWorkflow {
  constructor(private readonly env: Env) {}

  private getResearchAgent() {
    const id = this.env.RESEARCH_AGENT.idFromName('singleton');
    return this.env.RESEARCH_AGENT.get(id);
  }

  async findPotentialPairs(
    polymarketMarkets: CanonicalMarket[],
    kalshiMarkets: CanonicalMarket[],
    minMatchScore?: number
  ): Promise<{ pairs: MarketPairCandidate[] }> {
    const agent = this.getResearchAgent();
    const response = await agent.fetch('http://internal/find-pairs', {
      method: 'POST',
      body: JSON.stringify({
        polymarketMarkets,
        kalshiMarkets,
        minMatchScore,
      }),
    });
    return response.json();
  }

  async proposePair(
    canonicalEventId: string,
    marketA: CanonicalMarket,
    marketB: CanonicalMarket
  ): Promise<unknown> {
    const agent = this.getResearchAgent();
    const response = await agent.fetch('http://internal/propose-pair', {
      method: 'POST',
      body: JSON.stringify({
        canonicalEventId,
        marketA,
        marketB,
      }),
    });
    return response.json();
  }

  async approvePair(pairId: string, reviewerId: string): Promise<unknown> {
    const agent = this.getResearchAgent();
    const response = await agent.fetch('http://internal/approve-pair', {
      method: 'POST',
      body: JSON.stringify({ pairId, reviewerId }),
    });
    return response.json();
  }

  async rejectPair(pairId: string, reviewerId: string): Promise<unknown> {
    const agent = this.getResearchAgent();
    const response = await agent.fetch('http://internal/reject-pair', {
      method: 'POST',
      body: JSON.stringify({ pairId, reviewerId }),
    });
    return response.json();
  }

  async expireStalePairs(): Promise<unknown> {
    const agent = this.getResearchAgent();
    const response = await agent.fetch('http://internal/expire-pairs', {
      method: 'POST',
    });
    return response.json();
  }
}

