import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCloseQuantityAllowed,
  buildOrderInstruction,
  deriveQuantityFromMargin,
  getCloseableQuantity,
  getSymbolRules,
  validateLimitPrice,
  validateLimitQuantity,
  validateMinNotional,
} from "../src/trader/futuresTradeHelpers.mjs";

const symbolInfo = {
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
};

test("symbol rules validate limit price, quantity, and min notional", () => {
  const rules = getSymbolRules(symbolInfo);

  assert.equal(validateLimitPrice("65000.1", rules), "65000.1");
  assert.equal(validateLimitQuantity("0.002", rules), "0.002");
  assert.equal(validateMinNotional("65000.1", "0.002", rules), "130.0002");

  assert.throws(() => validateLimitPrice("65000.12", rules), /最小变动单位/);
  assert.throws(() => validateLimitQuantity("0.0025", rules), /最小步进/);
  assert.throws(() => validateMinNotional("100", "0.01", rules), /最小下单要求/);
});

test("deriveQuantityFromMargin converts margin to aligned quantity", () => {
  const rules = getSymbolRules(symbolInfo);

  const derived = deriveQuantityFromMargin({
    margin: "10",
    leverage: "10",
    price: "50000",
    rules,
  });

  assert.equal(derived.quantity, "0.002");
  assert.equal(derived.notional, "100");
  assert.equal(derived.estimatedMargin, "10");
});

test("buildOrderInstruction maps intents for one-way and hedge modes", () => {
  assert.deepEqual(
    buildOrderInstruction({
      intent: "open_long",
      symbol: "btcusdt",
      price: "65000.1",
      quantity: "0.01",
      dualSidePosition: false,
    }),
    {
      symbol: "BTCUSDT",
      side: "BUY",
      price: "65000.1",
      quantity: "0.01",
    },
  );

  assert.deepEqual(
    buildOrderInstruction({
      intent: "close_short",
      symbol: "BTCUSDT",
      price: "65000.1",
      quantity: "0.01",
      dualSidePosition: true,
    }),
    {
      symbol: "BTCUSDT",
      side: "BUY",
      positionSide: "SHORT",
      price: "65000.1",
      quantity: "0.01",
    },
  );

  assert.deepEqual(
    buildOrderInstruction({
      intent: "close_long",
      symbol: "BTCUSDT",
      price: "65000.1",
      quantity: "0.01",
      dualSidePosition: false,
    }),
    {
      symbol: "BTCUSDT",
      side: "SELL",
      reduceOnly: "true",
      price: "65000.1",
      quantity: "0.01",
    },
  );
});

test("close quantity checks honor hedge and one-way positions", () => {
  const hedgeAccount = {
    positions: [
      { symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "0.020" },
      { symbol: "BTCUSDT", positionSide: "SHORT", positionAmt: "0.005" },
    ],
  };
  const oneWayAccount = {
    positions: [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "-0.030" }],
  };

  assert.equal(
    getCloseableQuantity({
      accountInfo: hedgeAccount,
      symbol: "BTCUSDT",
      intent: "close_long",
      dualSidePosition: true,
    }),
    "0.02",
  );

  assert.equal(
    getCloseableQuantity({
      accountInfo: oneWayAccount,
      symbol: "BTCUSDT",
      intent: "close_short",
      dualSidePosition: false,
    }),
    "0.03",
  );

  assert.equal(
    assertCloseQuantityAllowed({
      accountInfo: hedgeAccount,
      symbol: "BTCUSDT",
      intent: "close_long",
      quantity: "0.01",
      dualSidePosition: true,
    }),
    "0.02",
  );

  assert.throws(
    () =>
      assertCloseQuantityAllowed({
        accountInfo: oneWayAccount,
        symbol: "BTCUSDT",
        intent: "close_short",
        quantity: "0.05",
        dualSidePosition: false,
      }),
    /最多可平数量/,
  );
});
