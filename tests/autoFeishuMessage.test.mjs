import assert from "node:assert/strict";
import test from "node:test";
import { createAutoScanFeishuMessage } from "../src/trader/autoFeishuMessage.mjs";
import { createFeishuPayload } from "../src/notifiers/feishuMessageFormatter.mjs";

test("createAutoScanFeishuMessage renders a Feishu table-friendly message", () => {
  const message = createAutoScanFeishuMessage({
    scannedAt: "2026-04-30T10:07:26.000Z",
    universeSize: 528,
    prefilteredFrom: 528,
    scannedSymbols: 30,
    llmStatus: "ok",
    candidates: [
      {
        symbol: "BIOUSDT",
        action: "open_long",
        entryPrice: "0.04273742",
        stopLoss: "0.0400",
        takeProfit: "0.0460",
        leverage: 20,
        confidence: 82,
        source: "llm",
        reason:
          "trend and volume agree; funding is calm; open interest expands; taker buy volume improves; this tail should remain visible in the detailed reason block",
      },
    ],
  });
  const payload = createFeishuPayload(message, "interactive_table");

  assert.match(message, /^\[监控\] 自动分析候选/);
  assert.match(message, /候选记录数: 1/);
  assert.match(message, /this tail should remain visible/);
  assert.equal(payload.msg_type, "interactive");
  assert.equal(payload.card.body.elements[1].tag, "table");
  assert.equal(payload.card.body.elements[1].rows[0].col_1, "BIOUSDT");
  assert.equal(payload.card.body.elements[1].rows[0].col_2, "做多");
});
