import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AutoTradeService, buildSplitTakeProfitPlan } from "../src/trader/autoTradeService.mjs";

const symbolInfo = {
  symbol: "BTCUSDT",
  status: "TRADING",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  marginAsset: "USDT",
  filters: [
    { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "1000000", tickSize: "0.1" },
    { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "1000", stepSize: "0.001" },
    { filterType: "MIN_NOTIONAL", notional: "5" },
  ],
};

async function createStateFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-trade-"));
  return path.join(dir, "state.json");
}

function createRuntime({
  baseUrl = "https://demo-fapi.binance.com",
  calls = [],
  accountInfo = { assets: [], positions: [] },
} = {}) {
  return {
    config: {
      apiKey: "test-key",
      apiSecret: "test-secret",
      baseUrl,
      dryRun: false,
    },
    getAutoConfig: () => ({
      maxLeverage: 20,
      scanIntervalMs: 900000,
    }),
    createClient: () => ({
      getIncomeHistory: async () => [],
      changeLeverage: async (payload) => {
        calls.push(["leverage", payload]);
        return { leverage: payload.leverage };
      },
      createLimitOrder: async (payload) => {
        calls.push(["entry", payload]);
        return { orderId: 1001 };
      },
      createStopMarketOrder: async (payload) => {
        calls.push(["stop", payload]);
        return { orderId: 1002 };
      },
      createTakeProfitMarketOrder: async (payload) => {
        calls.push(["takeProfit", payload]);
        return { orderId: 1003 };
      },
      createTrailingStopMarketOrder: async (payload) => {
        calls.push(["trailing", payload]);
        return { orderId: 1004 };
      },
      getOpenAlgoOrders: async (payload) => {
        calls.push(["openAlgo", payload]);
        return [];
      },
      getAlgoOrder: async () => ({ algoStatus: "NEW" }),
      cancelAlgoOrder: async (payload) => {
        calls.push(["cancelAlgo", payload]);
        return { code: "200" };
      },
      cancelOrder: async (payload) => {
        calls.push(["cancelOrder", payload]);
        return { status: "CANCELED" };
      },
      getOrder: async () => ({ status: "FILLED" }),
    }),
    getExchangeInfo: async () => ({ symbols: [symbolInfo] }),
    fetchTradingSnapshot: async () => ({
      dualSidePosition: true,
      accountInfo,
    }),
    getAutoScan: async () => ({
      llmStatus: "ok",
      candidates: [
        {
          symbol: "BTCUSDT",
          action: "open_long",
          confidence: 82,
          entryPrice: "65000.1",
          stopLoss: "64000.1",
          takeProfit: "67000.1",
          leverage: 10,
          reason: "test setup",
        },
      ],
    }),
  };
}

test("buildSplitTakeProfitPlan calculates long and short split exits", () => {
  const rules = {
    symbol: "BTCUSDT",
    tickSize: "0.1",
    minPrice: "0.1",
    maxPrice: "1000000",
    stepSize: "0.001",
    minQty: "0.001",
    maxQty: "1000",
    minNotional: "5",
  };

  const longPlan = buildSplitTakeProfitPlan({
    intent: "open_long",
    entryPrice: "100",
    stopLoss: "95",
    takeProfit: "120",
    quantity: "1",
    rules,
  });
  const shortPlan = buildSplitTakeProfitPlan({
    intent: "open_short",
    entryPrice: "100",
    stopLoss: "105",
    takeProfit: "80",
    quantity: "1",
    rules,
  });

  assert.equal(longPlan.mode, "split");
  assert.equal(longPlan.legs[0].triggerPrice, "105");
  assert.equal(longPlan.legs[1].triggerPrice, "110");
  assert.equal(longPlan.legs[2].activatePrice, "110");
  assert.deepEqual(longPlan.legs.map((leg) => leg.quantity), ["0.35", "0.35", "0.3"]);
  assert.equal(shortPlan.legs[0].triggerPrice, "95");
  assert.equal(shortPlan.legs[1].triggerPrice, "90");
});

test("buildSplitTakeProfitPlan falls back when quantity is too small", () => {
  const plan = buildSplitTakeProfitPlan({
    intent: "open_long",
    entryPrice: "100",
    stopLoss: "95",
    takeProfit: "120",
    quantity: "0.002",
    rules: {
      symbol: "BTCUSDT",
      tickSize: "0.1",
      minPrice: "0.1",
      maxPrice: "1000000",
      stepSize: "0.001",
      minQty: "0.001",
      maxQty: "1000",
      minNotional: "5",
    },
  });

  assert.equal(plan.mode, "single");
  assert.equal(plan.legs[0].closePosition, true);
  assert.match(plan.fallbackReason, /minQty|minNotional/);
});

test("AutoTradeService refuses to start on mainnet when testnet-only", async () => {
  const service = new AutoTradeService({
    runtime: createRuntime({ baseUrl: "https://fapi.binance.com" }),
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  assert.equal(service.start(), false);
  const result = await service.runOnce();
  assert.equal(result.ok, false);
  assert.match(result.error, /只允许在测试网运行/);
});

test("AutoTradeService places testnet entry with protective stop and take profit", async () => {
  const calls = [];
  const service = new AutoTradeService({
    runtime: createRuntime({ calls }),
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();
  const status = await service.getStatus();

  assert.equal(result.ok, true);
  assert.equal(result.trade.symbol, "BTCUSDT");
  assert.equal(result.trade.stopLoss, "64000.1");
  assert.equal(result.trade.takeProfit, "67000.1");
  assert.equal(result.trade.takeProfitPlan.mode, "split");
  assert.equal(result.trade.takeProfitPlan.legs.length, 3);
  assert.equal(result.trade.leverage, "10");
  assert.equal(status.openTrades.length, 1);
  assert.equal(calls[0][0], "leverage");
  assert.equal(calls[1][0], "entry");
  const stopCall = calls.find(([name]) => name === "stop");
  const takeProfitCalls = calls.filter(([name]) => name === "takeProfit");
  const trailingCall = calls.find(([name]) => name === "trailing");
  assert.equal(stopCall[1].side, "SELL");
  assert.equal(stopCall[1].positionSide, "LONG");
  assert.equal(takeProfitCalls.length, 2);
  assert.equal(takeProfitCalls[0][1].quantity, "0.001");
  assert.equal(takeProfitCalls[0][1].stopPrice, "66000.1");
  assert.equal(takeProfitCalls[1][1].quantity, "0.001");
  assert.equal(takeProfitCalls[1][1].stopPrice, "67000.1");
  assert.equal(trailingCall[1].quantity, "0.001");
  assert.equal(trailingCall[1].activatePrice, "67000.1");
  assert.equal(trailingCall[1].callbackRate, "0.8");
  assert.equal(status.budget.capitalUsdt, "100");
  assert.notEqual(status.budget.reservedMarginUsdt, "0");
});

test("AutoTradeService uses exchange account balance for budget", async () => {
  const service = new AutoTradeService({
    runtime: createRuntime({
      accountInfo: {
        totalWalletBalance: "500",
        availableBalance: "450",
        totalUnrealizedProfit: "5",
        totalMarginBalance: "505",
        assets: [],
        positions: [],
      },
    }),
    config: {
      enabled: false,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  const status = await service.getStatus();

  assert.equal(status.budget.source, "exchange_account");
  assert.equal(status.budget.capitalUsdt, "500");
  assert.equal(status.budget.availableCapitalUsdt, "450");
  assert.equal(status.budget.equityUsdt, "505");
  assert.equal(status.config.initialCapitalUsdt, "100");
});

test("AutoTradeService sends Feishu notice after placed orders", async () => {
  const sent = [];
  const service = new AutoTradeService({
    runtime: createRuntime(),
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    notifier: {
      send: async (message) => {
        sent.push(message);
      },
    },
    accountLabel: "test-account",
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /test-account/);
  assert.match(sent[0], /BTCUSDT/);
  assert.doesNotMatch(sent[0], /候选记录数/);
});

test("AutoTradeService uses BOTH positionSide for one-way protective orders", async () => {
  const calls = [];
  const runtime = createRuntime({ calls });
  runtime.fetchTradingSnapshot = async () => ({
    dualSidePosition: false,
    accountInfo: {
      assets: [],
      positions: [],
    },
  });
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();

  assert.equal(result.ok, true);
  const stopCall = calls.find(([name]) => name === "stop");
  const takeProfitCall = calls.find(([name]) => name === "takeProfit");
  assert.equal(stopCall[1].positionSide, "BOTH");
  assert.equal(takeProfitCall[1].positionSide, "BOTH");
});

test("AutoTradeService waits for pending entry fill before protective orders", async () => {
  const calls = [];
  let orderStatus = "NEW";
  const runtime = createRuntime({ calls });
  runtime.createClient = () => ({
    getIncomeHistory: async () => [],
    changeLeverage: async (payload) => {
      calls.push(["leverage", payload]);
      return { leverage: payload.leverage };
    },
    createLimitOrder: async (payload) => {
      calls.push(["entry", payload]);
      return { orderId: 2001 };
    },
    createStopMarketOrder: async (payload) => {
      calls.push(["stop", payload]);
      return { algoId: 2002 };
    },
    createTakeProfitMarketOrder: async (payload) => {
      calls.push(["takeProfit", payload]);
      return { algoId: 2003 };
    },
    createTrailingStopMarketOrder: async (payload) => {
      calls.push(["trailing", payload]);
      return { algoId: 2004 };
    },
    getOpenAlgoOrders: async (payload) => {
      calls.push(["openAlgo", payload]);
      return [];
    },
    getAlgoOrder: async () => ({ algoStatus: "NEW" }),
    cancelAlgoOrder: async (payload) => {
      calls.push(["cancelAlgo", payload]);
      return { code: "200" };
    },
    getOrder: async () => ({ status: orderStatus }),
  });
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  const first = await service.runOnce();
  assert.equal(first.ok, true);
  assert.equal(first.trade.status, "pending");
  assert.equal(first.trade.needsProtection, true);
  assert.equal(calls.some(([name]) => name === "stop"), false);

  orderStatus = "FILLED";
  const second = await service.runOnce();
  const status = await service.getStatus();

  assert.equal(second.skipped, true);
  assert.equal(status.openTrades[0].status, "open");
  assert.equal(status.openTrades[0].stopOrderId, 2002);
  assert.deepEqual(
    status.openTrades[0].takeProfitPlan.legs.map((leg) => leg.orderId),
    [2003, 2003, 2004],
  );
});

test("AutoTradeService protects partially filled entries immediately", async () => {
  const calls = [];
  let snapshotCalls = 0;
  const runtime = createRuntime({ calls });
  runtime.getAutoScan = async () => ({
    llmStatus: "ok",
    candidates: [
      {
        symbol: "BTCUSDT",
        action: "open_long",
        confidence: 90,
        entryPrice: "100",
        stopLoss: "95",
        takeProfit: "115",
        leverage: 10,
        reason: "partial fill",
      },
    ],
  });
  runtime.fetchTradingSnapshot = async () => {
    snapshotCalls += 1;
    return {
      dualSidePosition: true,
      accountInfo: {
        assets: [],
        positions:
          snapshotCalls === 1
            ? []
            : [
                {
                  symbol: "BTCUSDT",
                  positionSide: "LONG",
                  positionAmt: "1.2",
                  markPrice: "100",
                  unrealizedProfit: "0",
                },
              ],
      },
    };
  };
  runtime.createClient = () => ({
    getIncomeHistory: async () => [],
    changeLeverage: async (payload) => {
      calls.push(["leverage", payload]);
      return { leverage: payload.leverage };
    },
    createLimitOrder: async (payload) => {
      calls.push(["entry", payload]);
      return { orderId: 3101 };
    },
    createStopMarketOrder: async (payload) => {
      calls.push(["stop", payload]);
      return { algoId: 3102 };
    },
    createTakeProfitMarketOrder: async (payload) => {
      calls.push(["takeProfit", payload]);
      return { algoId: 3103 };
    },
    createTrailingStopMarketOrder: async (payload) => {
      calls.push(["trailing", payload]);
      return { algoId: 3104 };
    },
    getOpenAlgoOrders: async (payload) => {
      calls.push(["openAlgo", payload]);
      return [];
    },
    getAlgoOrder: async () => ({ algoStatus: "NEW" }),
    cancelAlgoOrder: async (payload) => {
      calls.push(["cancelAlgo", payload]);
      return { code: "200" };
    },
    getOrder: async () => ({ status: "PARTIALLY_FILLED", executedQty: "1.2" }),
  });
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();
  const status = await service.getStatus();

  assert.equal(result.ok, true);
  assert.equal(result.trade.status, "open");
  assert.equal(result.trade.entryOrderStatus, "PARTIALLY_FILLED");
  assert.equal(result.trade.protectionQuantity, "1.2");
  assert.equal(status.openTrades[0].needsProtection, false);
  assert.equal(service.hasPendingProtection(), true);
  const stopCall = calls.find(([name]) => name === "stop");
  const takeProfitCalls = calls.filter(([name]) => name === "takeProfit");
  const trailingCall = calls.find(([name]) => name === "trailing");
  assert.equal(stopCall[1].stopPrice, "95");
  assert.deepEqual(takeProfitCalls.map(([, payload]) => payload.quantity), ["0.42", "0.42"]);
  assert.equal(trailingCall[1].quantity, "0.36");
});

test("AutoTradeService cancels stale unfilled entry orders", async () => {
  const calls = [];
  let scanCalls = 0;
  const runtime = createRuntime({ calls });
  runtime.getAutoScan = async () => {
    scanCalls += 1;
    return { llmStatus: "ok", candidates: [] };
  };
  runtime.createClient = () => ({
    getIncomeHistory: async () => [],
    getOrder: async () => ({ status: "NEW", executedQty: "0" }),
    cancelOrder: async (payload) => {
      calls.push(["cancelOrder", payload]);
      return { status: "CANCELED" };
    },
  });
  const stateFile = await createStateFile();
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      initialCapitalUsdt: "100",
      capitalUsdt: "100",
      lastIncomeSyncTime: Date.now(),
      lastEntryScanAt: Date.now(),
      processedIncomeKeys: [],
      openTrades: [
        {
          id: "stale-entry",
          status: "pending",
          symbol: "BTCUSDT",
          intent: "open_long",
          marginUsdt: "20",
          openedAt: new Date(Date.now() - 60_000).toISOString(),
          entryOrderId: 3201,
          needsProtection: true,
        },
      ],
      history: [],
    }),
  );
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 0,
      minConfidence: 70,
      intervalMs: 900000,
      entryOrderTtlMs: 1000,
      stateFile,
    },
    logger: { log() {}, error() {} },
  });

  await service.runOnce();
  await service.getStatus();
  const trade = service.state.openTrades[0];

  assert.equal(trade.status, "canceled");
  assert.equal(trade.entryCancelReason, "entry_ttl_expired");
  assert.equal(trade.needsProtection, false);
  assert.equal(calls.find(([name]) => name === "cancelOrder")[1].orderId, 3201);
  assert.equal(scanCalls, 0);
});

test("AutoTradeService cancels stale remaining entry after partial fill", async () => {
  const calls = [];
  const runtime = createRuntime({ calls });
  runtime.fetchTradingSnapshot = async () => ({
    dualSidePosition: true,
    accountInfo: {
      assets: [],
      positions: [
        {
          symbol: "BTCUSDT",
          positionSide: "LONG",
          positionAmt: "1",
          markPrice: "101",
          unrealizedProfit: "1",
        },
      ],
    },
  });
  runtime.createClient = () => ({
    getIncomeHistory: async () => [],
    getOrder: async () => ({ status: "PARTIALLY_FILLED", executedQty: "1" }),
    cancelOrder: async (payload) => {
      calls.push(["cancelOrder", payload]);
      return { status: "CANCELED" };
    },
    getOpenAlgoOrders: async () => [],
  });
  const stateFile = await createStateFile();
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      initialCapitalUsdt: "100",
      capitalUsdt: "100",
      lastIncomeSyncTime: Date.now(),
      lastEntryScanAt: Date.now(),
      processedIncomeKeys: [],
      openTrades: [
        {
          id: "partial-stale",
          status: "open",
          symbol: "BTCUSDT",
          intent: "open_long",
          marginUsdt: "20",
          quantity: "2",
          entryPrice: "100",
          stopLoss: "95",
          takeProfit: "110",
          openedAt: new Date(Date.now() - 60_000).toISOString(),
          entryOrderId: 3301,
          entryOrderStatus: "PARTIALLY_FILLED",
          stopOrderId: 3302,
          takeProfitOrderId: 3303,
          protectionQuantity: "1",
          needsProtection: false,
        },
      ],
      history: [],
    }),
  );
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 0,
      minConfidence: 70,
      intervalMs: 900000,
      entryOrderTtlMs: 1000,
      stateFile,
    },
    logger: { log() {}, error() {} },
  });

  await service.runOnce();
  const status = await service.getStatus();

  assert.equal(status.openTrades[0].status, "open");
  assert.equal(status.openTrades[0].entryOrderStatus, "CANCELED");
  assert.equal(status.openTrades[0].entryCancelReason, "entry_ttl_expired");
  assert.equal(status.openTrades[0].needsProtection, false);
  assert.equal(calls.find(([name]) => name === "cancelOrder")[1].orderId, 3301);
});

test("AutoTradeService retries pending protection quickly after status lookup miss", async () => {
  const calls = [];
  const delays = [];
  const runtime = createRuntime({ calls });
  runtime.createClient = () => ({
    getIncomeHistory: async () => [],
    changeLeverage: async (payload) => {
      calls.push(["leverage", payload]);
      return { leverage: payload.leverage };
    },
    createLimitOrder: async (payload) => {
      calls.push(["entry", payload]);
      return { orderId: 3001 };
    },
    createStopMarketOrder: async (payload) => {
      calls.push(["stop", payload]);
      return { algoId: 3002 };
    },
    createTakeProfitMarketOrder: async (payload) => {
      calls.push(["takeProfit", payload]);
      return { algoId: 3003 };
    },
    createTrailingStopMarketOrder: async (payload) => {
      calls.push(["trailing", payload]);
      return { algoId: 3004 };
    },
    getOpenAlgoOrders: async (payload) => {
      calls.push(["openAlgo", payload]);
      return [];
    },
    getAlgoOrder: async () => ({ algoStatus: "NEW" }),
    cancelAlgoOrder: async (payload) => {
      calls.push(["cancelAlgo", payload]);
      return { code: "200" };
    },
    getOrder: async () => {
      throw new Error("Binance request failed: Order does not exist.");
    },
  });
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      protectionRetryMs: 15000,
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
    setTimeoutImpl: (callback, delay) => {
      delays.push(delay);
      return { unref() {} };
    },
  });
  service.stopped = false;

  const result = await service.runOnce();
  const status = await service.getStatus();

  assert.equal(result.ok, true);
  assert.equal(status.openTrades[0].status, "pending");
  assert.equal(status.openTrades[0].needsProtection, true);
  assert.match(status.openTrades[0].entryStatusError, /Order does not exist/);
  assert.equal(calls.some(([name]) => name === "stop"), false);
  assert.equal(delays.at(-1), 15000);
});

test("AutoTradeService skips orders when regime gate blocks candidates", async () => {
  const calls = [];
  const audits = [];
  const service = new AutoTradeService({
    runtime: createRuntime({ calls }),
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    strategy: {
      recordScan: async () => {},
      evaluateCandidate: async (candidate) => ({
        symbol: candidate.symbol,
        state: "风险关闭",
        allowNewTrade: false,
        riskScore: 100,
        reasons: ["风险关闭，禁止新开仓"],
      }),
      audit: async (type, payload) => audits.push([type, payload]),
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();

  assert.equal(result.skipped, true);
  assert.equal(result.regimeSkippedCandidates.length, 1);
  assert.equal(calls.some(([name]) => name === "entry"), false);
  assert.equal(audits.some(([type]) => type === "auto_trade_skipped"), true);
});

test("AutoTradeService does not open new entries during scan cooldown", async () => {
  const calls = [];
  let scanCalls = 0;
  const runtime = createRuntime({ calls });
  runtime.getAutoScan = async () => {
    scanCalls += 1;
    return {
      llmStatus: "ok",
      candidates: [
        {
          symbol: "ETHUSDT",
          action: "open_long",
          confidence: 90,
          entryPrice: "3000",
          stopLoss: "2950",
          takeProfit: "3100",
          leverage: 10,
          reason: "cooldown should block this",
        },
      ],
    };
  };
  const stateFile = await createStateFile();
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      initialCapitalUsdt: "100",
      capitalUsdt: "100",
      lastIncomeSyncTime: Date.now(),
      lastEntryScanAt: Date.now(),
      processedIncomeKeys: [],
      openTrades: [
        {
          id: "trade-1",
          status: "pending",
          symbol: "BTCUSDT",
          intent: "open_long",
          marginUsdt: "20",
          needsProtection: true,
        },
      ],
      history: [],
    }),
  );
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 0,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile,
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();

  assert.equal(result.skipped, true);
  assert.match(result.reason, /自动开仓扫描未满/);
  assert.equal(scanCalls, 0);
  assert.equal(calls.some(([name]) => name === "entry"), false);
});

test("AutoTradeService skips trading unless LLM analyzed", async () => {
  const calls = [];
  const runtime = createRuntime({ calls });
  runtime.getAutoScan = async () => ({
    llmStatus: "error",
    llmError: "model unavailable",
    candidates: [
      {
        symbol: "BTCUSDT",
        action: "open_long",
        confidence: 99,
        entryPrice: "65000.1",
        stopLoss: "64000.1",
        takeProfit: "67000.1",
        leverage: 10,
        reason: "should not trade",
      },
    ],
  });
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();

  assert.equal(result.skipped, true);
  assert.match(result.reason, /模型状态 error/);
  assert.equal(calls.some(([name]) => name === "entry"), false);
});

test("AutoTradeService skips orders over total risk cap", async () => {
  const calls = [];
  const service = new AutoTradeService({
    runtime: createRuntime({ calls }),
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      maxTotalRiskUsdt: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile: await createStateFile(),
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();
  const status = await service.getStatus();

  assert.equal(result.skipped, true);
  assert.match(result.reason, /总风险上限不足/);
  assert.equal(status.budget.maxTotalRiskUsdt, "1");
  assert.equal(calls.some(([name]) => name === "entry"), false);
});

test("AutoTradeService moves stop after TP1 and TP2 fills", async () => {
  const calls = [];
  const stateFile = await createStateFile();
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      initialCapitalUsdt: "100",
      capitalUsdt: "100",
      lastIncomeSyncTime: Date.now(),
      processedIncomeKeys: [],
      openTrades: [
        {
          id: "trade-1",
          status: "open",
          symbol: "BTCUSDT",
          intent: "open_long",
          marginUsdt: "20",
          notionalUsdt: "100",
          quantity: "1",
          entryPrice: "100",
          stopLoss: "95",
          takeProfit: "120",
          stopOrderId: 4000,
          needsProtection: false,
          takeProfitPlan: {
            mode: "split",
            legs: [
              { id: "tp1", kind: "take_profit", quantity: "0.35", triggerPrice: "105", orderId: 4001, status: "open" },
              { id: "tp2", kind: "take_profit", quantity: "0.35", triggerPrice: "110", orderId: 4002, status: "open" },
              { id: "runner", kind: "trailing_stop", quantity: "0.3", activatePrice: "110", callbackRate: "0.8", orderId: 4003, status: "open" },
            ],
          },
          leverage: "5",
        },
      ],
      history: [],
    }),
  );
  let pass = 1;
  const runtime = createRuntime({ calls });
  runtime.fetchTradingSnapshot = async () => ({
    dualSidePosition: true,
    accountInfo: {
      assets: [],
      positions: [
        {
          symbol: "BTCUSDT",
          positionSide: "LONG",
          positionAmt: "1",
          markPrice: "106",
          unrealizedProfit: "6",
        },
      ],
    },
  });
  runtime.createClient = () => ({
    getIncomeHistory: async () => [],
    createStopMarketOrder: async (payload) => {
      calls.push(["stop", payload]);
      return { algoId: pass === 1 ? 5001 : 5002 };
    },
    cancelAlgoOrder: async (payload) => {
      calls.push(["cancelAlgo", payload]);
      return { code: "200" };
    },
    getAlgoOrder: async ({ algoId }) => {
      if (algoId === 4001) return { algoStatus: "TRIGGERED", actualOrderId: "9001" };
      if (algoId === 4002 && pass === 2) return { algoStatus: "TRIGGERED", actualOrderId: "9002" };
      return { algoStatus: "NEW" };
    },
    getOpenAlgoOrders: async () => [],
  });
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile,
    },
    logger: { log() {}, error() {} },
  });

  await service.runOnce();
  let status = await service.getStatus();
  assert.equal(status.openTrades[0].stopLoss, "100");
  assert.equal(status.openTrades[0].stopOrderId, 5001);
  assert.equal(status.openTrades[0].stopMovedToBreakevenAt !== undefined, true);

  pass = 2;
  await service.runOnce();
  status = await service.getStatus();
  assert.equal(status.openTrades[0].stopLoss, "105");
  assert.equal(status.openTrades[0].stopOrderId, 5002);
  assert.equal(status.openTrades[0].stopMovedToTp1At !== undefined, true);
  assert.deepEqual(
    calls.filter(([name]) => name === "cancelAlgo").map(([, payload]) => payload.algoId),
    [4000, 5001],
  );
});

test("AutoTradeService skips scanning when max open positions is reached", async () => {
  const runtime = createRuntime();
  let scanCalls = 0;
  runtime.getAutoScan = async () => {
    scanCalls += 1;
    return { candidates: [] };
  };
  const stateFile = await createStateFile();
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      initialCapitalUsdt: "100",
      capitalUsdt: "100",
      lastIncomeSyncTime: Date.now(),
      processedIncomeKeys: [],
      openTrades: [
        {
          id: "trade-1",
          status: "pending",
          symbol: "BTCUSDT",
          intent: "open_long",
          marginUsdt: "50",
        },
      ],
      history: [],
    }),
  );
  const service = new AutoTradeService({
    runtime,
    config: {
      enabled: true,
      testnetOnly: true,
      initialCapitalUsdt: "100",
      maxOpenPositions: 1,
      minConfidence: 70,
      intervalMs: 900000,
      stateFile,
    },
    logger: { log() {}, error() {} },
  });

  const result = await service.runOnce();

  assert.equal(result.skipped, true);
  assert.match(result.reason, /最大自动交易/);
  assert.equal(scanCalls, 0);
});
