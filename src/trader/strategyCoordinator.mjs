import { buildStrategyRegime, buildUnavailableRegime } from "./strategyRegime.mjs";

export class StrategyCoordinator {
  constructor({ runtime, config = {}, shadowBook, auditLogger } = {}) {
    this.runtime = runtime;
    this.config = config;
    this.shadowBook = shadowBook;
    this.auditLogger = auditLogger;
    this.lastRegimeGate = null;
  }

  isRegimeGateEnabled() {
    return this.config.regimeGateEnabled !== false;
  }

  async audit(type, payload = {}) {
    await this.auditLogger?.append?.(type, payload);
  }

  async getRegime({ symbol = "BTCUSDT", candidate = null, forceRefresh = false } = {}) {
    if (!this.isRegimeGateEnabled()) {
      const disabled = {
        symbol,
        state: "未开启",
        riskScore: 0,
        trendScore: 0,
        allowNewTrade: true,
        candidateAction: candidate?.action || candidate?.intent || null,
        reasons: ["市场状态闸门未开启"],
        updatedAt: new Date().toISOString(),
      };
      this.lastRegimeGate = disabled;
      return disabled;
    }

    try {
      const analysis = await this.runtime.getMarketAnalysis({ symbol, forceRefresh });
      const regime = buildStrategyRegime({
        analysis,
        candidate,
        options: {
          conflictOverrideConfidence: this.config.regimeConflictOverrideConfidence,
          conflictMarginScale: this.config.regimeConflictMarginScale,
        },
      });
      this.lastRegimeGate = regime;
      return regime;
    } catch (error) {
      const unavailable = buildUnavailableRegime({ symbol, error });
      this.lastRegimeGate = unavailable;
      return unavailable;
    }
  }

  async evaluateCandidate(candidate) {
    const regimeSymbol = this.config.regimeSymbol || "BTCUSDT";
    const regime = await this.getRegime({
      symbol: regimeSymbol,
      candidate,
    });

    await this.audit(regime.allowNewTrade ? "regime_allow" : "regime_block", {
      symbol: candidate?.symbol,
      regimeSymbol,
      action: candidate?.action || candidate?.intent,
      state: regime.state,
      riskScore: regime.riskScore,
      reason: regime.reasons?.[0],
    });

    return regime;
  }

  async recordScan(scan) {
    await this.audit("auto_scan", {
      scannedAt: scan?.scannedAt,
      candidateCount: scan?.candidates?.length ?? 0,
      llmStatus: scan?.llmStatus,
    });

    if (!this.shadowBook?.enabled) {
      return { recorded: 0 };
    }

    const result = await this.shadowBook.recordScan(scan, {
      regime: this.lastRegimeGate,
    });
    await this.audit("shadow_scan_recorded", result);
    return result;
  }

  async refreshShadow() {
    if (!this.shadowBook?.enabled) {
      return { updated: 0 };
    }

    const result = await this.shadowBook.updateOpenTrades(this.runtime.createClient());
    if (result.updated) {
      await this.audit("shadow_updated", result);
    }
    return result;
  }

  async getDiagnostics() {
    await this.refreshShadow();
    const [shadowStats, auditSummary] = await Promise.all([
      this.shadowBook?.getStats?.() ?? null,
      this.auditLogger?.getSummary?.() ?? null,
    ]);

    return {
      regimeGate: this.lastRegimeGate,
      shadowStats,
      auditSummary,
      updatedAt: new Date().toISOString(),
    };
  }
}
