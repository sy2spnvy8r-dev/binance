import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuPayload } from "../src/notifiers/feishuMessageFormatter.mjs";

test("createFeishuPayload builds an interactive card for table messages", () => {
  const payload = createFeishuPayload(
    [
      "[监控] 跟单仓位变动",
      "时间: 2026/4/24 00:57:21",
      "交易员ID: 4988811260243579393",
      "变动: 变化 8",
      "当前持仓数: 9",
      "",
      "| 合约 | 方向 | 持仓量 |",
      "| --- | --- | ---: |",
      "| BTCUSDT | 多 | 0.634 |",
      "| ETHUSDT | 空 | 12.5 |",
    ].join("\n"),
  );

  assert.equal(payload.msg_type, "interactive");
  assert.equal(payload.card.schema, "2.0");
  assert.equal(payload.card.header.title.content, "[监控] 跟单仓位变动");
  assert.match(payload.card.body.elements[0].content, /\*\*时间\*\*/);
  assert.equal(payload.card.body.elements[1].tag, "table");
  assert.equal(payload.card.body.elements[1].columns[0].display_name, "合约");
  assert.equal(payload.card.body.elements[1].rows[0].col_0, "BTCUSDT");
});

test("createFeishuPayload can still emit text payloads", () => {
  const payload = createFeishuPayload("hello", "text");

  assert.deepEqual(payload, {
    msg_type: "text",
    content: {
      text: "hello",
    },
  });
});
