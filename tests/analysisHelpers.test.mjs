import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSquareText, buildMarketAnalysis } from "../src/trader/analysisHelpers.mjs";

test("buildMarketAnalysis combines futures data into a bullish signal", () => {
  const analysis = buildMarketAnalysis({
    symbol: "BTCUSDT",
    fundingRateHistory: [{ fundingRate: "0.0003", fundingTime: 1710000000000 }],
    openInterest: { openInterest: "1000", time: 1710000000000 },
    openInterestHistories: {
      "5m": [
        { sumOpenInterest: "100", sumOpenInterestValue: "100000", timestamp: "1" },
        { sumOpenInterest: "103", sumOpenInterestValue: "103000", timestamp: "2" },
      ],
      "1h": [
        { sumOpenInterest: "100", sumOpenInterestValue: "100000", timestamp: "1" },
        { sumOpenInterest: "102", sumOpenInterestValue: "102000", timestamp: "2" },
      ],
    },
    longShortRatios: {
      "5m": [{ longShortRatio: "1.2", longAccount: "0.55", shortAccount: "0.45" }],
      "1h": [{ longShortRatio: "1.1", longAccount: "0.52", shortAccount: "0.48" }],
    },
    topTraderRatios: {
      "5m": [{ longShortRatio: "1.3", longAccount: "0.57", shortAccount: "0.43" }],
      "1h": [{ longShortRatio: "1.2", longAccount: "0.55", shortAccount: "0.45" }],
    },
    takerBuySellVolumes: {
      "5m": [{ buySellRatio: "1.3", buyVol: "130", sellVol: "100" }],
      "1h": [{ buySellRatio: "1.1", buyVol: "110", sellVol: "100" }],
    },
  });

  assert.equal(analysis.symbol, "BTCUSDT");
  assert.equal(analysis.signal, "偏多");
  assert.equal(analysis.openInterestChange["5m"].percentChange, 3);
  assert.equal(analysis.fundingRate.rate, "0.0003");
  assert.ok(analysis.reasons.some((reason) => reason.includes("偏多")));
});

test("buildMarketAnalysis marks extreme data as high risk", () => {
  const analysis = buildMarketAnalysis({
    symbol: "ETHUSDT",
    fundingRateHistory: [{ fundingRate: "0.0015" }],
    openInterestHistories: {
      "5m": [
        { sumOpenInterestValue: "100000", timestamp: "1" },
        { sumOpenInterestValue: "112000", timestamp: "2" },
      ],
    },
    longShortRatios: {
      "5m": [{ longShortRatio: "3" }],
    },
    topTraderRatios: {},
    takerBuySellVolumes: {
      "5m": [{ buySellRatio: "2.2" }],
    },
  });

  assert.equal(analysis.signal, "风险偏高");
  assert.ok(analysis.reasons.some((reason) => reason.includes("风险")));
});

test("buildMarketAnalysis tolerates missing market sources", () => {
  const analysis = buildMarketAnalysis({
    symbol: "BNBUSDT",
    sourceErrors: {
      fundingRate: "temporarily unavailable",
    },
  });

  assert.equal(analysis.signal, "震荡");
  assert.deepEqual(analysis.openInterestChange["5m"], null);
  assert.ok(analysis.reasons.includes("分析数据暂不可用"));
});

test("analyzeSquareText extracts manual Binance Square sentiment without persistence", () => {
  const notes = analyzeSquareText("BTCUSDT 突破压力位，看多，但注意高杠杆爆仓风险 https://www.binance.com/square/post/1");

  assert.equal(notes.sentiment, "风险偏高");
  assert.ok(notes.keywords.includes("BTCUSDT"));
  assert.ok(notes.keywords.includes("突破"));
  assert.ok(notes.riskWords.includes("爆仓"));
  assert.equal(notes.sourceType, "link_or_text");
});
