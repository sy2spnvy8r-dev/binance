import assert from "node:assert/strict";
import test from "node:test";
import { createAutoTradeFeishuMessage } from "../src/trader/autoTradeFeishuMessage.mjs";

test("createAutoTradeFeishuMessage includes placed symbols and current positions only", () => {
  const message = createAutoTradeFeishuMessage({
    accountLabel: "main",
    budget: {
      equityUsdt: "1000",
      availableCapitalUsdt: "800",
      totalRiskUsdt: "10",
      maxTotalRiskUsdt: "100",
    },
    placements: [
      {
        trade: {
          symbol: "BTCUSDT",
          intent: "open_long",
          status: "open",
          marginUsdt: "20",
          quantity: "0.01",
          entryPrice: "65000",
          stopLoss: "64000",
          takeProfit: "67000",
          riskUsdt: "10",
          reason: "LLM analyzed setup",
        },
      },
    ],
    openTrades: [
      {
        symbol: "BTCUSDT",
        intent: "open_long",
        status: "open",
        quantity: "0.01",
        entryPrice: "65000",
        markPrice: "65100",
        unrealizedProfitUsdt: "1",
        stopLoss: "64000",
        riskUsdt: "10",
      },
    ],
  });

  assert.match(message, /本轮下单: BTCUSDT/);
  assert.match(message, /当前自动持仓/);
  assert.match(message, /BTCUSDT/);
  assert.doesNotMatch(message, /候选记录数/);
});
