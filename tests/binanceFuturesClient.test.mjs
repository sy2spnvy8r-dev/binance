import assert from "node:assert/strict";
import test from "node:test";
import { BinanceApiError, BinanceFuturesClient } from "../src/binance/futuresRestClient.mjs";

test("BinanceFuturesClient signs GET requests with api key header", async (context) => {
  const calls = [];
  const originalNow = Date.now;
  Date.now = () => 1710000000000;
  context.after(() => {
    Date.now = originalNow;
  });

  const client = new BinanceFuturesClient({
    apiKey: "demo-key",
    apiSecret: "demo-secret",
    baseUrl: "https://example.com",
    recvWindow: 5000,
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return {
        ok: true,
        text: async () => JSON.stringify({ dualSidePosition: false }),
      };
    },
  });

  const result = await client.getPositionMode();

  assert.deepEqual(result, { dualSidePosition: false });
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["X-MBX-APIKEY"], "demo-key");
  assert.match(calls[0].url, /^https:\/\/example\.com\/fapi\/v1\/positionSide\/dual\?/);
  assert.match(calls[0].url, /recvWindow=5000/);
  assert.match(calls[0].url, /timestamp=1710000000000/);
  assert.match(calls[0].url, /signature=/);
});

test("BinanceFuturesClient sends signed POST body for leverage changes", async (context) => {
  const calls = [];
  const originalNow = Date.now;
  Date.now = () => 1710000000000;
  context.after(() => {
    Date.now = originalNow;
  });

  const client = new BinanceFuturesClient({
    apiKey: "demo-key",
    apiSecret: "demo-secret",
    baseUrl: "https://example.com",
    recvWindow: 5000,
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            symbol: "BTCUSDT",
            leverage: 20,
            maxNotionalValue: "1000000",
          }),
      };
    },
  });

  const result = await client.changeLeverage({ symbol: "BTCUSDT", leverage: 20 });

  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].init.headers["Content-Type"],
    "application/x-www-form-urlencoded;charset=UTF-8",
  );
  assert.match(calls[0].init.body, /symbol=BTCUSDT/);
  assert.match(calls[0].init.body, /leverage=20/);
  assert.match(calls[0].init.body, /recvWindow=5000/);
  assert.match(calls[0].init.body, /timestamp=1710000000000/);
  assert.match(calls[0].init.body, /signature=/);
});

test("BinanceFuturesClient surfaces Binance error payloads", async () => {
  const client = new BinanceFuturesClient({
    apiKey: "demo-key",
    apiSecret: "demo-secret",
    baseUrl: "https://example.com",
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () =>
        JSON.stringify({
          code: -2010,
          msg: "Order would immediately trigger.",
        }),
    }),
  });

  await assert.rejects(
    () => client.changeLeverage({ symbol: "BTCUSDT", leverage: 20 }),
    (error) => {
      assert.ok(error instanceof BinanceApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, -2010);
      assert.equal(error.details.msg, "Order would immediately trigger.");
      return true;
    },
  );
});

test("BinanceFuturesClient fetches public analysis endpoints", async () => {
  const calls = [];
  const client = new BinanceFuturesClient({
    baseUrl: "https://example.com",
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return {
        ok: true,
        text: async () => JSON.stringify({ ok: true }),
      };
    },
  });

  await client.getOpenInterest({ symbol: "BTCUSDT" });
  await client.getOpenInterestHistory({ symbol: "BTCUSDT", period: "1h", limit: 2 });
  await client.getGlobalLongShortRatio({ symbol: "BTCUSDT", period: "5m", limit: 1 });
  await client.getTopTraderLongShortRatio({ symbol: "BTCUSDT", period: "5m", limit: 1 });
  await client.getTakerBuySellVolume({ symbol: "BTCUSDT", period: "5m", limit: 1 });
  await client.getFundingRateHistory({ symbol: "BTCUSDT", limit: 1 });

  assert.match(calls[0].url, /^https:\/\/example\.com\/fapi\/v1\/openInterest\?symbol=BTCUSDT$/);
  assert.match(calls[1].url, /\/futures\/data\/openInterestHist\?/);
  assert.match(calls[2].url, /\/futures\/data\/globalLongShortAccountRatio\?/);
  assert.match(calls[3].url, /\/futures\/data\/topLongShortPositionRatio\?/);
  assert.match(calls[4].url, /\/futures\/data\/takerlongshortRatio\?/);
  assert.match(calls[5].url, /\/fapi\/v1\/fundingRate\?/);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["X-MBX-APIKEY"], undefined);
});

test("BinanceFuturesClient fetches auto analyzer market endpoints", async () => {
  const calls = [];
  const client = new BinanceFuturesClient({
    baseUrl: "https://example.com",
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return {
        ok: true,
        text: async () => JSON.stringify([]),
      };
    },
  });

  await client.get24hTickers();
  await client.getFundingRates();
  await client.getKlines({ symbol: "BTCUSDT", interval: "1h", limit: 120 });

  assert.match(calls[0].url, /^https:\/\/example\.com\/fapi\/v1\/ticker\/24hr$/);
  assert.match(calls[1].url, /^https:\/\/example\.com\/fapi\/v1\/premiumIndex$/);
  assert.match(calls[2].url, /\/fapi\/v1\/klines\?/);
  assert.match(calls[2].url, /symbol=BTCUSDT/);
  assert.match(calls[2].url, /interval=1h/);
  assert.match(calls[2].url, /limit=120/);
});

test("BinanceFuturesClient creates protective close orders", async () => {
  const calls = [];
  const client = new BinanceFuturesClient({
    apiKey: "demo-key",
    apiSecret: "demo-secret",
    baseUrl: "https://example.com",
    dryRun: true,
    fetchImpl: async () => {
      throw new Error("dry-run should not fetch");
    },
  });

  calls.push(
    await client.createStopMarketOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      positionSide: "LONG",
      stopPrice: "64000",
    }),
  );
  calls.push(
    await client.createTakeProfitMarketOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      positionSide: "LONG",
      stopPrice: "68000",
    }),
  );

  assert.equal(calls[0].dryRun, true);
  assert.match(calls[0].url, /\/fapi\/v1\/algoOrder$/);
  assert.match(calls[0].body, /algoType=CONDITIONAL/);
  assert.match(calls[0].body, /type=STOP_MARKET/);
  assert.match(calls[0].body, /closePosition=true/);
  assert.match(calls[0].body, /workingType=MARK_PRICE/);
  assert.match(calls[1].body, /type=TAKE_PROFIT_MARKET/);
  assert.match(calls[1].body, /triggerPrice=68000/);
});

test("BinanceFuturesClient creates partial take-profit and trailing algo orders", async () => {
  const client = new BinanceFuturesClient({
    apiKey: "demo-key",
    apiSecret: "demo-secret",
    baseUrl: "https://example.com",
    dryRun: true,
    fetchImpl: async () => {
      throw new Error("dry-run should not fetch");
    },
  });

  const takeProfit = await client.createTakeProfitMarketOrder({
    symbol: "BTCUSDT",
    side: "SELL",
    positionSide: "BOTH",
    quantity: "0.01",
    reduceOnly: "true",
    stopPrice: "66000",
  });
  const trailing = await client.createTrailingStopMarketOrder({
    symbol: "BTCUSDT",
    side: "SELL",
    positionSide: "BOTH",
    quantity: "0.02",
    reduceOnly: "true",
    activatePrice: "67000",
    callbackRate: "0.8",
  });

  assert.match(takeProfit.body, /type=TAKE_PROFIT_MARKET/);
  assert.match(takeProfit.body, /quantity=0.01/);
  assert.doesNotMatch(takeProfit.body, /closePosition=true/);
  assert.match(takeProfit.body, /reduceOnly=true/);
  assert.match(trailing.body, /type=TRAILING_STOP_MARKET/);
  assert.match(trailing.body, /quantity=0.02/);
  assert.match(trailing.body, /activatePrice=67000/);
  assert.match(trailing.body, /callbackRate=0.8/);
});
