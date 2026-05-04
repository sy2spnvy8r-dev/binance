import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMarketCandidate, rankMarketCandidates } from "../src/trader/autoIndicators.mjs";

function makeKlines(start, step, length = 80) {
  return Array.from({ length }, (_, index) => {
    const close = start + step * index;
    return [
      1710000000000 + index * 3600000,
      String(close - step / 2),
      String(close + 2),
      String(close - 2),
      String(close),
      String(1000 + index * 10),
    ];
  });
}

test("market candidate analysis scores trend direction", () => {
  const bull = analyzeMarketCandidate({
    symbol: "BULLUSDT",
    ticker: { lastPrice: "120", quoteVolume: "100000000", priceChangePercent: "8" },
    klines: makeKlines(80, 0.5),
    fundingRate: "-0.0001",
    openInterest: "1000",
  });
  const bear = analyzeMarketCandidate({
    symbol: "BEARUSDT",
    ticker: { lastPrice: "80", quoteVolume: "90000000", priceChangePercent: "-7" },
    klines: makeKlines(120, -0.5),
    fundingRate: "0.0008",
    openInterest: "1000",
  });

  assert.equal(bull.intent, "open_long");
  assert.equal(bear.intent, "open_short");
  assert.match(bull.localReason, /24小时涨跌/);
  assert.match(bull.localReason, /RSI/);
  assert.match(bull.localReason, /波动率ATR/);

  const ranked = rankMarketCandidates([bear, bull]);
  assert.equal(ranked[0].localScore >= ranked[1].localScore, true);
});
