import fs from "node:fs/promises";
import path from "node:path";
import {
  absDecimalString,
  compareDecimalStrings,
  divideDecimalStrings,
  multiplyDecimalStrings,
  normalizeDecimalString,
  subtractDecimalStrings,
} from "./decimal.mjs";
import { buildAutoOrderInput, floorToStep } from "./autoRisk.mjs";
import { describeFuturesEnvironment } from "./runtime.mjs";
import {
  buildOrderInstruction,
  buildSymbolIndex,
  getActivePositions,
  getSymbolInfo,
  getSymbolRules,
  validateLimitPrice,
} from "./futuresTradeHelpers.mjs";
import { createAutoTradeFeishuMessage } from "./autoTradeFeishuMessage.mjs";

const PROCESSED_INCOME_LIMIT = 2000;
const HISTORY_LIMIT = 200;
const ACTIVE_TRADE_STATUSES = new Set(["pending", "open"]);
const INCOME_TYPES = new Set(["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"]);
const SPLIT_TAKE_PROFIT_LEGS = [
  { id: "tp1", label: "TP1", kind: "take_profit", percent: 35, riskMultiple: 1 },
  { id: "tp2", label: "TP2", kind: "take_profit", percent: 35, riskMultiple: 2 },
  { id: "runner", label: "Runner", kind: "trailing_stop", percent: 30, riskMultiple: 2 },
];
const FILLED_ALGO_STATUSES = new Set(["TRIGGERED", "FILLED", "FINISHED"]);
const DEAD_ALGO_STATUSES = new Set(["CANCELED", "EXPIRED", "REJECTED"]);
const FINAL_ENTRY_ORDER_STATUSES = new Set(["FILLED", "CANCELED", "EXPIRED", "REJECTED"]);

function noop() {}

function nowIso() {
  return new Date().toISOString();
}

function formatUsdt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "0";
  }

  return normalizeDecimalString(parsed.toFixed(8));
}

function readFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getUsdtAsset(accountInfo) {
  return (accountInfo?.assets ?? []).find((asset) => asset?.asset === "USDT");
}

function readAccountMetric(accountInfo, keys, assetKeys = []) {
  for (const key of keys) {
    const value = readFiniteNumber(accountInfo?.[key]);
    if (value !== null) {
      return value;
    }
  }

  const usdtAsset = getUsdtAsset(accountInfo);
  for (const key of assetKeys) {
    const value = readFiniteNumber(usdtAsset?.[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function buildAccountBudget(snapshot) {
  const accountInfo = snapshot?.accountInfo;
  if (!accountInfo) {
    return null;
  }

  const wallet = readAccountMetric(accountInfo, ["totalWalletBalance"], ["walletBalance"]);
  const unrealized = readAccountMetric(
    accountInfo,
    ["totalUnrealizedProfit"],
    ["unrealizedProfit", "crossUnPnl"],
  );
  const equity = readAccountMetric(accountInfo, ["totalMarginBalance"], ["marginBalance"]);
  const available = readAccountMetric(accountInfo, ["availableBalance"], ["availableBalance"]);

  if (wallet === null && available === null && equity === null) {
    return null;
  }

  const normalizedWallet = wallet ?? Math.max(0, (equity ?? 0) - (unrealized ?? 0));
  const normalizedUnrealized = unrealized ?? 0;
  const normalizedEquity = equity ?? normalizedWallet + normalizedUnrealized;
  const normalizedAvailable = available ?? Math.max(0, normalizedEquity);

  return {
    source: "exchange_account",
    updatedAt: nowIso(),
    capitalUsdt: formatUsdt(normalizedWallet),
    availableCapitalUsdt: formatUsdt(normalizedAvailable),
    unrealizedProfitUsdt: formatUsdt(normalizedUnrealized),
    equityUsdt: formatUsdt(normalizedEquity),
  };
}

function createInitialState(initialCapitalUsdt) {
  const now = Date.now();
  return {
    version: 1,
    createdAt: new Date(now).toISOString(),
    initialCapitalUsdt: normalizeDecimalString(initialCapitalUsdt),
    capitalUsdt: normalizeDecimalString(initialCapitalUsdt),
    lastIncomeSyncTime: now,
    lastEntryScanAt: 0,
    processedIncomeKeys: [],
    openTrades: [],
    history: [],
  };
}

function incomeKey(item) {
  return [
    item.time ?? "",
    item.symbol ?? "",
    item.incomeType ?? "",
    item.asset ?? "",
    item.income ?? "",
    item.tranId ?? "",
  ].join(":");
}

function activeTradeMargin(trades = []) {
  return trades
    .filter((trade) => ACTIVE_TRADE_STATUSES.has(trade.status))
    .reduce((sum, trade) => sum + Number(trade.marginUsdt ?? 0), 0);
}

function activeTradeUnrealizedPnl(trades = []) {
  return trades
    .filter((trade) => ACTIVE_TRADE_STATUSES.has(trade.status))
    .reduce((sum, trade) => sum + Number(trade.unrealizedProfitUsdt ?? 0), 0);
}

function calculateRiskUsdt({ entryPrice, stopLoss, quantity }) {
  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  const qty = Number(quantity);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(qty) || qty <= 0) {
    return 0;
  }

  return Math.abs(entry - stop) * qty;
}

function activeTradeRiskUsdt(trades = []) {
  return trades
    .filter((trade) => ACTIVE_TRADE_STATUSES.has(trade.status))
    .reduce(
      (sum, trade) =>
        sum +
        Number(
          trade.riskUsdt ??
            calculateRiskUsdt({
              entryPrice: trade.entryPrice,
              stopLoss: trade.stopLoss,
              quantity: trade.protectionQuantity || trade.quantity,
            }),
        ),
      0,
    );
}

function getMaxOpenPositions(config) {
  const parsed = Number(config?.maxOpenPositions ?? 1);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Infinity;
  }

  return Math.floor(parsed);
}

function getMaxOrdersPerRun(config) {
  const parsed = Number(config?.maxOrdersPerRun ?? 3);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Infinity;
  }

  return Math.floor(parsed);
}

function getOrderMarginUsdt(config, availableCapitalUsdt) {
  const available = Number(availableCapitalUsdt);
  const cap = Number(config?.orderMarginUsdt ?? 20);
  if (!Number.isFinite(available) || available <= 0) {
    return "0";
  }

  if (!Number.isFinite(cap) || cap <= 0) {
    return formatUsdt(available);
  }

  return formatUsdt(Math.min(available, cap));
}

function getMinOrderMarginUsdt(config) {
  const parsed = Number(config?.minOrderMarginUsdt ?? 10);
  return Number.isFinite(parsed) && parsed > 0 ? formatUsdt(parsed) : "0";
}

function getCandidateMarginScale(candidate) {
  const parsed = Number(candidate?.regimeGate?.marginScale ?? 1);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : 1;
}

function scaleOrderMarginUsdt(orderMarginUsdt, minOrderMarginUsdt, scale = 1) {
  if (scale >= 1) {
    return orderMarginUsdt;
  }

  const scaled = Number(orderMarginUsdt) * scale;
  const minimum = Number(minOrderMarginUsdt);
  if (!Number.isFinite(scaled) || scaled <= 0) {
    return orderMarginUsdt;
  }

  return formatUsdt(Math.max(Number.isFinite(minimum) ? minimum : 0, scaled));
}

function getMaxTotalRiskUsdt(config) {
  const parsed = Number(config?.maxTotalRiskUsdt ?? 30);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

function getProtectionRetryMs(config) {
  const parsed = Number(config?.protectionRetryMs ?? 15000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

function getEntryScanIntervalMs(config) {
  const parsed = Number(config?.intervalMs ?? 900000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900000;
}

function getEntryOrderTtlMs(config) {
  const parsed = Number(config?.entryOrderTtlMs ?? 600000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

function getEntryScanCooldownMs(state, config, now = Date.now()) {
  const last = Number(state?.lastEntryScanAt ?? 0);
  if (!Number.isFinite(last) || last <= 0) {
    return 0;
  }

  return Math.max(0, getEntryScanIntervalMs(config) - (now - last));
}

function isSplitTakeProfitEnabled(config) {
  return config?.splitTakeProfitEnabled !== false;
}

function getTrailingCallbackRate(config) {
  const parsed = Number(config?.trailingCallbackRate ?? 0.8);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 10) {
    return "0.8";
  }

  return normalizeDecimalString(parsed.toFixed(2));
}

function getConfidence(candidate) {
  const value = Number(candidate?.confidence ?? candidate?.localScore ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function getDecisionIntent(candidate) {
  return candidate?.action || candidate?.intent;
}

function closeSideForIntent(intent) {
  return intent === "open_long" ? "SELL" : "BUY";
}

function closePositionSideForIntent(intent, dualSidePosition) {
  if (!dualSidePosition) {
    return "BOTH";
  }

  return intent === "open_long" ? "LONG" : "SHORT";
}

function isMatchingPosition(position, trade, dualSidePosition) {
  if (position.symbol !== trade.symbol) {
    return false;
  }

  const amount = normalizeDecimalString(position.positionAmt ?? "0");
  if (trade.intent === "open_long") {
    return dualSidePosition
      ? position.positionSide === "LONG" && compareDecimalStrings(amount, "0") > 0
      : compareDecimalStrings(amount, "0") > 0;
  }

  return dualSidePosition
    ? position.positionSide === "SHORT" && compareDecimalStrings(amount, "0") < 0
    : compareDecimalStrings(amount, "0") < 0;
}

function findMatchingPosition(positions, trade, dualSidePosition) {
  return positions.find((position) => isMatchingPosition(position, trade, dualSidePosition));
}

function getPositionUnrealizedProfit(position) {
  return position?.unrealizedProfit ?? position?.unRealizedProfit ?? "0";
}

function getPositionQuantity(position) {
  return absDecimalString(position?.positionAmt ?? "0");
}

function getExecutedQuantity(order) {
  return normalizeDecimalString(order?.executedQty ?? order?.cumQty ?? "0");
}

function hasEntryFill(order) {
  return compareDecimalStrings(getExecutedQuantity(order), "0") > 0;
}

function normalizeTriggerPrice(value, rules) {
  return validateLimitPrice(floorToStep(value, rules.tickSize), rules);
}

function triggerAtRiskMultiple({ intent, entryPrice, stopLoss, multiple, rules }) {
  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(risk) || risk <= 0) {
    throw new Error("invalid risk distance");
  }

  const target = intent === "open_long" ? entry + risk * multiple : entry - risk * multiple;
  return normalizeTriggerPrice(String(target), rules);
}

function quantityByPercent(quantity, percent, rules) {
  const raw = multiplyDecimalStrings(quantity, divideDecimalStrings(String(percent), "100", 18));
  return floorToStep(raw, rules.stepSize);
}

function validateLegQuantity(quantity, triggerPrice, rules) {
  if (compareDecimalStrings(quantity, rules.minQty) < 0) {
    throw new Error("leg quantity below minQty");
  }

  const notional = multiplyDecimalStrings(triggerPrice, quantity);
  if (
    rules.minNotional &&
    compareDecimalStrings(rules.minNotional, "0") > 0 &&
    compareDecimalStrings(notional, rules.minNotional) < 0
  ) {
    throw new Error("leg notional below minNotional");
  }

  return quantity;
}

function buildSingleTakeProfitPlan({ takeProfit }) {
  return {
    version: 1,
    mode: "single",
    createdAt: nowIso(),
    legs: [
      {
        id: "tp",
        label: "TP",
        kind: "take_profit",
        percent: 100,
        triggerPrice: takeProfit,
        closePosition: true,
        status: "planned",
      },
    ],
  };
}

export function buildSplitTakeProfitPlan({
  intent,
  entryPrice,
  stopLoss,
  takeProfit,
  quantity,
  rules,
  trailingCallbackRate = "0.8",
  enabled = true,
}) {
  if (!enabled) {
    return buildSingleTakeProfitPlan({ takeProfit });
  }

  try {
    const tp1 = triggerAtRiskMultiple({ intent, entryPrice, stopLoss, multiple: 1, rules });
    const tp2 = triggerAtRiskMultiple({ intent, entryPrice, stopLoss, multiple: 2, rules });
    const tp1Quantity = validateLegQuantity(quantityByPercent(quantity, 35, rules), tp1, rules);
    const tp2Quantity = validateLegQuantity(quantityByPercent(quantity, 35, rules), tp2, rules);
    const remainingQuantity = floorToStep(
      subtractDecimalStrings(subtractDecimalStrings(quantity, tp1Quantity), tp2Quantity),
      rules.stepSize,
    );
    const runnerQuantity = validateLegQuantity(remainingQuantity, tp2, rules);

    return {
      version: 1,
      mode: "split",
      createdAt: nowIso(),
      riskDistance: normalizeDecimalString(Math.abs(Number(entryPrice) - Number(stopLoss)).toFixed(12)),
      stopMove: {
        afterTp1: entryPrice,
        afterTp2: tp1,
      },
      legs: [
        {
          ...SPLIT_TAKE_PROFIT_LEGS[0],
          quantity: tp1Quantity,
          triggerPrice: tp1,
          status: "planned",
        },
        {
          ...SPLIT_TAKE_PROFIT_LEGS[1],
          quantity: tp2Quantity,
          triggerPrice: tp2,
          status: "planned",
        },
        {
          ...SPLIT_TAKE_PROFIT_LEGS[2],
          quantity: runnerQuantity,
          activatePrice: tp2,
          callbackRate: trailingCallbackRate,
          status: "planned",
        },
      ],
    };
  } catch (error) {
    return {
      ...buildSingleTakeProfitPlan({ takeProfit }),
      fallbackReason: error?.message || String(error),
    };
  }
}

function assertProtectivePrices({ intent, entryPrice, stopLoss, takeProfit }) {
  if (!stopLoss || !takeProfit) {
    throw new Error("候选缺少止损或止盈。");
  }

  if (intent === "open_long") {
    if (
      compareDecimalStrings(stopLoss, entryPrice) >= 0 ||
      compareDecimalStrings(takeProfit, entryPrice) <= 0
    ) {
      throw new Error("做多候选的止损/止盈方向不正确。");
    }
    return;
  }

  if (
    compareDecimalStrings(stopLoss, entryPrice) <= 0 ||
    compareDecimalStrings(takeProfit, entryPrice) >= 0
  ) {
    throw new Error("做空候选的止损/止盈方向不正确。");
  }
}

function serializeOrderId(order) {
  return order?.algoId ?? order?.orderId ?? order?.clientAlgoId ?? order?.clientOrderId ?? order?.dryRun?.url ?? null;
}

function getAlgoOrderType(order) {
  return order?.orderType ?? order?.type;
}

function isStopMarketAlgoOrder(order) {
  return getAlgoOrderType(order) === "STOP_MARKET";
}

function isTakeProfitMarketAlgoOrder(order) {
  return getAlgoOrderType(order) === "TAKE_PROFIT_MARKET";
}

function isTrailingStopMarketAlgoOrder(order) {
  return getAlgoOrderType(order) === "TRAILING_STOP_MARKET";
}

function normalizeOrderId(value) {
  return value === undefined || value === null ? "" : String(value);
}

function getTakeProfitLegs(trade) {
  return trade?.takeProfitPlan?.legs ?? [];
}

function isSplitTakeProfitTrade(trade) {
  return Array.isArray(trade?.takeProfitPlan?.legs);
}

function isLegDone(leg) {
  return leg.status === "filled" || leg.status === "canceled";
}

function hasFilledTakeProfitLeg(trade) {
  return getTakeProfitLegs(trade).some((leg) => leg.status === "filled");
}

function hasOpenTakeProfitOrderIds(trade) {
  return Boolean(trade.takeProfitOrderId) || getTakeProfitLegs(trade).some((leg) => leg.orderId && !isLegDone(leg));
}

function shouldTrackEntryOrder(trade) {
  return (
    trade?.entryOrderId &&
    (trade.status === "pending" || trade.entryOrderStatus === "PARTIALLY_FILLED") &&
    !FINAL_ENTRY_ORDER_STATUSES.has(trade.entryOrderStatus)
  );
}

function isEntryOrderExpired(trade, config, now = Date.now()) {
  const ttl = getEntryOrderTtlMs(config);
  const openedAt = Date.parse(trade?.openedAt ?? "");
  return (
    Number.isFinite(ttl) &&
    Number.isFinite(openedAt) &&
    shouldTrackEntryOrder(trade) &&
    now - openedAt >= ttl
  );
}

function isTradeProtectionComplete(trade) {
  if (!trade?.stopOrderId) {
    return false;
  }

  if (!isSplitTakeProfitTrade(trade)) {
    return Boolean(trade.takeProfitOrderId);
  }

  return getTakeProfitLegs(trade).every((leg) => isLegDone(leg) || leg.orderId);
}

function legOrderPredicate(leg) {
  if (leg.kind === "trailing_stop") {
    return isTrailingStopMarketAlgoOrder;
  }

  return isTakeProfitMarketAlgoOrder;
}

function normalizeOrderQuantity(value) {
  try {
    return normalizeDecimalString(value ?? "0");
  } catch {
    return "0";
  }
}

function orderMatchesLeg(order, leg, closeSide, positionSide) {
  if (!legOrderPredicate(leg)(order)) {
    return false;
  }

  if (order.side !== closeSide || (order.positionSide && order.positionSide !== positionSide)) {
    return false;
  }

  if (leg.quantity && compareDecimalStrings(normalizeOrderQuantity(order.quantity), leg.quantity) !== 0) {
    return false;
  }

  if (leg.kind === "trailing_stop") {
    const activatePrice = order.activatePrice || order.triggerPrice;
    return !leg.activatePrice || compareDecimalStrings(normalizeOrderQuantity(activatePrice), leg.activatePrice) === 0;
  }

  return !leg.triggerPrice || compareDecimalStrings(normalizeOrderQuantity(order.triggerPrice), leg.triggerPrice) === 0;
}

export class AutoTradeService {
  constructor({
    runtime,
    config,
    logger = console,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    strategy = null,
    notifier = null,
    accountId = "default",
    accountLabel = "default",
  }) {
    this.runtime = runtime;
    this.config = config ?? {};
    this.logger = logger;
    this.strategy = strategy;
    this.notifier = notifier;
    this.accountId = accountId;
    this.accountLabel = accountLabel;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.state = null;
    this.lastResult = null;
  }

  isEnabled() {
    return Boolean(this.config.enabled && this.runtime);
  }

  async notifyPlacements(placements) {
    if (!this.notifier || !placements?.length) {
      return false;
    }

    try {
      const message = createAutoTradeFeishuMessage({
        accountLabel: this.accountLabel,
        placements,
        openTrades: this.state?.openTrades ?? [],
        budget: this.getAvailableCapital(),
      });
      await this.notifier.send(message);
      await this.strategy?.audit?.("auto_trade_feishu_sent", {
        accountId: this.accountId,
        symbols: placements.map((placement) => placement.trade?.symbol),
      });
      return true;
    } catch (error) {
      await this.strategy?.audit?.("auto_trade_feishu_failed", {
        accountId: this.accountId,
        error: error?.message || String(error),
      });
      this.lastNotifyError = error?.message || String(error);
      return false;
    }
  }

  isTestnetRuntime() {
    const environment = describeFuturesEnvironment(this.runtime?.config?.baseUrl).id;
    return environment === "testnet" || environment === "legacy_testnet";
  }

  assertSafety() {
    if (!this.isEnabled()) {
      throw new Error("测试网自动交易未开启。");
    }

    if (this.config.testnetOnly !== false && !this.isTestnetRuntime()) {
      throw new Error("安全锁：自动交易只允许在测试网运行。");
    }

    if (!this.runtime.config.apiKey || !this.runtime.config.apiSecret) {
      throw new Error("缺少 Binance Futures API Key / Secret。");
    }
  }

  start({ immediate = true } = {}) {
    if (!this.isEnabled()) {
      this.logger?.log?.("Auto testnet trade disabled.");
      return false;
    }

    if (this.config.testnetOnly !== false && !this.isTestnetRuntime()) {
      this.logger?.error?.("Auto testnet trade safety lock: current base URL is not testnet.");
      return false;
    }

    this.stopped = false;
    this.schedule(immediate ? 0 : this.config.intervalMs);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  schedule(delayMs) {
    if (this.stopped) {
      return;
    }

    const fallbackDelay = Number(this.config.intervalMs) || 900000;
    const requestedDelay = delayMs === undefined || delayMs === null ? fallbackDelay : Number(delayMs);
    const delay = Math.max(5000, Number.isFinite(requestedDelay) ? requestedDelay : fallbackDelay);
    this.timer = this.setTimeoutImpl(() => {
      void this.runOnce();
    }, delay);
    this.timer?.unref?.();
  }

  async loadState() {
    if (this.state) {
      return this.state;
    }

    const filePath = this.config.stateFile;
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    try {
      const raw = await fs.readFile(filePath, "utf8");
      this.state = {
        ...createInitialState(this.config.initialCapitalUsdt),
        ...JSON.parse(raw),
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.state = createInitialState(this.config.initialCapitalUsdt);
      await this.saveState();
    }

    return this.state;
  }

  async saveState() {
    await fs.mkdir(path.dirname(this.config.stateFile), { recursive: true });
    await fs.writeFile(this.config.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  async syncIncome() {
    const state = await this.loadState();
    const client = this.runtime.createClient();
    const startTime = Math.max(0, Number(state.lastIncomeSyncTime ?? Date.now()) - 5000);
    const incomes = await client.getIncomeHistory({ startTime, limit: 1000 });
    let delta = 0;
    let latestTime = Number(state.lastIncomeSyncTime ?? Date.now());
    const processed = new Set(state.processedIncomeKeys ?? []);

    for (const item of incomes ?? []) {
      if (!INCOME_TYPES.has(item?.incomeType)) {
        continue;
      }

      const key = incomeKey(item);
      if (processed.has(key)) {
        continue;
      }

      processed.add(key);
      delta += Number(item.income ?? 0);
      latestTime = Math.max(latestTime, Number(item.time ?? latestTime));
    }

    if (delta !== 0) {
      state.capitalUsdt = formatUsdt(Number(state.capitalUsdt) + delta);
      state.history.push({
        type: "income_sync",
        at: nowIso(),
        deltaUsdt: formatUsdt(delta),
        capitalUsdt: state.capitalUsdt,
      });
    }

    state.lastIncomeSyncTime = Math.max(latestTime, Date.now());
    state.processedIncomeKeys = Array.from(processed).slice(-PROCESSED_INCOME_LIMIT);
    state.history = (state.history ?? []).slice(-HISTORY_LIMIT);
    await this.saveState();
  }

  updateAccountBudgetFromSnapshot(snapshot) {
    const budget = buildAccountBudget(snapshot);
    if (!budget || !this.state) {
      return false;
    }

    this.state.accountBudget = budget;
    this.state.accountBudgetError = null;
    return true;
  }

  async syncAccountBudget() {
    await this.loadState();
    const snapshot = await this.runtime.fetchTradingSnapshot();
    if (this.updateAccountBudgetFromSnapshot(snapshot)) {
      await this.saveState();
    }

    return this.state?.accountBudget ?? null;
  }

  async syncTradeStatuses() {
    const state = await this.loadState();
    const activeTrades = (state.openTrades ?? []).filter((trade) =>
      ACTIVE_TRADE_STATUSES.has(trade.status),
    );
    const snapshot = await this.runtime.fetchTradingSnapshot();
    const positions = getActivePositions(snapshot.accountInfo);
    let changed = this.updateAccountBudgetFromSnapshot(snapshot);

    if (!activeTrades.length) {
      if (state.unrealizedProfitUsdt !== "0") {
        state.unrealizedProfitUsdt = "0";
        changed = true;
      }

      if (changed) {
        await this.saveState();
      }
      return;
    }

    const client = this.runtime.createClient();

    for (const trade of activeTrades) {
      let justSyncedPending = false;
      if (trade.status === "pending" && trade.entryOrderId) {
        try {
          const order = await client.getOrder({ symbol: trade.symbol, orderId: trade.entryOrderId });
          trade.entryOrderStatus = order.status;
          const matchingPosition = findMatchingPosition(
            positions,
            trade,
            snapshot.dualSidePosition,
          );
          if (order.status === "FILLED") {
            trade.status = "open";
            trade.filledAt = nowIso();
            trade.entryFullyFilledAt = trade.entryFullyFilledAt ?? nowIso();
            justSyncedPending = true;
            changed = true;
            try {
              if (await this.ensureProtectiveOrders(trade, snapshot)) {
                changed = true;
              }
            } catch (error) {
              trade.protectionError = error?.message || String(error);
              trade.needsProtection = true;
              changed = true;
            }
          } else if (order.status === "PARTIALLY_FILLED" || hasEntryFill(order)) {
            if (matchingPosition) {
              trade.status = "open";
              trade.partiallyFilledAt = trade.partiallyFilledAt ?? nowIso();
              changed = true;
            }
          } else if (isEntryOrderExpired(trade, this.config)) {
            await client.cancelOrder({ symbol: trade.symbol, orderId: trade.entryOrderId });
            trade.entryOrderStatus = "CANCELED";
            trade.entryOrderCanceledAt = nowIso();
            trade.entryCancelReason = "entry_ttl_expired";
            trade.status = matchingPosition ? "open" : "canceled";
            trade.closedAt = matchingPosition ? trade.closedAt : nowIso();
            trade.needsProtection = Boolean(matchingPosition);
            justSyncedPending = !matchingPosition;
            changed = true;
          } else if (["CANCELED", "EXPIRED", "REJECTED"].includes(order.status)) {
            trade.status = order.status.toLowerCase();
            trade.closedAt = nowIso();
            justSyncedPending = true;
            changed = true;
          }
        } catch (error) {
          trade.lastStatusError = error?.message || String(error);
          changed = true;
        }
      }

      if (justSyncedPending) {
        continue;
      }

      if (trade.status === "open") {
        if (shouldTrackEntryOrder(trade)) {
          try {
            const order = await client.getOrder({ symbol: trade.symbol, orderId: trade.entryOrderId });
            trade.entryOrderStatus = order.status;
            if (order.status === "FILLED") {
              trade.entryFullyFilledAt = trade.entryFullyFilledAt ?? nowIso();
            } else if (FINAL_ENTRY_ORDER_STATUSES.has(order.status)) {
              trade.entryClosedAt = trade.entryClosedAt ?? nowIso();
            } else if (isEntryOrderExpired(trade, this.config)) {
              await client.cancelOrder({ symbol: trade.symbol, orderId: trade.entryOrderId });
              trade.entryOrderStatus = "CANCELED";
              trade.entryOrderCanceledAt = nowIso();
              trade.entryCancelReason = "entry_ttl_expired";
              trade.entryClosedAt = trade.entryClosedAt ?? nowIso();
            }
            changed = true;
          } catch (error) {
            trade.lastStatusError = error?.message || String(error);
            changed = true;
          }
        }

        const matchingPosition = findMatchingPosition(
          positions,
          trade,
          snapshot.dualSidePosition,
        );
        if (!matchingPosition) {
          try {
            if (await this.cancelRemainingProtection(trade)) {
              changed = true;
            }
          } catch (error) {
            trade.cleanupError = error?.message || String(error);
            changed = true;
          }
          trade.status = "closed";
          trade.closedAt = nowIso();
          changed = true;
        } else {
          if (await this.syncTakeProfitPlan(trade, snapshot)) {
            changed = true;
          }
          try {
            if (await this.syncTakeProfitPlanQuantity(trade, matchingPosition)) {
              changed = true;
            }
          } catch (error) {
            trade.protectionError = error?.message || String(error);
            trade.needsProtection = true;
            changed = true;
          }
          const unrealizedProfitUsdt = formatUsdt(getPositionUnrealizedProfit(matchingPosition));
          const markPrice = matchingPosition.markPrice ?? trade.markPrice;
          if (
            trade.unrealizedProfitUsdt !== unrealizedProfitUsdt ||
            (markPrice && trade.markPrice !== markPrice)
          ) {
            trade.unrealizedProfitUsdt = unrealizedProfitUsdt;
            if (markPrice) {
              trade.markPrice = markPrice;
            }
            changed = true;
          }
          if (trade.needsProtection) {
            try {
              if (await this.ensureProtectiveOrders(trade, snapshot)) {
                changed = true;
              }
            } catch (error) {
              trade.protectionError = error?.message || String(error);
              changed = true;
            }
          }
        }
      }
    }

    const unrealizedProfitUsdt = formatUsdt(activeTradeUnrealizedPnl(state.openTrades));
    if (state.unrealizedProfitUsdt !== unrealizedProfitUsdt) {
      state.unrealizedProfitUsdt = unrealizedProfitUsdt;
      changed = true;
    }

    if (changed) {
      await this.saveState();
    }
  }

  async createLegOrder({ client, trade, leg, closeSide, positionSide }) {
    if (leg.kind === "trailing_stop") {
      return client.createTrailingStopMarketOrder({
        symbol: trade.symbol,
        side: closeSide,
        positionSide,
        quantity: leg.quantity,
        reduceOnly: positionSide === "BOTH" ? "true" : undefined,
        activatePrice: leg.activatePrice,
        callbackRate: leg.callbackRate,
      });
    }

    return client.createTakeProfitMarketOrder({
      symbol: trade.symbol,
      side: closeSide,
      positionSide,
      quantity: leg.closePosition ? undefined : leg.quantity,
      reduceOnly: !leg.closePosition && positionSide === "BOTH" ? "true" : undefined,
      closePosition: leg.closePosition,
      stopPrice: leg.triggerPrice,
    });
  }

  async ensurePlannedTakeProfitOrders({ client, trade, closeSide, positionSide, openAlgoOrders }) {
    let changed = false;
    const legs = getTakeProfitLegs(trade);

    for (const leg of legs) {
      if (isLegDone(leg) || leg.orderId) {
        continue;
      }

      const existing = (openAlgoOrders ?? []).find((order) =>
        orderMatchesLeg(order, leg, closeSide, positionSide),
      );
      if (existing) {
        leg.orderId = serializeOrderId(existing);
        if (leg.id === "tp") {
          trade.takeProfitOrderId = leg.orderId;
        }
        leg.status = "open";
        changed = true;
        continue;
      }

      const order = await this.createLegOrder({ client, trade, leg, closeSide, positionSide });
      leg.orderId = serializeOrderId(order);
      if (leg.id === "tp") {
        trade.takeProfitOrderId = leg.orderId;
      }
      leg.status = "open";
      changed = true;
    }

    return changed;
  }

  async cancelTakeProfitOrders(trade) {
    const client = this.runtime.createClient();
    const ids = new Set(
      [
        trade.takeProfitOrderId,
        ...getTakeProfitLegs(trade)
          .filter((leg) => leg.orderId && !isLegDone(leg))
          .map((leg) => leg.orderId),
      ]
        .map(normalizeOrderId)
        .filter(Boolean),
    );

    for (const algoId of ids) {
      await client.cancelAlgoOrder({ algoId });
    }

    trade.takeProfitOrderId = null;
    for (const leg of getTakeProfitLegs(trade)) {
      if (!isLegDone(leg)) {
        leg.orderId = null;
        leg.status = "planned";
      }
    }

    return ids.size > 0;
  }

  async syncTakeProfitPlanQuantity(trade, position) {
    if (!position || hasFilledTakeProfitLeg(trade)) {
      return false;
    }

    const positionQuantity = getPositionQuantity(position);
    if (compareDecimalStrings(positionQuantity, "0") <= 0) {
      return false;
    }

    if (
      trade.protectionQuantity &&
      compareDecimalStrings(trade.protectionQuantity, positionQuantity) === 0
    ) {
      return false;
    }

    const exchangeInfo = await this.runtime.getExchangeInfo();
    const symbolInfo = getSymbolInfo(buildSymbolIndex(exchangeInfo), trade.symbol);
    const rules = getSymbolRules(symbolInfo);
    const nextPlan = buildSplitTakeProfitPlan({
      intent: trade.intent,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      quantity: positionQuantity,
      rules,
      trailingCallbackRate: getTrailingCallbackRate(this.config),
      enabled: isSplitTakeProfitEnabled(this.config),
    });

    if (hasOpenTakeProfitOrderIds(trade)) {
      await this.cancelTakeProfitOrders(trade);
    }

    trade.takeProfitPlan = nextPlan;
    trade.takeProfitOrderId = null;
    trade.protectionQuantity = positionQuantity;
    trade.riskUsdt = formatUsdt(
      calculateRiskUsdt({
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        quantity: positionQuantity,
      }),
    );
    trade.takeProfitPlanUpdatedAt = nowIso();
    trade.needsProtection = true;
    return true;
  }

  async ensureProtectiveOrders(trade, snapshot) {
    if (!trade) {
      return false;
    }

    const client = this.runtime.createClient();
    const closeSide = closeSideForIntent(trade.intent);
    const positionSide = closePositionSideForIntent(trade.intent, snapshot.dualSidePosition);
    let changed = false;
    let openAlgoOrders = [];

    if (!isTradeProtectionComplete(trade)) {
      try {
        openAlgoOrders = await client.getOpenAlgoOrders({ symbol: trade.symbol });
        const matchingOrder = (predicate) =>
          (openAlgoOrders ?? []).find(
            (order) =>
              predicate(order) &&
              order.side === closeSide &&
              (!order.positionSide || order.positionSide === positionSide),
          );
        if (!trade.stopOrderId) {
          const existingStop = matchingOrder(isStopMarketAlgoOrder);
          if (existingStop) {
            trade.stopOrderId = serializeOrderId(existingStop);
            changed = true;
          }
        }
        if (!isSplitTakeProfitTrade(trade) && !trade.takeProfitOrderId) {
          const existingTakeProfit = matchingOrder(isTakeProfitMarketAlgoOrder);
          if (existingTakeProfit) {
            trade.takeProfitOrderId = serializeOrderId(existingTakeProfit);
            changed = true;
          }
        }
      } catch (error) {
        trade.openAlgoStatusError = error?.message || String(error);
        changed = true;
      }
    }

    if (!trade.stopOrderId) {
      const stopOrder = await client.createStopMarketOrder({
        symbol: trade.symbol,
        side: closeSide,
        positionSide,
        stopPrice: trade.stopLoss,
      });
      trade.stopOrderId = serializeOrderId(stopOrder);
      changed = true;
    }

    if (isSplitTakeProfitTrade(trade)) {
      if (
        await this.ensurePlannedTakeProfitOrders({
          client,
          trade,
          closeSide,
          positionSide,
          openAlgoOrders,
        })
      ) {
        changed = true;
      }
    } else if (!trade.takeProfitOrderId) {
      const takeProfitOrder = await client.createTakeProfitMarketOrder({
        symbol: trade.symbol,
        side: closeSide,
        positionSide,
        stopPrice: trade.takeProfit,
      });
      trade.takeProfitOrderId = serializeOrderId(takeProfitOrder);
      changed = true;
    }

    if (isTradeProtectionComplete(trade)) {
      trade.protectedAt = nowIso();
      trade.needsProtection = false;
      delete trade.openAlgoStatusError;
      return true;
    }

    trade.needsProtection = true;
    return changed;
  }

  async replaceStopOrder(trade, snapshot, stopLoss, reason) {
    const client = this.runtime.createClient();
    const closeSide = closeSideForIntent(trade.intent);
    const positionSide = closePositionSideForIntent(trade.intent, snapshot.dualSidePosition);
    const oldStopOrderId = trade.stopOrderId;
    const stopOrder = await client.createStopMarketOrder({
      symbol: trade.symbol,
      side: closeSide,
      positionSide,
      stopPrice: stopLoss,
    });

    trade.stopOrderId = serializeOrderId(stopOrder);
    trade.stopLoss = stopLoss;
    trade.stopMovedAt = nowIso();
    trade.stopMoveReason = reason;

    if (oldStopOrderId) {
      try {
        await client.cancelAlgoOrder({ algoId: oldStopOrderId });
      } catch (error) {
        trade.stopCancelError = error?.message || String(error);
      }
    }

    return true;
  }

  async syncTakeProfitPlan(trade, snapshot) {
    if (!isSplitTakeProfitTrade(trade)) {
      return false;
    }

    const client = this.runtime.createClient();
    let changed = false;
    for (const leg of getTakeProfitLegs(trade)) {
      if (!leg.orderId || isLegDone(leg)) {
        continue;
      }

      try {
        const order = await client.getAlgoOrder({ algoId: leg.orderId });
        const algoStatus = order?.algoStatus || order?.status;
        if (algoStatus && leg.lastStatus !== algoStatus) {
          leg.lastStatus = algoStatus;
          changed = true;
        }
        if (FILLED_ALGO_STATUSES.has(algoStatus) || order?.actualOrderId) {
          leg.status = "filled";
          leg.filledAt = nowIso();
          changed = true;
        } else if (DEAD_ALGO_STATUSES.has(algoStatus)) {
          leg.status = "planned";
          leg.orderId = null;
          trade.needsProtection = true;
          changed = true;
        }
      } catch (error) {
        leg.statusError = error?.message || String(error);
        changed = true;
      }
    }

    const tp1 = getTakeProfitLegs(trade).find((leg) => leg.id === "tp1");
    const tp2 = getTakeProfitLegs(trade).find((leg) => leg.id === "tp2");
    if (tp1?.status === "filled" && !trade.stopMovedToBreakevenAt) {
      try {
        await this.replaceStopOrder(trade, snapshot, trade.entryPrice, "tp1_breakeven");
        trade.stopMovedToBreakevenAt = nowIso();
        changed = true;
      } catch (error) {
        trade.stopMoveError = error?.message || String(error);
        changed = true;
      }
    }
    if (tp2?.status === "filled" && !trade.stopMovedToTp1At) {
      try {
        await this.replaceStopOrder(trade, snapshot, tp1?.triggerPrice ?? trade.entryPrice, "tp2_lock_tp1");
        trade.stopMovedToTp1At = nowIso();
        changed = true;
      } catch (error) {
        trade.stopMoveError = error?.message || String(error);
        changed = true;
      }
    }

    return changed;
  }

  async cancelRemainingProtection(trade) {
    const client = this.runtime.createClient();
    const ids = new Set(
      [
        trade.stopOrderId,
        trade.takeProfitOrderId,
        ...getTakeProfitLegs(trade)
          .filter((leg) => leg.orderId && leg.status !== "filled" && leg.status !== "canceled")
          .map((leg) => leg.orderId),
      ]
        .map(normalizeOrderId)
        .filter(Boolean),
    );
    let changed = false;

    for (const algoId of ids) {
      try {
        await client.cancelAlgoOrder({ algoId });
        changed = true;
      } catch (error) {
        trade.cleanupError = error?.message || String(error);
        changed = true;
      }
    }

    if (changed) {
      trade.protectionCanceledAt = nowIso();
    }
    trade.needsProtection = false;
    return changed;
  }

  getEligibleCandidates(scan) {
    const activeSymbols = new Set(
      (this.state?.openTrades ?? [])
        .filter((trade) => ACTIVE_TRADE_STATUSES.has(trade.status))
        .map((trade) => trade.symbol),
    );
    const minConfidence = Number(this.config.minConfidence ?? 70);

    return (scan?.candidates ?? []).filter((candidate) => {
      const intent = getDecisionIntent(candidate);
      return (
        (intent === "open_long" || intent === "open_short") &&
        !activeSymbols.has(candidate.symbol) &&
        getConfidence(candidate) >= minConfidence &&
        candidate.entryPrice &&
        candidate.stopLoss &&
        candidate.takeProfit &&
        candidate.leverage
      );
    });
  }

  async applyRegimeGate(candidates) {
    const allowed = [];
    const skipped = [];

    for (const candidate of candidates) {
      const gate = await this.strategy?.evaluateCandidate?.(candidate);
      if (!gate || gate.allowNewTrade) {
        allowed.push({
          ...candidate,
          regimeGate: gate ?? null,
        });
        continue;
      }

      skipped.push({
        symbol: candidate.symbol,
        reason: gate.reasons?.[0] || "市场状态闸门禁止开仓",
        regimeGate: gate,
      });
    }

    return { allowed, skipped };
  }

  getAvailableCapital() {
    const state = this.state;
    const accountBudget = state?.accountBudget?.source === "exchange_account" ? state.accountBudget : null;
    const reserved = activeTradeMargin(state?.openTrades ?? []);
    const tradeUnrealized = activeTradeUnrealizedPnl(state?.openTrades ?? []);
    const unrealized = Number(accountBudget?.unrealizedProfitUsdt ?? tradeUnrealized);
    const capital = Number(accountBudget?.capitalUsdt ?? this.config.initialCapitalUsdt ?? 0);
    const equity = Number(accountBudget?.equityUsdt ?? capital + unrealized);
    const exchangeAvailable = readFiniteNumber(accountBudget?.availableCapitalUsdt);
    const available =
      exchangeAvailable === null ? Math.max(0, equity - reserved) : Math.max(0, exchangeAvailable);
    const totalRisk = activeTradeRiskUsdt(state?.openTrades ?? []);
    const maxTotalRisk = getMaxTotalRiskUsdt(this.config);
    return {
      source: accountBudget?.source ?? "local_state",
      accountBudgetUpdatedAt: accountBudget?.updatedAt ?? null,
      accountBudgetError: state?.accountBudgetError ?? null,
      capitalUsdt: formatUsdt(capital),
      unrealizedProfitUsdt: formatUsdt(unrealized),
      equityUsdt: formatUsdt(equity),
      reservedMarginUsdt: formatUsdt(reserved),
      availableCapitalUsdt: formatUsdt(available),
      totalRiskUsdt: formatUsdt(totalRisk),
      maxTotalRiskUsdt: Number.isFinite(maxTotalRisk) ? formatUsdt(maxTotalRisk) : null,
      remainingRiskUsdt: Number.isFinite(maxTotalRisk)
        ? formatUsdt(Math.max(0, maxTotalRisk - totalRisk))
        : null,
    };
  }

  getActiveOpenTradeCount() {
    return (this.state?.openTrades ?? []).filter((trade) =>
      ACTIVE_TRADE_STATUSES.has(trade.status),
    ).length;
  }

  hasPendingProtection() {
    return (this.state?.openTrades ?? []).some(
      (trade) =>
        ACTIVE_TRADE_STATUSES.has(trade.status) &&
        ((trade.needsProtection && !isTradeProtectionComplete(trade)) || shouldTrackEntryOrder(trade)),
    );
  }

  async placeCandidate(candidate) {
    const state = await this.loadState();
    const openCount = (state.openTrades ?? []).filter((trade) =>
      ACTIVE_TRADE_STATUSES.has(trade.status),
    ).length;
    if (openCount >= getMaxOpenPositions(this.config)) {
      return { ok: false, skipped: true, reason: "已达到最大持仓/挂单数量。" };
    }

    const { availableCapitalUsdt } = this.getAvailableCapital();
    const baseOrderMarginUsdt = getOrderMarginUsdt(this.config, availableCapitalUsdt);
    const minOrderMarginUsdt = getMinOrderMarginUsdt(this.config);
    if (compareDecimalStrings(baseOrderMarginUsdt, minOrderMarginUsdt) < 0) {
      return { ok: false, skipped: true, reason: "自动交易资金池暂无可用资金。" };
    }
    const marginScale = getCandidateMarginScale(candidate);
    const orderMarginUsdt = scaleOrderMarginUsdt(
      baseOrderMarginUsdt,
      minOrderMarginUsdt,
      marginScale,
    );

    const exchangeInfo = await this.runtime.getExchangeInfo();
    const symbolInfo = getSymbolInfo(buildSymbolIndex(exchangeInfo), candidate.symbol);
    const rules = getSymbolRules(symbolInfo);
    const intent = getDecisionIntent(candidate);
    const entryPrice = normalizeTriggerPrice(candidate.entryPrice, rules);
    const stopLoss = normalizeTriggerPrice(candidate.stopLoss, rules);
    const takeProfit = normalizeTriggerPrice(candidate.takeProfit, rules);

    assertProtectivePrices({ intent, entryPrice, stopLoss, takeProfit });

    const leverage = normalizeDecimalString(candidate.leverage);
    const targetNotional = multiplyDecimalStrings(orderMarginUsdt, leverage);
    const order = buildAutoOrderInput({
      decision: {
        ...candidate,
        action: intent,
        entryPrice,
        leverage,
      },
      rules,
      orderNotionalUsdt: targetNotional,
      maxLeverage: this.runtime.getAutoConfig().maxLeverage,
    });
    const actualMarginUsdt = divideDecimalStrings(order.actualNotional, order.leverage, 8);
    const riskUsdt = formatUsdt(
      calculateRiskUsdt({ entryPrice: order.price, stopLoss, quantity: order.quantity }),
    );
    const currentRiskUsdt = activeTradeRiskUsdt(state.openTrades ?? []);
    const maxTotalRiskUsdt = getMaxTotalRiskUsdt(this.config);
    if (currentRiskUsdt + Number(riskUsdt) > maxTotalRiskUsdt) {
      return {
        ok: false,
        skipped: true,
        reason: `总风险上限不足：当前 ${formatUsdt(currentRiskUsdt)}U + 本单 ${riskUsdt}U > 上限 ${formatUsdt(maxTotalRiskUsdt)}U。`,
      };
    }
    const takeProfitPlan = buildSplitTakeProfitPlan({
      intent,
      entryPrice: order.price,
      stopLoss,
      takeProfit,
      quantity: order.quantity,
      rules,
      trailingCallbackRate: getTrailingCallbackRate(this.config),
      enabled: isSplitTakeProfitEnabled(this.config),
    });
    const snapshot = await this.runtime.fetchTradingSnapshot();
    const client = this.runtime.createClient();
    const orderInstruction = buildOrderInstruction({
      intent,
      symbol: order.symbol,
      price: order.price,
      quantity: order.quantity,
      dualSidePosition: snapshot.dualSidePosition,
    });
    let entryOrder;

    await client.changeLeverage({ symbol: order.symbol, leverage: order.leverage });
    try {
      entryOrder = await client.createLimitOrder(orderInstruction);
      const trade = {
        id: `${Date.now()}-${order.symbol}`,
        status: entryOrder?.dryRun ? "dry_run" : "pending",
        symbol: order.symbol,
        intent,
        action: intent,
        confidence: getConfidence(candidate),
        marginUsdt: actualMarginUsdt,
        marginScale,
        notionalUsdt: order.actualNotional,
        riskUsdt,
        quantity: order.quantity,
        entryPrice: order.price,
        stopLoss,
        takeProfit,
        takeProfitPlan,
        leverage: order.leverage,
        source: candidate.source ?? "auto",
        reason: candidate.reason || candidate.localReason || "",
        openedAt: nowIso(),
        entryOrderId: serializeOrderId(entryOrder),
        needsProtection: !entryOrder?.dryRun,
      };
      if (entryOrder?.orderId) {
        try {
          const entryStatus = await client.getOrder({ symbol: order.symbol, orderId: entryOrder.orderId });
          trade.entryOrderStatus = entryStatus.status;
          if (entryStatus.status === "FILLED") {
            trade.status = "open";
            trade.filledAt = nowIso();
            trade.entryFullyFilledAt = trade.entryFullyFilledAt ?? nowIso();
            try {
              await this.ensureProtectiveOrders(trade, snapshot);
            } catch (error) {
              trade.protectionError = error?.message || String(error);
              trade.needsProtection = true;
            }
          } else if (entryStatus.status === "PARTIALLY_FILLED" || hasEntryFill(entryStatus)) {
            const partialSnapshot = await this.runtime.fetchTradingSnapshot();
            const matchingPosition = findMatchingPosition(
              getActivePositions(partialSnapshot.accountInfo),
              trade,
              partialSnapshot.dualSidePosition,
            );
            if (matchingPosition) {
              trade.status = "open";
              trade.partiallyFilledAt = trade.partiallyFilledAt ?? nowIso();
              try {
                await this.syncTakeProfitPlanQuantity(trade, matchingPosition);
                await this.ensureProtectiveOrders(trade, partialSnapshot);
              } catch (error) {
                trade.protectionError = error?.message || String(error);
                trade.needsProtection = true;
              }
            }
          } else if (["CANCELED", "EXPIRED", "REJECTED"].includes(entryStatus.status)) {
            trade.status = entryStatus.status.toLowerCase();
            trade.closedAt = nowIso();
            trade.needsProtection = false;
          }
        } catch (error) {
          trade.entryStatusError = error?.message || String(error);
        }
      }
      state.openTrades.push(trade);
      state.history.push({
        type: "open_trade",
        at: nowIso(),
        symbol: trade.symbol,
        intent: trade.intent,
        marginUsdt: trade.marginUsdt,
        notionalUsdt: trade.notionalUsdt,
      });
      state.history = state.history.slice(-HISTORY_LIMIT);
      await this.saveState();

      return { ok: true, trade, entryOrder };
    } catch (error) {
      if (entryOrder?.orderId) {
        try {
          await client.cancelOrder({ symbol: order.symbol, orderId: entryOrder.orderId });
        } catch (cancelError) {
          (this.logger?.error ?? noop).call(
            this.logger,
            "Auto trade cancel after protective order failure failed",
            cancelError,
          );
        }
      }

      const failedTrade = {
        id: `${Date.now()}-${order.symbol}-failed`,
        status: "protective_failed",
        symbol: order.symbol,
        intent,
        marginUsdt: actualMarginUsdt,
        notionalUsdt: order.actualNotional,
        riskUsdt,
        quantity: order.quantity,
        entryPrice: order.price,
        stopLoss,
        takeProfit,
        takeProfitPlan,
        leverage: order.leverage,
        openedAt: nowIso(),
        entryOrderId: serializeOrderId(entryOrder),
        error: error?.message || String(error),
      };
      state.openTrades.push(failedTrade);
      await this.saveState();
      throw error;
    }
  }

  async runOnce({ forceEntryScan = false } = {}) {
    if (this.running) {
      return this.lastResult;
    }

    this.running = true;
    try {
      this.assertSafety();
      await this.loadState();
      await this.syncIncome();
      await this.syncTradeStatuses();

      if (this.getActiveOpenTradeCount() >= getMaxOpenPositions(this.config)) {
        this.lastResult = {
          ok: true,
          skipped: true,
          at: nowIso(),
          reason: "已达到最大自动交易持仓/挂单数量。",
          budget: this.getAvailableCapital(),
        };
        return this.lastResult;
      }

      if (
        compareDecimalStrings(
          this.getAvailableCapital().availableCapitalUsdt,
          getMinOrderMarginUsdt(this.config),
        ) < 0
      ) {
        this.lastResult = {
          ok: true,
          skipped: true,
          at: nowIso(),
          reason: "自动交易资金池暂无可用资金。",
          budget: this.getAvailableCapital(),
        };
        return this.lastResult;
      }

      const cooldownMs = forceEntryScan ? 0 : getEntryScanCooldownMs(this.state, this.config);
      if (cooldownMs > 0) {
        this.lastResult = {
          ok: true,
          skipped: true,
          at: nowIso(),
          reason: `距离上次自动开仓扫描未满 ${Math.ceil(cooldownMs / 1000)} 秒，仅检查/补挂保护单。`,
          budget: this.getAvailableCapital(),
        };
        return this.lastResult;
      }

      this.state.lastEntryScanAt = Date.now();
      this.state.lastEntryScanAtIso = nowIso();
      await this.saveState();

      const scan = await this.runtime.getAutoScan({ forceRefresh: false });
      await this.strategy?.recordScan?.(scan);
      if (scan?.llmStatus !== "ok") {
        const modelText = scan?.llmStatus || "unknown";
        const reason =
          modelText === "error"
            ? `模型状态 error，禁止自动交易：${scan?.llmError || "LLM 分析失败"}`
            : `模型状态 ${modelText}，只有 LLM analyzed 才允许自动交易。`;
        await this.strategy?.audit?.("auto_trade_skipped", {
          reason,
          llmStatus: scan?.llmStatus ?? null,
          llmError: scan?.llmError ?? null,
        });
        this.lastResult = {
          ok: true,
          skipped: true,
          at: nowIso(),
          reason,
          budget: this.getAvailableCapital(),
        };
        return this.lastResult;
      }
      const candidates = this.getEligibleCandidates(scan);
      const gated = await this.applyRegimeGate(candidates);
      const gatedCandidates = gated.allowed;

      if (candidates.length && !gatedCandidates.length) {
        const reason = gated.skipped[0]?.reason || "市场状态闸门禁止开仓。";
        await this.strategy?.audit?.("auto_trade_skipped", {
          reason,
          eligibleCandidates: candidates.length,
          regimeSkipped: gated.skipped.length,
        });
        this.lastResult = {
          ok: true,
          skipped: true,
          at: nowIso(),
          reason,
          budget: this.getAvailableCapital(),
          regimeSkippedCandidates: gated.skipped,
        };
        return this.lastResult;
      }

      if (!candidates.length) {
        this.lastResult = {
          ok: true,
          skipped: true,
          at: nowIso(),
          reason: "没有达到自动交易条件的候选。",
          budget: this.getAvailableCapital(),
        };
        return this.lastResult;
      }

      const placements = [];
      const skipped = [];
      const maxOrdersPerRun = getMaxOrdersPerRun(this.config);

      for (const candidate of gatedCandidates) {
        if (placements.length >= maxOrdersPerRun) {
          break;
        }

        if (this.getActiveOpenTradeCount() >= getMaxOpenPositions(this.config)) {
          break;
        }

        if (
          compareDecimalStrings(
            this.getAvailableCapital().availableCapitalUsdt,
            getMinOrderMarginUsdt(this.config),
          ) < 0
        ) {
          break;
        }

        const placement = await this.placeCandidate(candidate);
        if (placement.ok) {
          placements.push(placement);
        } else if (placement.skipped) {
          skipped.push({ symbol: candidate.symbol, reason: placement.reason });
        }
      }

      this.lastResult = {
        ok: placements.length > 0,
        skipped: placements.length === 0,
        at: nowIso(),
        reason: placements.length ? null : skipped[0]?.reason || "没有可提交的候选。",
        candidate: placements[0]?.trade?.symbol ?? gatedCandidates[0]?.symbol,
        trade: placements[0]?.trade ?? null,
        trades: placements.map((placement) => placement.trade),
        placedCount: placements.length,
        skippedCandidates: [...gated.skipped, ...skipped],
        budget: this.getAvailableCapital(),
      };
      if (placements.length) {
        await this.strategy?.audit?.("auto_trade_placed", {
          accountId: this.accountId,
          placedCount: placements.length,
          symbols: placements.map((placement) => placement.trade?.symbol),
        });
        await this.notifyPlacements(placements);
        this.logger?.log?.(`Auto testnet trade placed: ${placements.length} orders.`);
      } else {
        await this.strategy?.audit?.("auto_trade_skipped", {
          reason: this.lastResult.reason,
          skippedCandidates: this.lastResult.skippedCandidates,
        });
        this.logger?.log?.(`Auto testnet trade skipped: ${this.lastResult.reason}`);
      }
      return this.lastResult;
    } catch (error) {
      this.lastResult = {
        ok: false,
        at: nowIso(),
        error: error?.message || String(error),
        budget: this.state ? this.getAvailableCapital() : null,
      };
      (this.logger?.error ?? noop).call(this.logger, "Auto testnet trade failed", error);
      return this.lastResult;
    } finally {
      this.running = false;
      this.schedule(this.hasPendingProtection() ? getProtectionRetryMs(this.config) : this.config.intervalMs);
    }
  }

  async getStatus() {
    if (this.config.stateFile) {
      await this.loadState();
    }

    if (this.runtime?.config?.apiKey && this.runtime?.config?.apiSecret) {
      try {
        await this.syncAccountBudget();
      } catch (error) {
        if (this.state) {
          this.state.accountBudgetError = error?.message || String(error);
          await this.saveState();
        }
      }
    }

      return {
        accountId: this.accountId,
        accountLabel: this.accountLabel,
        enabled: this.isEnabled(),
      running: this.running,
      safety: {
        testnetOnly: this.config.testnetOnly !== false,
        currentEnvironment: describeFuturesEnvironment(this.runtime?.config?.baseUrl).id,
        allowed: this.config.testnetOnly === false || this.isTestnetRuntime(),
      },
      config: {
        initialCapitalUsdt: String(this.config.initialCapitalUsdt ?? "0"),
        maxOpenPositions: Number(this.config.maxOpenPositions ?? 1),
        orderMarginUsdt: Number(this.config.orderMarginUsdt ?? 20),
        minOrderMarginUsdt: Number(this.config.minOrderMarginUsdt ?? 10),
        maxOrdersPerRun: Number(this.config.maxOrdersPerRun ?? 3),
        minConfidence: Number(this.config.minConfidence ?? 70),
        maxTotalRiskUsdt: Number(this.config.maxTotalRiskUsdt ?? 30),
        intervalMs: Number(this.config.intervalMs ?? 900000),
        protectionRetryMs: getProtectionRetryMs(this.config),
        splitTakeProfitEnabled: isSplitTakeProfitEnabled(this.config),
        trailingCallbackRate: getTrailingCallbackRate(this.config),
        regimeGateEnabled: this.config.regimeGateEnabled !== false,
        regimeSymbol: this.config.regimeSymbol || "BTCUSDT",
        shadowModeEnabled: this.config.shadowModeEnabled !== false,
        auditEnabled: this.config.auditEnabled !== false,
      },
      budget: this.state ? this.getAvailableCapital() : null,
      openTrades: this.state?.openTrades?.filter((trade) => ACTIVE_TRADE_STATUSES.has(trade.status)) ?? [],
      recentHistory: this.state?.history?.slice(-10).reverse() ?? [],
      regimeGate: this.strategy?.lastRegimeGate ?? null,
      shadowStats: await this.strategy?.shadowBook?.getStats?.() ?? null,
      auditSummary: await this.strategy?.auditLogger?.getSummary?.({ limit: 100 }) ?? null,
      lastResult: this.lastResult,
    };
  }
}
