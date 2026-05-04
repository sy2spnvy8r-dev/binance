import fs from "node:fs/promises";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createInitialState() {
  return {
    version: 1,
    createdAt: nowIso(),
    trades: [],
  };
}

function candidateKey(candidate) {
  return [
    candidate.symbol,
    candidate.action || candidate.intent,
    candidate.entryPrice,
    candidate.stopLoss,
    candidate.takeProfit,
  ].join(":");
}

function getTickerPrice(ticker) {
  const item = Array.isArray(ticker) ? ticker[0] : ticker;
  return toNumber(item?.lastPrice ?? item?.weightedAvgPrice ?? item?.markPrice, null);
}

function directionMultiplier(action) {
  return action === "open_short" ? -1 : 1;
}

function calculateR({ action, entryPrice, stopLoss, currentPrice }) {
  const entry = toNumber(entryPrice, null);
  const stop = toNumber(stopLoss, null);
  const current = toNumber(currentPrice, null);
  const risk = Math.abs(entry - stop);
  if (!entry || !stop || !current || risk <= 0) {
    return 0;
  }

  return ((current - entry) * directionMultiplier(action)) / risk;
}

function targetR(trade) {
  const entry = toNumber(trade.entryPrice, null);
  const stop = toNumber(trade.stopLoss, null);
  const take = toNumber(trade.takeProfit, null);
  const risk = Math.abs(entry - stop);
  if (!entry || !stop || !take || risk <= 0) {
    return 1;
  }

  return Math.abs(take - entry) / risk;
}

function directionLabel(action) {
  return action === "open_short" ? "做空" : "做多";
}

function confidenceBand(value) {
  const confidence = toNumber(value, null);
  if (confidence === null) {
    return "未知";
  }
  if (confidence >= 90) return "90+";
  if (confidence >= 80) return "80-89";
  if (confidence >= 70) return "70-79";
  return "<70";
}

function summarizeTrades(trades, feeRate, defaultNotionalUsdt) {
  const closed = trades.filter((trade) => trade.status === "closed");
  const wins = closed.filter((trade) => trade.outcome === "win");
  const losses = closed.filter((trade) => trade.outcome === "loss");
  const grossR = closed.reduce((sum, trade) => sum + toNumber(trade.finalR), 0);
  const feeEstimateUsdt = closed.reduce(
    (sum, trade) => sum + toNumber(trade.notionalUsdt, defaultNotionalUsdt) * feeRate * 2,
    0,
  );
  const maxDrawdownR = trades.reduce((min, trade) => Math.min(min, toNumber(trade.minR)), 0);

  return {
    total: trades.length,
    open: trades.filter((trade) => trade.status === "open").length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
    grossR: Number(grossR.toFixed(4)),
    feeEstimateUsdt: Number(feeEstimateUsdt.toFixed(4)),
    maxDrawdownR: Number(maxDrawdownR.toFixed(4)),
  };
}

function groupBy(trades, keyGetter, feeRate, defaultNotionalUsdt) {
  const groups = {};
  for (const trade of trades) {
    const key = keyGetter(trade) || "未知";
    groups[key] ??= [];
    groups[key].push(trade);
  }

  return Object.fromEntries(
    Object.entries(groups)
      .map(([key, items]) => [key, summarizeTrades(items, feeRate, defaultNotionalUsdt)])
      .sort((left, right) => right[1].total - left[1].total),
  );
}

export class StrategyShadowBook {
  constructor({
    filePath,
    enabled = true,
    maxTrades = 1000,
    defaultNotionalUsdt = 100,
    feeRate = 0.0005,
  } = {}) {
    this.filePath = filePath;
    this.enabled = enabled;
    this.maxTrades = maxTrades;
    this.defaultNotionalUsdt = defaultNotionalUsdt;
    this.feeRate = feeRate;
    this.state = null;
  }

  async loadState() {
    if (this.state) {
      return this.state;
    }

    if (!this.filePath) {
      this.state = createInitialState();
      return this.state;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = {
        ...createInitialState(),
        ...JSON.parse(await fs.readFile(this.filePath, "utf8")),
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.state = createInitialState();
      await this.saveState();
    }

    return this.state;
  }

  async saveState() {
    if (!this.filePath) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const trades = (this.state?.trades ?? []).slice(-this.maxTrades);
    this.state.trades = trades;
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  async recordScan(scan, context = {}) {
    if (!this.enabled) {
      return { recorded: 0 };
    }

    const state = await this.loadState();
    const openKeys = new Set(
      (state.trades ?? [])
        .filter((trade) => trade.status === "open")
        .map((trade) => trade.key),
    );
    let recorded = 0;

    for (const candidate of (scan?.candidates ?? []).slice(0, 20)) {
      const action = candidate.action || candidate.intent;
      if (!["open_long", "open_short"].includes(action)) {
        continue;
      }
      if (!candidate.entryPrice || !candidate.stopLoss || !candidate.takeProfit) {
        continue;
      }

      const key = candidateKey({ ...candidate, action });
      if (openKeys.has(key)) {
        continue;
      }

      openKeys.add(key);
      recorded += 1;
      state.trades.push({
        id: `${Date.now()}-${recorded}-${candidate.symbol}`,
        key,
        status: "open",
        symbol: candidate.symbol,
        action,
        direction: directionLabel(action),
        regimeState: context?.regime?.state ?? scan?.regimeState ?? "未知",
        confidenceBand: confidenceBand(candidate.confidence ?? candidate.localScore),
        confidence: candidate.confidence ?? candidate.localScore ?? null,
        entryPrice: String(candidate.entryPrice),
        stopLoss: String(candidate.stopLoss),
        takeProfit: String(candidate.takeProfit),
        leverage: candidate.leverage ?? null,
        reason: String(candidate.reason || candidate.localReason || "").slice(0, 500),
        source: candidate.source ?? "auto",
        openedAt: scan?.scannedAt ?? nowIso(),
        maxR: 0,
        minR: 0,
        lastR: 0,
        notionalUsdt: this.defaultNotionalUsdt,
      });
    }

    if (recorded) {
      await this.saveState();
    }

    return { recorded };
  }

  async updateOpenTrades(client) {
    if (!this.enabled) {
      return { updated: 0 };
    }

    const state = await this.loadState();
    let updated = 0;
    for (const trade of state.trades ?? []) {
      if (trade.status !== "open") {
        continue;
      }

      try {
        const price = getTickerPrice(await client.get24hTickers({ symbol: trade.symbol }));
        if (!price) {
          continue;
        }
        const currentR = calculateR({ ...trade, currentPrice: price });
        trade.lastPrice = String(price);
        trade.lastR = Number(currentR.toFixed(4));
        trade.maxR = Math.max(toNumber(trade.maxR), trade.lastR);
        trade.minR = Math.min(toNumber(trade.minR), trade.lastR);
        trade.updatedAt = nowIso();

        if (currentR <= -1) {
          trade.status = "closed";
          trade.outcome = "loss";
          trade.closedAt = nowIso();
          trade.exitReason = "stopLoss";
          trade.finalR = -1;
        } else if (currentR >= targetR(trade)) {
          trade.status = "closed";
          trade.outcome = "win";
          trade.closedAt = nowIso();
          trade.exitReason = "takeProfit";
          trade.finalR = Number(targetR(trade).toFixed(4));
        }
        updated += 1;
      } catch (error) {
        trade.lastError = error?.message || String(error);
      }
    }

    if (updated) {
      await this.saveState();
    }

    return { updated };
  }

  async getStats() {
    const state = await this.loadState();
    const trades = state.trades ?? [];
    const summary = summarizeTrades(trades, this.feeRate, this.defaultNotionalUsdt);

    return {
      enabled: this.enabled,
      ...summary,
      feeRate: this.feeRate,
      groups: {
        byDirection: groupBy(trades, (trade) => trade.direction || directionLabel(trade.action), this.feeRate, this.defaultNotionalUsdt),
        byRegime: groupBy(trades, (trade) => trade.regimeState, this.feeRate, this.defaultNotionalUsdt),
        bySource: groupBy(trades, (trade) => trade.source, this.feeRate, this.defaultNotionalUsdt),
        byConfidence: groupBy(trades, (trade) => trade.confidenceBand || confidenceBand(trade.confidence), this.feeRate, this.defaultNotionalUsdt),
      },
      recent: trades.slice(-20).reverse(),
      updatedAt: nowIso(),
    };
  }
}
