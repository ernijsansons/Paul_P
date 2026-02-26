/**
 * Paul P - Market Data Agent
 * Handles data ingestion, evidence storage, VPIN computation
 */

import { PaulPAgent } from './base';
import * as polymarketGamma from '../lib/polymarket/gamma';
import * as kalshiClient from '../lib/kalshi/client';
import { computeVPIN, type Trade } from '../lib/market-data/vpin';
import { computeAccountSkillScore, type AccountMetrics, type AccountPosition, type SkillScoreResult } from '../lib/scoring/account-skill';
import { estimateClosingLine, sampleMidpoints } from '../lib/scoring/closing-line';
import { normalizePrice, detectMechanics, type RawPriceInput, type MarketMechanics } from '../lib/utils/price-semantics';
import { inferMarketClass } from '../lib/scoring/clv';
import type { MarketClass } from '../lib/scoring/clv';
import { sha256String } from '../lib/evidence/hasher';

export class MarketDataAgent extends PaulPAgent {
  readonly agentName = 'market-data-agent';

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    switch (path) {
      case '/ingest/markets':
        return this.ingestMarkets(request);

      case '/ingest/orderbook':
        return this.ingestOrderbook(request);

      case '/ingest/account':
        return this.ingestAccount(request);

      case '/ingest/leaderboard':
        return this.ingestLeaderboard(request);

      case '/event/market-update':
        return this.handleMarketUpdate(request);

      case '/vpin/compute':
        return this.computeMarketVPIN(request);

      case '/vpin/status':
        return this.getVPINStatus(request);

      case '/skill/compute':
        return this.computeSkillScore(request);

      case '/skill/batch':
        return this.batchComputeSkillScores(request);

      case '/closing-line/compute':
        return this.computeClosingLine(request);

      case '/closing-line/store-observation':
        return this.storeClosingLineObservation(request);

      case '/price/normalize':
        return this.normalizeMarketPrice(request);

      case '/status':
        return this.getStatus();

      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  private async ingestMarkets(request: Request): Promise<Response> {
    const body = await request.json<{ venue: string; limit?: number }>();

    if (body.venue === 'polymarket') {
      const result = await polymarketGamma.fetchAllActiveMarkets(this.env, body.limit ?? 500);

      if (!result.ok) {
        return Response.json({ error: result.error.message }, { status: 500 });
      }

      // Store markets in D1
      for (const market of result.value.markets) {
        await this.upsertPolymarketMarket(market);
      }

      await this.logAudit('MARKETS_INGESTED', {
        venue: 'polymarket',
        count: result.value.markets.length,
        evidenceHashes: result.value.evidenceHashes,
      });

      return Response.json({
        success: true,
        count: result.value.markets.length,
        evidenceHashes: result.value.evidenceHashes,
      });
    }

    if (body.venue === 'kalshi') {
      const result = await kalshiClient.fetchAllActiveMarkets(this.env, body.limit ?? 500);

      if (!result.ok) {
        return Response.json({ error: result.error.message }, { status: 500 });
      }

      // Store markets in D1
      for (const market of result.value.markets) {
        await this.upsertKalshiMarket(market);
      }

      await this.logAudit('MARKETS_INGESTED', {
        venue: 'kalshi',
        count: result.value.markets.length,
        evidenceHashes: result.value.evidenceHashes,
      });

      return Response.json({
        success: true,
        count: result.value.markets.length,
        evidenceHashes: result.value.evidenceHashes,
      });
    }

    return Response.json({ error: 'Unknown venue' }, { status: 400 });
  }

  private async upsertPolymarketMarket(market: polymarketGamma.NormalizedMarket): Promise<void> {
    await this.env.DB.prepare(`
      INSERT INTO markets (
        condition_id, question, description, resolution_source, resolution_criteria,
        end_date, total_volume_usd, peak_volume_24h, avg_spread, category, tags,
        series, evidence_hash, last_synced_at, last_yes_price, venue, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (condition_id) DO UPDATE SET
        total_volume_usd = excluded.total_volume_usd,
        peak_volume_24h = excluded.peak_volume_24h,
        avg_spread = excluded.avg_spread,
        evidence_hash = excluded.evidence_hash,
        last_synced_at = excluded.last_synced_at,
        last_yes_price = excluded.last_yes_price,
        status = excluded.status
    `).bind(
      market.conditionId,
      market.question,
      market.description,
      market.resolutionSource,
      market.resolutionCriteria,
      market.endDate,
      market.volumeUsd,
      market.volume24hUsd,
      market.spread,
      market.category ?? null,
      JSON.stringify(market.tags),
      market.series ?? null,
      market.evidenceHash ?? null,
      market.fetchedAt,
      market.yesPrice, // last_yes_price
      'polymarket', // venue
      market.isResolved ? 'resolved' : (market.isClosed ? 'halted' : 'active') // status
    ).run();

    // Store normalized price using price-semantics (P-16)
    const rawInput: RawPriceInput = {
      mechanics: 'binary_token',
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
    };
    const normalized = normalizePrice(rawInput);

    await this.env.DB.prepare(`
      INSERT INTO normalized_prices (
        market_id, venue, p_yes, p_no, p_mid, spread, vig,
        clv_basis, is_valid, mechanics, warnings, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      market.conditionId,
      'polymarket',
      normalized.pYes,
      normalized.pNo,
      normalized.pMid,
      normalized.spread,
      normalized.vig,
      normalized.clvBasis,
      normalized.isValid ? 1 : 0,
      'binary_token',
      JSON.stringify(normalized.warnings),
      new Date().toISOString()
    ).run();

    // Store price observation for closing line computation (P-17)
    await this.env.DB.prepare(`
      INSERT INTO price_observations (market_id, venue, mid_price, depth_yes, depth_no, spread, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (market_id, timestamp) DO UPDATE SET mid_price = excluded.mid_price
    `).bind(
      market.conditionId,
      'polymarket',
      market.midPrice,
      market.liquidityUsd / 2, // Approximate depth split
      market.liquidityUsd / 2,
      market.spread,
      Date.now()
    ).run();
  }

  private async upsertKalshiMarket(market: kalshiClient.NormalizedKalshiMarket): Promise<void> {
    await this.env.DB.prepare(`
      INSERT INTO markets (
        condition_id, question, description, resolution_criteria,
        end_date, total_volume_usd, peak_volume_24h, avg_spread, category,
        series, evidence_hash, last_synced_at, last_yes_price, venue, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (condition_id) DO UPDATE SET
        total_volume_usd = excluded.total_volume_usd,
        peak_volume_24h = excluded.peak_volume_24h,
        avg_spread = excluded.avg_spread,
        evidence_hash = excluded.evidence_hash,
        last_synced_at = excluded.last_synced_at,
        last_yes_price = excluded.last_yes_price,
        status = excluded.status
    `).bind(
      market.ticker,
      market.title,
      '', // Kalshi doesn't have separate description
      market.rulesText,
      market.settlementTime,
      market.dollarVolume24h,
      market.dollarVolume24h,
      market.spread,
      market.category,
      market.seriesTicker,
      market.evidenceHash ?? null,
      market.fetchedAt,
      market.midPrice, // last_yes_price (use midPrice as approximation)
      'kalshi', // venue
      market.status === 'settled' ? 'resolved' : (market.status === 'closed' ? 'halted' : 'active') // status
    ).run();

    // Store normalized price using price-semantics (P-16)
    // Kalshi uses fee_adjusted mechanics due to taker fees
    const rawInput: RawPriceInput = {
      mechanics: 'fee_adjusted',
      yesBid: market.yesBid,
      yesAsk: market.yesAsk,
      noBid: market.noBid,
      noAsk: market.noAsk,
      takerFeeBps: 107, // Kalshi default taker fee ~1.07%
    };
    const normalized = normalizePrice(rawInput);

    await this.env.DB.prepare(`
      INSERT INTO normalized_prices (
        market_id, venue, p_yes, p_no, p_mid, spread, vig,
        clv_basis, is_valid, mechanics, warnings, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      market.ticker,
      'kalshi',
      normalized.pYes,
      normalized.pNo,
      normalized.pMid,
      normalized.spread,
      normalized.vig,
      normalized.clvBasis,
      normalized.isValid ? 1 : 0,
      'fee_adjusted',
      JSON.stringify(normalized.warnings),
      new Date().toISOString()
    ).run();

    // Store price observation for closing line computation (P-17)
    // Use open interest as depth approximation
    await this.env.DB.prepare(`
      INSERT INTO price_observations (market_id, venue, mid_price, depth_yes, depth_no, spread, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (market_id, timestamp) DO UPDATE SET mid_price = excluded.mid_price
    `).bind(
      market.ticker,
      'kalshi',
      market.midPrice,
      market.openInterest / 2, // Approximate depth split
      market.openInterest / 2,
      market.spread,
      Date.now()
    ).run();
  }

  private async ingestOrderbook(request: Request): Promise<Response> {
    const body = await request.json<{
      marketId: string;
      venue: string;
      conditionId?: string;
      tokenId?: string;
      trades: Array<{
        price: number;
        volume: number;
        timestamp: number;
        side?: 'buy' | 'sell';
        outcomeSide?: 'YES' | 'NO';
        proxyWallet?: string;
      }>;
      midpoints: Array<{ timestamp: number; price: number }>;
    }>();

    // Compute market context from latest midpoint
    const latestMidpoint = body.midpoints.length > 0
      ? body.midpoints[body.midpoints.length - 1]
      : null;
    const midPriceAtTrade = latestMidpoint?.price ?? null;

    // Store trades in D1 with all required schema columns
    for (const trade of body.trades) {
      // Generate deterministic trade ID from key fields
      const tradeKey = `${body.marketId}:${body.venue}:${trade.timestamp}:${trade.price}:${trade.volume}`;
      const tradeId = await sha256String(tradeKey);

      // Map side to outcome_side if not provided
      const outcomeSide = trade.outcomeSide ?? (trade.side === 'buy' ? 'YES' : 'NO');

      // Use provided proxy_wallet or generate placeholder
      const proxyWallet = trade.proxyWallet ?? `orderbook:${body.venue}`;

      // Use provided condition/token IDs or derive from market
      const conditionId = body.conditionId ?? body.marketId;
      const tokenId = body.tokenId ?? `${body.marketId}:${outcomeSide}`;

      // Compute evidence hash for this trade
      const evidenceHash = await sha256String(JSON.stringify({
        marketId: body.marketId,
        venue: body.venue,
        trade,
      }));

      await this.env.DB.prepare(`
        INSERT INTO trades (
          id, proxy_wallet, condition_id, token_id, side, outcome_side,
          price, size, timestamp, venue, market_id,
          mid_price_at_trade, spread_at_trade, volume_24h_at_trade,
          evidence_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        tradeId,
        proxyWallet,
        conditionId,
        tokenId,
        trade.side?.toUpperCase() ?? 'BUY',
        outcomeSide,
        trade.price,
        trade.volume, // size = volume
        new Date(trade.timestamp).toISOString(),
        body.venue,
        body.marketId,
        midPriceAtTrade,
        null, // spread_at_trade - not available from orderbook data
        null, // volume_24h_at_trade - not available from orderbook data
        evidenceHash,
        new Date().toISOString()
      ).run();
    }

    // Store midpoints for VPIN computation
    for (const mp of body.midpoints) {
      await this.env.DB.prepare(`
        INSERT INTO midpoints (market_id, price, timestamp)
        VALUES (?, ?, ?)
        ON CONFLICT (market_id, timestamp) DO UPDATE SET price = excluded.price
      `).bind(body.marketId, mp.price, mp.timestamp).run();
    }

    await this.logAudit('ORDERBOOK_INGESTED', {
      marketId: body.marketId,
      venue: body.venue,
      tradeCount: body.trades.length,
      midpointCount: body.midpoints.length,
    });

    return Response.json({
      success: true,
      tradesIngested: body.trades.length,
      midpointsIngested: body.midpoints.length,
    });
  }

  private async ingestAccount(request: Request): Promise<Response> {
    const body = await request.json<{
      accountId: string;
      venue: string;
      totalPositions: number;
      totalPnL: number;
      totalFees: number;
      portfolioValue: number;
      accountCreatedAt: number;
      lastActivityAt: number;
    }>();

    // Store account data for skill scoring
    await this.env.DB.prepare(`
      INSERT INTO account_metrics (
        account_id, venue, total_positions, total_pnl, total_fees,
        portfolio_value, account_created_at, last_activity_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, venue) DO UPDATE SET
        total_positions = excluded.total_positions,
        total_pnl = excluded.total_pnl,
        total_fees = excluded.total_fees,
        portfolio_value = excluded.portfolio_value,
        account_created_at = excluded.account_created_at,
        last_activity_at = excluded.last_activity_at,
        fetched_at = excluded.fetched_at
    `).bind(
      body.accountId,
      body.venue,
      body.totalPositions,
      body.totalPnL,
      body.totalFees,
      body.portfolioValue,
      body.accountCreatedAt,
      body.lastActivityAt,
      new Date().toISOString()
    ).run();

    await this.logAudit('ACCOUNT_INGESTED', {
      accountId: body.accountId,
      venue: body.venue,
    });

    return Response.json({ success: true, accountId: body.accountId });
  }

  private async ingestLeaderboard(request: Request): Promise<Response> {
    const body = await request.json<{
      venue: string;
      accounts: Array<{
        accountId: string;
        rank: number;
        profit: number;
        volume: number;
      }>;
    }>();

    // Store leaderboard entries
    for (const account of body.accounts) {
      await this.env.DB.prepare(`
        INSERT INTO leaderboard_entries (account_id, venue, rank, profit, volume, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (account_id, venue, fetched_at) DO NOTHING
      `).bind(
        account.accountId,
        body.venue,
        account.rank,
        account.profit,
        account.volume,
        new Date().toISOString()
      ).run();
    }

    await this.logAudit('LEADERBOARD_INGESTED', {
      venue: body.venue,
      accountCount: body.accounts.length,
    });

    return Response.json({
      success: true,
      entriesIngested: body.accounts.length,
    });
  }

  private async handleMarketUpdate(request: Request): Promise<Response> {
    const body = await request.json<{
      marketId: string;
      venue: string;
      price?: number;
      volume?: number;
      timestamp: number;
      depthYes?: number;
      depthNo?: number;
      spread?: number;
    }>();

    // Store price update with observation data if available
    if (body.price !== undefined) {
      // Store in price_observations for closing line computation
      await this.env.DB.prepare(`
        INSERT INTO price_observations (market_id, venue, mid_price, volume, timestamp, depth_yes, depth_no, spread)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (market_id, timestamp) DO UPDATE SET
          mid_price = excluded.mid_price,
          depth_yes = excluded.depth_yes,
          depth_no = excluded.depth_no,
          spread = excluded.spread
      `).bind(
        body.marketId,
        body.venue,
        body.price,
        body.volume ?? 0,
        body.timestamp,
        body.depthYes ?? 100, // Default depth
        body.depthNo ?? 100,
        body.spread ?? 0.05
      ).run();

      // Update markets table with last price
      await this.env.DB.prepare(`
        UPDATE markets SET last_yes_price = ?, last_synced_at = ? WHERE condition_id = ?
      `).bind(body.price, new Date().toISOString(), body.marketId).run();
    }

    return Response.json({ received: true, marketId: body.marketId });
  }

  /**
   * Compute VPIN for a specific market
   */
  private async computeMarketVPIN(request: Request): Promise<Response> {
    const body = await request.json<{
      marketId: string;
      bucketSize?: number;
      rollingBuckets?: number;
    }>();

    // Fetch trades from D1
    const tradesResult = await this.env.DB.prepare(`
      SELECT price, volume, timestamp, side
      FROM trades
      WHERE market_id = ?
      ORDER BY timestamp DESC
      LIMIT 5000
    `).bind(body.marketId).all<{ price: number; volume: number; timestamp: number; side: string | null }>();

    const trades: Trade[] = (tradesResult.results ?? []).map(t => ({
      price: t.price,
      volume: t.volume,
      timestamp: t.timestamp,
      side: t.side as 'buy' | 'sell' | undefined,
    }));

    // Fetch midpoints from D1
    const midpointsResult = await this.env.DB.prepare(`
      SELECT price, timestamp
      FROM midpoints
      WHERE market_id = ?
      ORDER BY timestamp DESC
      LIMIT 5000
    `).bind(body.marketId).all<{ price: number; timestamp: number }>();

    const midpoints = midpointsResult.results ?? [];

    // Compute VPIN
    const vpinResult = computeVPIN(trades, midpoints, {
      bucketSize: body.bucketSize,
      rollingBuckets: body.rollingBuckets,
    });

    // Store VPIN result
    await this.env.DB.prepare(`
      INSERT INTO vpin_snapshots (market_id, vpin, flow_classification, edge_multiplier, should_pause, bucket_count, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.marketId,
      vpinResult.currentVPIN,
      vpinResult.flowClassification,
      vpinResult.edgeMultiplier,
      vpinResult.shouldPause ? 1 : 0,
      vpinResult.buckets.length,
      vpinResult.lastUpdated
    ).run();

    await this.logAudit('VPIN_COMPUTED', {
      marketId: body.marketId,
      vpin: vpinResult.currentVPIN,
      classification: vpinResult.flowClassification,
    });

    return Response.json(vpinResult);
  }

  /**
   * Get current VPIN status for a market
   */
  private async getVPINStatus(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const marketId = url.searchParams.get('marketId');

    if (!marketId) {
      return Response.json({ error: 'marketId required' }, { status: 400 });
    }

    const result = await this.env.DB.prepare(`
      SELECT vpin, flow_classification, edge_multiplier, should_pause, bucket_count, computed_at
      FROM vpin_snapshots
      WHERE market_id = ?
      ORDER BY computed_at DESC
      LIMIT 1
    `).bind(marketId).first<{
      vpin: number;
      flow_classification: string;
      edge_multiplier: number;
      should_pause: number;
      bucket_count: number;
      computed_at: string;
    }>();

    if (!result) {
      return Response.json({ error: 'No VPIN data for market' }, { status: 404 });
    }

    return Response.json({
      marketId,
      currentVPIN: result.vpin,
      flowClassification: result.flow_classification,
      edgeMultiplier: result.edge_multiplier,
      shouldPause: result.should_pause === 1,
      bucketCount: result.bucket_count,
      lastUpdated: result.computed_at,
    });
  }

  /**
   * Compute skill score for an account
   */
  private async computeSkillScore(request: Request): Promise<Response> {
    const body = await request.json<{
      accountId: string;
      venue: string;
      includeCLV?: boolean;
    }>();

    // Fetch account base metrics from D1
    const accountData = await this.env.DB.prepare(`
      SELECT * FROM account_metrics
      WHERE account_id = ? AND venue = ?
    `).bind(body.accountId, body.venue).first<{
      total_positions: number;
      total_pnl: number;
      total_fees: number;
      portfolio_value: number;
      account_created_at: number;
      last_activity_at: number;
    }>();

    if (!accountData) {
      return Response.json({ error: 'Account metrics not found' }, { status: 404 });
    }

    // Fetch positions for this account
    const positionsResult = await this.env.DB.prepare(`
      SELECT condition_id as market_id, category, avg_entry_price as entry_price,
             closing_line_price, clv, clv_valid, realized_pnl as pnl,
             total_size as size, estimated_fees_usd as fees,
             0.2 as ambiguity_score, first_trade_at, last_trade_at
      FROM positions
      WHERE proxy_wallet = ?
    `).bind(body.accountId).all<{
      market_id: string;
      category: string;
      entry_price: number;
      closing_line_price: number;
      clv: number;
      clv_valid: number;
      pnl: number;
      size: number;
      fees: number;
      ambiguity_score: number;
      first_trade_at: string;
      last_trade_at: string;
    }>();

    const positions: AccountPosition[] = (positionsResult.results ?? []).map(p => ({
      marketId: p.market_id,
      category: p.category ?? 'unknown',
      entryPrice: p.entry_price ?? 0,
      closingLinePrice: p.closing_line_price ?? 0,
      clv: p.clv ?? 0,
      clvValid: p.clv_valid === 1,
      pnl: p.pnl ?? 0,
      size: p.size ?? 0,
      fees: p.fees ?? 0,
      ambiguityScore: p.ambiguity_score ?? 0.5,
      entryTimestamp: p.first_trade_at ? new Date(p.first_trade_at).getTime() : 0,
      exitTimestamp: p.last_trade_at ? new Date(p.last_trade_at).getTime() : 0,
    }));

    // Build AccountMetrics
    const accountMetrics: AccountMetrics = {
      accountId: body.accountId,
      totalPositions: accountData.total_positions,
      totalPnL: accountData.total_pnl,
      totalFees: accountData.total_fees,
      portfolioValue: accountData.portfolio_value,
      accountCreatedAt: accountData.account_created_at,
      lastActivityAt: accountData.last_activity_at,
      positions,
      blowupFlags: [], // Will be detected by the scoring function
    };

    const skillResult = computeAccountSkillScore(accountMetrics, body.includeCLV ?? true);

    // Store skill score
    await this.env.DB.prepare(`
      INSERT INTO skill_scores (account_id, venue, total_score, tier, factors, computed_at, included_clv)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.accountId,
      body.venue,
      skillResult.totalScore,
      skillResult.tier,
      JSON.stringify(skillResult.factors),
      skillResult.computedAt,
      skillResult.includedCLV ? 1 : 0
    ).run();

    await this.logAudit('SKILL_COMPUTED', {
      accountId: body.accountId,
      venue: body.venue,
      score: skillResult.totalScore,
      tier: skillResult.tier,
    });

    return Response.json(skillResult);
  }

  /**
   * Batch compute skill scores for multiple accounts
   */
  private async batchComputeSkillScores(request: Request): Promise<Response> {
    const body = await request.json<{
      venue: string;
      limit?: number;
      includeCLV?: boolean;
    }>();

    // Fetch all accounts with metrics
    const accounts = await this.env.DB.prepare(`
      SELECT DISTINCT account_id FROM account_metrics
      WHERE venue = ?
      LIMIT ?
    `).bind(body.venue, body.limit ?? 100).all<{ account_id: string }>();

    const results: Array<{ accountId: string; score: number; tier: string }> = [];

    for (const account of accounts.results ?? []) {
      try {
        // Create a mock request to reuse computeSkillScore logic
        const skillRequest = new Request('http://internal/skill/compute', {
          method: 'POST',
          body: JSON.stringify({
            accountId: account.account_id,
            venue: body.venue,
            includeCLV: body.includeCLV ?? true,
          }),
        });
        const response = await this.computeSkillScore(skillRequest);
        const result = await response.json<SkillScoreResult>();
        results.push({
          accountId: account.account_id,
          score: result.totalScore,
          tier: result.tier,
        });
      } catch (error) {
        // Log but continue processing other accounts
        await this.logAudit('SKILL_COMPUTE_ERROR', {
          accountId: account.account_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Response.json({
      processed: results.length,
      results,
    });
  }

  /**
   * Compute robust closing line for a market (P-17)
   */
  private async computeClosingLine(request: Request): Promise<Response> {
    const body = await request.json<{
      marketId: string;
      resolutionTime: number; // Unix timestamp ms
      category?: string;
      tags?: string[];
    }>();

    // Infer market class from category/tags
    const marketClass: MarketClass = inferMarketClass(body.category, body.tags);

    // Fetch price observations from D1 (need depth and spread data)
    const observationsResult = await this.env.DB.prepare(`
      SELECT timestamp, mid_price, depth_yes, depth_no, spread
      FROM price_observations
      WHERE market_id = ?
      ORDER BY timestamp DESC
      LIMIT 1000
    `).bind(body.marketId).all<{
      timestamp: number;
      mid_price: number;
      depth_yes: number | null;
      depth_no: number | null;
      spread: number | null;
    }>();

    // Convert to PriceObservation format
    const priceHistory = (observationsResult.results ?? []).map(o => ({
      timestamp: o.timestamp,
      midPrice: o.mid_price,
      depthYes: o.depth_yes ?? 100, // Default depth if not available
      depthNo: o.depth_no ?? 100,
      spread: o.spread ?? 0.05,
    }));

    // Sample at 15-second intervals
    const windowConfig = { political: 60 * 60 * 1000, sports: 0, weather: 5 * 60 * 1000, mentions: 30 * 1000, crypto: 60 * 1000 };
    const windowMs = windowConfig[marketClass] || 60 * 60 * 1000;
    const windowStart = body.resolutionTime - windowMs;

    const observations = sampleMidpoints(priceHistory, windowStart, body.resolutionTime);

    // Estimate closing line with quality scoring
    const clResult = estimateClosingLine(observations, marketClass, body.resolutionTime);

    // Store closing line result
    await this.env.DB.prepare(`
      INSERT INTO closing_line_results (
        market_id, closing_line_price, quality_score, is_valid, method,
        depth_score, spread_score, sample_score, stability_score,
        observation_count, valid_observation_count, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.marketId,
      clResult.closingLinePrice,
      clResult.qualityScore,
      clResult.isValid ? 1 : 0,
      clResult.method,
      clResult.depthScore,
      clResult.spreadScore,
      clResult.sampleScore,
      clResult.stabilityScore,
      clResult.observationCount,
      clResult.validObservationCount,
      new Date().toISOString()
    ).run();

    await this.logAudit('CLOSING_LINE_COMPUTED', {
      marketId: body.marketId,
      closingLinePrice: clResult.closingLinePrice,
      qualityScore: clResult.qualityScore,
      isValid: clResult.isValid,
      marketClass,
    });

    return Response.json(clResult);
  }

  /**
   * Store a price observation with depth/spread for closing line computation
   */
  private async storeClosingLineObservation(request: Request): Promise<Response> {
    const body = await request.json<{
      marketId: string;
      venue: string;
      timestamp: number;
      midPrice: number;
      depthYes: number;
      depthNo: number;
      spread: number;
      volume?: number;
    }>();

    await this.env.DB.prepare(`
      INSERT INTO price_observations (
        market_id, venue, mid_price, volume, timestamp,
        depth_yes, depth_no, spread
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (market_id, timestamp) DO UPDATE SET
        mid_price = excluded.mid_price,
        depth_yes = excluded.depth_yes,
        depth_no = excluded.depth_no,
        spread = excluded.spread
    `).bind(
      body.marketId,
      body.venue,
      body.midPrice,
      body.volume ?? 0,
      body.timestamp,
      body.depthYes,
      body.depthNo,
      body.spread
    ).run();

    return Response.json({
      stored: true,
      marketId: body.marketId,
      timestamp: body.timestamp,
    });
  }

  /**
   * Normalize price using price-semantics layer (P-16)
   */
  private async normalizeMarketPrice(request: Request): Promise<Response> {
    const body = await request.json<{
      venue: 'polymarket' | 'kalshi';
      marketId: string;
      // Raw price data
      yesPrice?: number;
      noPrice?: number;
      yesBid?: number;
      yesAsk?: number;
      noBid?: number;
      noAsk?: number;
      outcomePrices?: number[];
      takerFeeBps?: number;
      voidProbability?: number;
      // Detection hints
      hasOrderbook?: boolean;
      outcomeCount?: number;
      voidHistory?: boolean;
    }>();

    // Detect market mechanics if not explicitly provided
    const mechanics: MarketMechanics = detectMechanics({
      venue: body.venue,
      hasOrderbook: body.hasOrderbook ?? (body.yesBid !== undefined),
      outcomeCount: body.outcomeCount ?? (body.outcomePrices?.length ?? 2),
      voidHistory: body.voidHistory ?? false,
    });

    // Build raw price input
    const rawInput: RawPriceInput = {
      mechanics,
      yesPrice: body.yesPrice,
      noPrice: body.noPrice,
      yesBid: body.yesBid,
      yesAsk: body.yesAsk,
      noBid: body.noBid,
      noAsk: body.noAsk,
      outcomePrices: body.outcomePrices,
      takerFeeBps: body.takerFeeBps,
      voidProbability: body.voidProbability,
    };

    // Normalize
    const normalized = normalizePrice(rawInput);

    // Store normalized price
    await this.env.DB.prepare(`
      INSERT INTO normalized_prices (
        market_id, venue, p_yes, p_no, p_mid, spread, vig,
        clv_basis, is_valid, mechanics, warnings, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.marketId,
      body.venue,
      normalized.pYes,
      normalized.pNo,
      normalized.pMid,
      normalized.spread,
      normalized.vig,
      normalized.clvBasis,
      normalized.isValid ? 1 : 0,
      mechanics,
      JSON.stringify(normalized.warnings),
      new Date().toISOString()
    ).run();

    return Response.json({
      marketId: body.marketId,
      venue: body.venue,
      mechanics,
      normalized,
    });
  }

  private async getStatus(): Promise<Response> {
    const marketCount = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM markets
    `).first<{ count: number }>();

    return Response.json({
      agent: this.agentName,
      status: 'operational',
      marketCount: marketCount?.count ?? 0,
      timestamp: new Date().toISOString(),
    });
  }
}
