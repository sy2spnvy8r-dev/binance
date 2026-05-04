import assert from "node:assert/strict";
import test from "node:test";
import { TraderRuntime, describeFuturesEnvironment } from "../src/trader/runtime.mjs";

function createRuntime() {
  return new TraderRuntime({
    apiKey: "demo-key",
    apiSecret: "demo-secret",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000,
    dryRun: true,
    envFile: "F:\\binance\\.env",
    webHost: "127.0.0.1",
    webPort: 4580,
  });
}

test("TraderRuntime exposes safe public config", () => {
  const runtime = new TraderRuntime({
    apiKey: "abcd1234efgh5678",
    apiSecret: "secret-value",
    baseUrl: "https://fapi.binance.com",
    recvWindow: 5000,
    dryRun: true,
    envFile: "F:\\binance\\.env",
    webHost: "127.0.0.1",
    webPort: 4580,
  });

  assert.deepEqual(runtime.getPublicConfig(), {
    baseUrl: "https://fapi.binance.com",
    environment: "mainnet",
    environmentLabel: "正式盘",
    recvWindow: 5000,
    dryRun: true,
    envFile: "F:\\binance\\.env",
    hasApiKey: true,
    hasApiSecret: true,
    apiKeyPreview: "abcd***5678",
  });
});

test("TraderRuntime identifies official futures environments", () => {
  assert.deepEqual(describeFuturesEnvironment("https://demo-fapi.binance.com/"), {
    id: "testnet",
    label: "测试网",
    baseUrl: "https://demo-fapi.binance.com",
    isKnown: true,
  });

  assert.deepEqual(describeFuturesEnvironment("https://proxy.example.com"), {
    id: "custom",
    label: "自定义",
    baseUrl: "https://proxy.example.com",
    isKnown: false,
  });
});

test("TraderRuntime tests public and account connectivity without saving config", async () => {
  const runtime = createRuntime();
  runtime.createClient = (config) => {
    assert.equal(config.baseUrl, "https://demo-fapi.binance.com");
    assert.equal(config.recvWindow, 6000);
    return {
      getExchangeInfo: async () => ({
        symbols: [{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT" }],
      }),
      getAccountInfo: async () => ({
        assets: [{ asset: "USDT" }],
        positions: [{ symbol: "BTCUSDT" }],
      }),
    };
  };

  const result = await runtime.testConnection({
    baseUrl: "https://demo-fapi.binance.com",
    recvWindow: 6000,
  });

  assert.equal(result.environment, "testnet");
  assert.equal(result.public.ok, true);
  assert.equal(result.public.symbolCount, 2);
  assert.equal(result.account.ok, true);
  assert.equal(result.account.assetCount, 1);
  assert.equal(runtime.config.baseUrl, "https://fapi.binance.com");
});

test("TraderRuntime previewOrder converts margin input into quantity", async () => {
  const runtime = createRuntime();

  runtime.getExchangeInfo = async () => ({
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        filters: [
          {
            filterType: "PRICE_FILTER",
            minPrice: "0.1",
            maxPrice: "1000000",
            tickSize: "0.1",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.001",
            maxQty: "1000",
            stepSize: "0.001",
          },
          {
            filterType: "MIN_NOTIONAL",
            notional: "5",
          },
        ],
      },
    ],
  });

  runtime.fetchTradingSnapshot = async () => ({
    dualSidePosition: true,
    accountInfo: {
      totalWalletBalance: "100",
      availableBalance: "60",
      totalUnrealizedProfit: "3",
      maxWithdrawAmount: "50",
      assets: [
        {
          asset: "USDT",
          walletBalance: "100",
          availableBalance: "60",
          unrealizedProfit: "3",
        },
      ],
      positions: [
        {
          symbol: "BTCUSDT",
          positionSide: "LONG",
          positionAmt: "0.030",
          entryPrice: "64000",
          markPrice: "64500",
          leverage: "10",
          marginType: "ISOLATED",
          notional: "1935",
          initialMargin: "193.5",
          unrealizedProfit: "15",
        },
      ],
    },
  });

  const preview = await runtime.previewOrder({
    symbol: "btcusdt",
    intent: "open_long",
    margin: "10",
    price: "50000",
    leverage: "10",
  });

  assert.equal(preview.symbol, "BTCUSDT");
  assert.equal(preview.intentLabel, "开多");
  assert.equal(preview.margin, "10");
  assert.equal(preview.quantity, "0.002");
  assert.equal(preview.price, "50000");
  assert.equal(preview.leverage, "10");
  assert.equal(preview.notional, "100");
  assert.equal(preview.estimatedMargin, "10");
  assert.deepEqual(preview.orderInstruction, {
    symbol: "BTCUSDT",
    side: "BUY",
    positionSide: "LONG",
    price: "50000",
    quantity: "0.002",
  });
});

test("TraderRuntime getAccountSnapshot merges position risk and symbol config fields", async () => {
  const runtime = createRuntime();

  runtime.createClient = () => ({
    getAccountInfo: async () => ({
      totalWalletBalance: "100",
      availableBalance: "60",
      totalUnrealizedProfit: "3",
      maxWithdrawAmount: "50",
      assets: [
        {
          asset: "USDT",
          walletBalance: "100",
          availableBalance: "60",
          unrealizedProfit: "3",
        },
      ],
      positions: [
        {
          symbol: "AXSUSDT",
          positionSide: "LONG",
          positionAmt: "280",
          unrealizedProfit: "-6.538",
          initialMargin: "0",
          notional: "0",
        },
      ],
    }),
    getPositionMode: async () => ({ dualSidePosition: true }),
    getPositionRisk: async () => [
      {
        symbol: "AXSUSDT",
        positionSide: "LONG",
        positionAmt: "280",
        entryPrice: "4.221",
        breakEvenPrice: "4.225",
        markPrice: "4.198",
        unRealizedProfit: "-6.538",
        liquidationPrice: "0",
        notional: "1175.44",
        initialMargin: "117.544",
      },
    ],
    getSymbolConfig: async () => [
      {
        symbol: "AXSUSDT",
        leverage: 10,
        marginType: "ISOLATED",
        isAutoAddMargin: "false",
      },
    ],
  });

  const snapshot = await runtime.getAccountSnapshot();

  assert.equal(snapshot.summary.positionMode, "双向持仓模式");
  assert.equal(snapshot.positions[0].symbol, "AXSUSDT");
  assert.equal(snapshot.positions[0].entryPrice, "4.221");
  assert.equal(snapshot.positions[0].markPrice, "4.198");
  assert.equal(snapshot.positions[0].leverage, "10x");
  assert.equal(snapshot.positions[0].marginMode, "逐仓");
});

test("TraderRuntime caches low-frequency position metadata between refreshes", async () => {
  const runtime = createRuntime();
  const calls = {
    account: 0,
    risk: 0,
    mode: 0,
    config: 0,
  };

  runtime.createClient = () => ({
    getAccountInfo: async () => {
      calls.account += 1;
      return {
        totalWalletBalance: "100",
        availableBalance: "60",
        totalUnrealizedProfit: "3",
        maxWithdrawAmount: "50",
        assets: [],
        positions: [],
      };
    },
    getPositionRisk: async () => {
      calls.risk += 1;
      return [];
    },
    getPositionMode: async () => {
      calls.mode += 1;
      return { dualSidePosition: true };
    },
    getSymbolConfig: async () => {
      calls.config += 1;
      return [];
    },
  });

  await runtime.getAccountSnapshot();
  await runtime.getAccountSnapshot();

  assert.equal(calls.account, 2);
  assert.equal(calls.risk, 2);
  assert.equal(calls.mode, 1);
  assert.equal(calls.config, 1);
});

test("TraderRuntime getMarketAnalysis merges public futures analysis data and caches it", async () => {
  const runtime = createRuntime();
  const calls = {
    openInterest: 0,
  };

  runtime.getExchangeInfo = async () => ({
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        filters: [
          { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "1000000", tickSize: "0.1" },
          { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "1000", stepSize: "0.001" },
        ],
      },
    ],
  });
  runtime.createClient = () => ({
    getFundingRateHistory: async () => [{ fundingRate: "0.0003", fundingTime: 1710000000000 }],
    getOpenInterest: async () => {
      calls.openInterest += 1;
      return { openInterest: "1000", time: 1710000000000 };
    },
    getOpenInterestHistory: async ({ period }) => [
      { sumOpenInterestValue: period === "5m" ? "100000" : "200000", timestamp: "1" },
      { sumOpenInterestValue: period === "5m" ? "103000" : "202000", timestamp: "2" },
    ],
    getGlobalLongShortRatio: async () => [{ longShortRatio: "1.2" }],
    getTopTraderLongShortRatio: async () => [{ longShortRatio: "1.3" }],
    getTakerBuySellVolume: async () => [{ buySellRatio: "1.3" }],
  });
  runtime.getTodaySquareNotes = async () => ({
    sentiment: "偏多",
    postCount: 1,
    keywords: ["BTCUSDT"],
    riskWords: [],
    posts: [],
    status: "ok",
  });

  const first = await runtime.getMarketAnalysis({ symbol: "btcusdt" });
  const second = await runtime.getMarketAnalysis({ symbol: "BTCUSDT" });

  assert.equal(first.symbol, "BTCUSDT");
  assert.equal(first.signal, "偏多");
  assert.equal(first.openInterest.openInterest, "1000");
  assert.equal(first.openInterestChange["5m"].percentChange, 3);
  assert.equal(first.squareNotes.sentiment, "偏多");
  assert.equal(second, first);
  assert.equal(calls.openInterest, 1);
});

test("TraderRuntime getAutoScan uses original auto analyzer and caches results", async () => {
  const runtime = createRuntime();
  let calls = 0;
  runtime.autoAnalyzer = {
    scan: async () => {
      calls += 1;
      return {
        scannedAt: "2026-05-01T00:00:00.000Z",
        candidates: [{ symbol: "BTCUSDT", action: "open_long", confidence: 80 }],
      };
    },
  };

  const first = await runtime.getAutoScan();
  const second = await runtime.getAutoScan();

  assert.equal(first.candidates[0].symbol, "BTCUSDT");
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test("TraderRuntime getAutoScan can start background scan without blocking", async () => {
  const runtime = createRuntime();
  let resolveScan;
  runtime.autoAnalyzer = {
    scan: () =>
      new Promise((resolve) => {
        resolveScan = resolve;
      }),
  };

  const pending = await runtime.getAutoScan({ background: true });
  assert.equal(pending.status, "scanning");
  assert.deepEqual(pending.candidates, []);

  resolveScan({
    scannedAt: "2026-05-01T00:00:00.000Z",
    candidates: [{ symbol: "BTCUSDT", action: "open_long", confidence: 80 }],
  });
  const ready = await runtime.getAutoScan();

  assert.equal(ready.status, "ready");
  assert.equal(ready.candidates[0].symbol, "BTCUSDT");
});

test("TraderRuntime getTodaySquareNotes fetches and caches today's Square notes", async () => {
  const runtime = createRuntime();
  runtime.getOpenPositionSymbols = async () => ["ETHUSDT"];
  runtime.getCachedAutoScanSymbols = async () => ["BNBUSDT"];
  let calls = 0;
  runtime.squareSource = {
    fetchToday: async ({ symbols }) => {
      calls += 1;
      assert.ok(symbols.includes("BTCUSDT"));
      assert.ok(symbols.includes("ETHUSDT"));
      assert.ok(symbols.includes("BNBUSDT"));
      return {
        date: "2026-05-01",
        timeZone: "Asia/Shanghai",
        fetchedAt: "2026-05-01T00:00:00.000Z",
        sourceErrors: {},
        posts: [
          {
            id: "1",
            title: "ETHUSDT 突破",
            text: "ETHUSDT 突破压力位，看多",
            publishedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      };
    },
  };

  const first = await runtime.getTodaySquareNotes({ symbols: ["BTCUSDT"] });
  const second = await runtime.getTodaySquareNotes({ symbols: ["BTCUSDT"] });

  assert.equal(first.sentiment, "偏多");
  assert.equal(first.postCount, 1);
  assert.equal(second, first);
  assert.equal(calls, 1);
});
