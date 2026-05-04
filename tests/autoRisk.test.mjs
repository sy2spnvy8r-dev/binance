import assert from "node:assert/strict";
import test from "node:test";
import { buildAutoOrderInput, divideDecimalStrings, floorToStep } from "../src/trader/autoRisk.mjs";

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

test("auto risk helpers divide and align decimals", () => {
  assert.equal(divideDecimalStrings("100", "65000.1", 12), "0.001538459171");
  assert.equal(floorToStep("65000.19", "0.1"), "65000.1");
  assert.equal(floorToStep("0.001538459171", "0.001"), "0.001");
});

test("buildAutoOrderInput converts 100 USDT notional into a valid limit order", () => {
  const order = buildAutoOrderInput({
    decision: {
      action: "open_long",
      entryPrice: "65000.19",
      leverage: 20,
    },
    rules,
    orderNotionalUsdt: "100",
    maxLeverage: 20,
  });

  assert.deepEqual(order, {
    intent: "open_long",
    symbol: "BTCUSDT",
    quantity: "0.001",
    price: "65000.1",
    leverage: "20",
    notional: "65.0001",
    requestedNotional: "100",
    actualNotional: "65.0001",
  });
});

test("buildAutoOrderInput rejects leverage over the configured maximum", () => {
  assert.throws(
    () =>
      buildAutoOrderInput({
        decision: {
          action: "open_short",
          entryPrice: "65000.1",
          leverage: 21,
        },
        rules,
        orderNotionalUsdt: "100",
        maxLeverage: 20,
      }),
    /invalid leverage/,
  );
});
