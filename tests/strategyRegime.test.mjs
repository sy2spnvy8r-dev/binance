import assert from "node:assert/strict";
import test from "node:test";
import { buildStrategyRegime } from "../src/trader/strategyRegime.mjs";

function baseAnalysis(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    signal: "偏多",
    fundingRate: { rate: "0.0001" },
    openInterestChange: {
      "5m": { percentChange: "1" },
      "1h": { percentChange: "2" },
    },
    longShortRatio: {
      "5m": { longShortRatio: "1.2" },
      "1h": { longShortRatio: "1.1" },
    },
    topTraderRatio: {
      "5m": { longShortRatio: "1.2" },
      "1h": { longShortRatio: "1.1" },
    },
    takerBuySell: {
      "5m": { buySellRatio: "1.2" },
      "1h": { buySellRatio: "1.1" },
    },
    sourceErrors: {},
    ...overrides,
  };
}

test("buildStrategyRegime allows matching trend candidates", () => {
  const regime = buildStrategyRegime({
    analysis: baseAnalysis(),
    candidate: { symbol: "BTCUSDT", action: "open_long" },
  });

  assert.equal(regime.state, "趋势多");
  assert.equal(regime.allowNewTrade, true);
});

test("buildStrategyRegime blocks conflicting trend candidates", () => {
  const regime = buildStrategyRegime({
    analysis: baseAnalysis({
      signal: "偏空",
      longShortRatio: {
        "5m": { longShortRatio: "0.8" },
        "1h": { longShortRatio: "0.8" },
      },
      topTraderRatio: {
        "5m": { longShortRatio: "0.8" },
        "1h": { longShortRatio: "0.8" },
      },
      takerBuySell: {
        "5m": { buySellRatio: "0.8" },
        "1h": { buySellRatio: "0.8" },
      },
    }),
    candidate: { symbol: "BTCUSDT", action: "open_long" },
  });

  assert.equal(regime.state, "趋势空");
  assert.equal(regime.allowNewTrade, false);
  assert.match(regime.reasons[0], /冲突/);
});

test("buildStrategyRegime allows small-margin entries in chop", () => {
  const regime = buildStrategyRegime({
    analysis: baseAnalysis({
      signal: "震荡",
      longShortRatio: {
        "5m": { longShortRatio: "1" },
        "1h": { longShortRatio: "1" },
      },
      topTraderRatio: {
        "5m": { longShortRatio: "1" },
        "1h": { longShortRatio: "1" },
      },
      takerBuySell: {
        "5m": { buySellRatio: "1" },
        "1h": { buySellRatio: "1" },
      },
    }),
    candidate: { symbol: "BTCUSDT", action: "open_long" },
  });

  assert.equal(regime.state, "震荡");
  assert.equal(regime.allowNewTrade, true);
  assert.match(regime.reasons[0], /允许/);
});

test("buildStrategyRegime turns extreme conditions into risk-off", () => {
  const regime = buildStrategyRegime({
    analysis: baseAnalysis({
      signal: "风险偏高",
      fundingRate: { rate: "0.002" },
      longShortRatio: {
        "5m": { longShortRatio: "3" },
        "1h": { longShortRatio: "3" },
      },
    }),
    candidate: { symbol: "BTCUSDT", action: "open_short" },
  });

  assert.equal(regime.state, "风险关闭");
  assert.equal(regime.allowNewTrade, false);
  assert.ok(regime.riskScore >= 60);
});
