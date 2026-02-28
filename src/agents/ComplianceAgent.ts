/**
 * Paul P - Compliance Agent
 * CFTC logging, ToS enforcement, regulatory export
 *
 * Implements CFTC Part 17 Large Trader Reporting format
 * for regulatory compliance and audit trail.
 */

import { PaulPAgent } from './base';
import { deterministicId } from '../lib/utils/deterministic-id';

/**
 * CFTC Part 17 Record format
 */
interface CFTCRecord {
  // Record identification
  recordSequence: number;
  reportDate: string;

  // Trader identification
  traderId: string;
  traderType: string;

  // Contract identification
  contractMarket: string;
  contractCode: string;
  contractDescription: string;

  // Position details
  positionDate: string;
  positionType: 'LONG' | 'SHORT';
  positionQuantity: number;
  positionPrice: number;

  // Trade details
  tradeId: string;
  tradeDate: string;
  tradeTime: string;
  executionTime: string;
  tradePrice: number;
  tradeQuantity: number;

  // Classification
  accountType: string;
  tradingPurpose: string;
  hedgeFlag: 'Y' | 'N';

  // Status
  orderStatus: string;
}

export class ComplianceAgent extends PaulPAgent {
  readonly agentName = 'compliance-agent';
  private complianceSeeded = false;

  protected async handleRequest(request: Request, path: string): Promise<Response> {
    switch (path) {
      case '/check-source':
        return this.checkSource(request);
      case '/check-batch':
        return this.checkBatch(request);
      case '/export-orders':
        return this.exportOrders(request);
      case '/review-tos':
        return this.reviewToS();
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  private async checkSource(request: Request): Promise<Response> {
    await this.ensureComplianceSeeded();

    const { sourceName } = await request.json<{ sourceName: string }>();

    const row = await this.env.DB.prepare(`
      SELECT status, allowed_usage FROM compliance_matrix WHERE source_name = ?
    `).bind(sourceName).first<{ status: string; allowed_usage: string }>();

    if (!row) {
      return Response.json({ approved: false, reason: 'Source not in compliance matrix' });
    }

    return Response.json({
      approved: row.status === 'approved',
      status: row.status,
      allowedUsage: JSON.parse(row.allowed_usage),
    });
  }

  /**
   * Check batch of entities for compliance
   * Fail-closed: if ANY entity is blocked or unknown, return allowed: false
   */
  private async checkBatch(request: Request): Promise<Response> {
    await this.ensureComplianceSeeded();

    const { entities, operation, venue } = await request.json<{
      entities: string[];
      operation: string;
      venue: string;
    }>();

    const blockedEntities: string[] = [];
    let overallStatus = 'approved';

    if (!entities || entities.length === 0) {
      return Response.json({
        allowed: false,
        reason: `No compliance entities provided for ${venue}:${operation}`,
        blockedEntities: [],
      });
    }

    // Check each entity
    for (const entity of entities) {
      const row = await this.env.DB.prepare(`
        SELECT status FROM compliance_matrix WHERE source_name = ?
      `).bind(entity).first<{ status: string }>();

      if (!row) {
        // Entity not in compliance matrix - fail closed
        blockedEntities.push(entity);
        overallStatus = 'unknown';
      } else if (row.status !== 'approved') {
        blockedEntities.push(entity);
        overallStatus = row.status;
      }
    }

    if (blockedEntities.length > 0) {
      return Response.json({
        allowed: false,
        status: overallStatus,
        reason: `${blockedEntities.length} entities blocked or unknown`,
        blockedEntities,
      });
    }

    // Log successful compliance check
    await this.logAudit('COMPLIANCE_CHECK_PASSED', {
      entities,
      operation,
      venue,
    });

    return Response.json({
      allowed: true,
      status: 'approved',
    });
  }

  private async exportOrders(request: Request): Promise<Response> {
    const { startDate, endDate, format } = await request.json<{
      startDate: string;
      endDate: string;
      format?: 'json' | 'csv' | 'cftc';
    }>();

    const orders = await this.env.DB.prepare(`
      SELECT
        o.order_id,
        o.market_id,
        o.venue,
        o.side,
        o.size,
        o.price,
        o.fill_price,
        o.status,
        o.strategy_id,
        o.created_at,
        o.filled_at,
        m.category,
        m.question
      FROM orders o
      LEFT JOIN markets m ON o.market_id = m.condition_id
      WHERE o.created_at BETWEEN ? AND ?
      ORDER BY o.created_at
    `).bind(startDate, endDate).all<{
      order_id: string;
      market_id: string;
      venue: string;
      side: string;
      size: number;
      price: number;
      fill_price: number | null;
      status: string;
      strategy_id: string;
      created_at: string;
      filled_at: string | null;
      category: string | null;
      question: string | null;
    }>();

    const results = orders.results ?? [];

    // Format for CFTC Part 17 export
    if (format === 'cftc' || format === 'csv') {
      const cftcRecords = this.formatCFTCExport(results);

      if (format === 'csv') {
        const csv = this.convertToCFTCCsv(cftcRecords);
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="cftc_export_${startDate}_${endDate}.csv"`,
          },
        });
      }

      return Response.json({
        format: 'cftc_part17',
        reportPeriod: { startDate, endDate },
        recordCount: cftcRecords.length,
        records: cftcRecords,
      });
    }

    return Response.json({ orders: results });
  }

  /**
   * Format orders for CFTC Part 17 reporting
   * Reference: CFTC Part 17 Large Trader Reporting
   */
  private formatCFTCExport(orders: Array<{
    order_id: string;
    market_id: string;
    venue: string;
    side: string;
    size: number;
    price: number;
    fill_price: number | null;
    status: string;
    strategy_id: string;
    created_at: string;
    filled_at: string | null;
    category: string | null;
    question: string | null;
  }>): CFTCRecord[] {
    return orders.map((order, idx) => ({
      // Record identification
      recordSequence: idx + 1,
      reportDate: new Date().toISOString().split('T')[0] ?? '',

      // Trader identification (pseudonymized for privacy)
      traderId: 'PAULP_001',
      traderType: 'ALGORITHMIC_TRADING_SYSTEM',

      // Contract identification
      contractMarket: this.mapVenueToCFTC(order.venue),
      contractCode: this.mapCategoryToContractCode(order.category ?? 'OTHER'),
      contractDescription: order.question?.substring(0, 100) ?? order.market_id,

      // Position details
      positionDate: order.created_at.split('T')[0] ?? '',
      positionType: order.side === 'YES' ? 'LONG' : 'SHORT',
      positionQuantity: order.size,
      positionPrice: (order.fill_price ?? order.price) / 100, // Convert cents to dollars

      // Trade details
      tradeId: order.order_id,
      tradeDate: order.created_at,
      tradeTime: order.created_at.split('T')[1]?.split('.')[0] ?? '00:00:00',
      executionTime: order.filled_at ?? '',
      tradePrice: (order.fill_price ?? order.price) / 100,
      tradeQuantity: order.size,

      // Classification
      accountType: 'PROPRIETARY',
      tradingPurpose: this.mapStrategyToTradingPurpose(order.strategy_id),
      hedgeFlag: 'N', // Not hedging

      // Status
      orderStatus: this.mapStatusToCFTC(order.status),
    }));
  }

  /**
   * Convert CFTC records to CSV format
   */
  private convertToCFTCCsv(records: CFTCRecord[]): string {
    const headers = [
      'Record_Sequence',
      'Report_Date',
      'Trader_ID',
      'Trader_Type',
      'Contract_Market',
      'Contract_Code',
      'Contract_Description',
      'Position_Date',
      'Position_Type',
      'Position_Quantity',
      'Position_Price',
      'Trade_ID',
      'Trade_Date',
      'Trade_Time',
      'Execution_Time',
      'Trade_Price',
      'Trade_Quantity',
      'Account_Type',
      'Trading_Purpose',
      'Hedge_Flag',
      'Order_Status',
    ];

    const rows = records.map(r => [
      r.recordSequence,
      r.reportDate,
      r.traderId,
      r.traderType,
      r.contractMarket,
      r.contractCode,
      `"${r.contractDescription.replace(/"/g, '""')}"`, // Escape quotes in description
      r.positionDate,
      r.positionType,
      r.positionQuantity,
      r.positionPrice.toFixed(4),
      r.tradeId,
      r.tradeDate,
      r.tradeTime,
      r.executionTime,
      r.tradePrice.toFixed(4),
      r.tradeQuantity,
      r.accountType,
      r.tradingPurpose,
      r.hedgeFlag,
      r.orderStatus,
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Map venue to CFTC contract market code
   */
  private mapVenueToCFTC(venue: string): string {
    const venueMap: Record<string, string> = {
      kalshi: 'KALSHI',
      polymarket: 'POLY', // Read-only, won't actually appear in trades
    };
    return venueMap[venue.toLowerCase()] ?? 'OTHER';
  }

  /**
   * Map category to CFTC contract code
   */
  private mapCategoryToContractCode(category: string): string {
    const categoryMap: Record<string, string> = {
      politics: 'POL',
      economics: 'ECON',
      weather: 'WX',
      sports: 'SPT',
      entertainment: 'ENT',
      crypto: 'CRPT',
      science: 'SCI',
      finance: 'FIN',
      technology: 'TECH',
    };
    return categoryMap[category.toLowerCase()] ?? 'OTH';
  }

  /**
   * Map strategy to CFTC trading purpose
   */
  private mapStrategyToTradingPurpose(strategyId: string): string {
    const strategyMap: Record<string, string> = {
      bonding: 'STATISTICAL_ARBITRAGE',
      weather: 'FUNDAMENTAL_ANALYSIS',
      xv_signal: 'CROSS_VENUE_ARBITRAGE',
      smart_money: 'FLOW_FOLLOWING',
      resolution: 'FUNDAMENTAL_ANALYSIS',
    };

    for (const [key, value] of Object.entries(strategyMap)) {
      if (strategyId.toLowerCase().includes(key)) {
        return value;
      }
    }
    return 'SYSTEMATIC_TRADING';
  }

  /**
   * Map order status to CFTC status code
   */
  private mapStatusToCFTC(status: string): string {
    const statusMap: Record<string, string> = {
      filled: 'EXECUTED',
      partial_fill: 'PARTIAL',
      pending: 'PENDING',
      submitted: 'SUBMITTED',
      cancelled: 'CANCELLED',
      rejected: 'REJECTED',
      expired: 'EXPIRED',
    };
    return statusMap[status.toLowerCase()] ?? 'UNKNOWN';
  }

  private async reviewToS(): Promise<Response> {
    await this.ensureComplianceSeeded();

    // Check for ToS that need review
    const needsReview = await this.env.DB.prepare(`
      SELECT source_name, tos_url, tos_next_review_date
      FROM compliance_matrix
      WHERE tos_next_review_date < ?
    `).bind(new Date().toISOString()).all();

    return Response.json({ needsReview: needsReview.results });
  }

  private async ensureComplianceSeeded(): Promise<void> {
    if (this.complianceSeeded) return;

    const now = new Date().toISOString();
    const nextQuarter = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const defaults: Array<{
      sourceName: string;
      tosUrl: string;
      status: 'approved' | 'blocked';
      blockReason?: string;
      authType?: string;
      authRequired?: number;
      scrapingPermitted?: number | null;
      allowedUsage?: string[];
      prohibitedUsage?: string[];
    }> = [
      {
        sourceName: 'polymarket_gamma_api',
        tosUrl: 'https://polymarket.com/tos',
        status: 'approved',
        scrapingPermitted: 1,
        allowedUsage: ['market_data_read', 'resolution_criteria', 'event_metadata'],
      },
      {
        sourceName: 'polymarket_clob_api',
        tosUrl: 'https://polymarket.com/tos',
        status: 'approved',
        scrapingPermitted: 1,
        allowedUsage: ['orderbook_read', 'midpoint_read', 'trade_history_read'],
      },
      {
        sourceName: 'polymarket_data_api',
        tosUrl: 'https://polymarket.com/tos',
        status: 'approved',
        scrapingPermitted: 1,
        allowedUsage: ['leaderboard_read', 'public_profile_read', 'public_positions_read'],
      },
      {
        sourceName: 'kalshi_trade_api',
        tosUrl: 'https://kalshi.com/terms',
        status: 'approved',
        authType: 'rsa_pss',
        authRequired: 1,
        scrapingPermitted: 1,
        allowedUsage: ['market_data_read', 'orderbook_read', 'trade_execution'],
      },
      {
        sourceName: 'noaa_cdo',
        tosUrl: 'https://www.weather.gov/disclaimer',
        status: 'approved',
        authType: 'api_key',
        authRequired: 1,
        scrapingPermitted: 1,
        allowedUsage: ['weather_history_read'],
      },
      {
        sourceName: 'noaa_weather_api',
        tosUrl: 'https://www.weather.gov/disclaimer',
        status: 'approved',
        scrapingPermitted: 1,
        allowedUsage: ['forecast_read', 'weather_observations_read'],
      },
      {
        sourceName: 'fred_api',
        tosUrl: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html',
        status: 'approved',
        authType: 'api_key',
        authRequired: 1,
        scrapingPermitted: 1,
        allowedUsage: ['economic_series_read'],
      },
      {
        sourceName: 'polymarket_analytics',
        tosUrl: 'https://polymarketanalytics.com',
        status: 'blocked',
        blockReason: 'ToS does not explicitly permit automated access',
        scrapingPermitted: 0,
        allowedUsage: [],
        prohibitedUsage: ['automated_access'],
      },
    ];

    for (const source of defaults) {
      await this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO compliance_matrix (
          id, source_name,
          allowed_usage, prohibited_usage,
          rate_limits, retry_policy,
          retention_rules, pii_handling,
          attribution_required, attribution_text,
          tos_url, tos_version, tos_snapshot_evidence_hash, tos_snapshot_r2_key,
          tos_retrieved_at, tos_next_review_date,
          scraping_permitted, scraping_notes, robots_txt_compliant,
          authentication_required, authentication_type,
          status, block_reason,
          reviewed_by, reviewed_at, review_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          deterministicId('compliance-source', source.sourceName),
          source.sourceName,
          JSON.stringify(source.allowedUsage ?? ['market_data_read']),
          JSON.stringify(source.prohibitedUsage ?? []),
          JSON.stringify({ requests_per_second: null, daily_cap: null }),
          JSON.stringify({ max_retries: 3, backoff_base_ms: 1000 }),
          JSON.stringify({ max_cache_duration_hours: 24, raw_storage_allowed: true }),
          JSON.stringify({}),
          0,
          null,
          source.tosUrl,
          'bootstrap-v1',
          null,
          null,
          now,
          nextQuarter,
          source.scrapingPermitted ?? 1,
          source.blockReason ?? null,
          1,
          source.authRequired ?? 0,
          source.authType ?? 'none',
          source.status,
          source.blockReason ?? null,
          'system-bootstrap',
          now,
          'Auto-seeded default compliance sources'
        )
        .run();
    }

    this.complianceSeeded = true;
  }
}
