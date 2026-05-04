import test from "node:test";
import assert from "node:assert/strict";
import { formatEventMessage, formatSystemMessage } from "../src/core/eventFormatter.mjs";

test("formatEventMessage formats executionReport in Chinese", () => {
  const message = formatEventMessage(
    {
      e: "executionReport",
      E: 1710000000000,
      s: "BTCUSDT",
      x: "TRADE",
      X: "FILLED",
      S: "BUY",
      o: "LIMIT",
      p: "60000",
      q: "0.01",
      l: "0.01",
      L: "60000",
      z: "0.01",
      i: 123456,
      c: "my-order",
    },
    "[Test]",
  );

  assert.match(message, /\[Test\] 检测到订单操作/);
  assert.match(message, /交易对: BTCUSDT/);
  assert.match(message, /类型: 成交 \/ 完全成交/);
});

test("formatSystemMessage prefixes text", () => {
  assert.equal(formatSystemMessage("连接成功", "[Test]"), "[Test] 连接成功");
});
