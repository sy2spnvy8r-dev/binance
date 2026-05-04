import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sanitizeAuditPayload, StrategyAuditLogger } from "../src/trader/strategyAudit.mjs";

async function createAuditFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-audit-"));
  return path.join(dir, "audit.jsonl");
}

test("StrategyAuditLogger appends sanitized events and summarizes skips", async () => {
  const filePath = await createAuditFile();
  const logger = new StrategyAuditLogger({ filePath });

  await logger.append("auto_trade_skipped", {
    reason: "risk off",
    apiKey: "secret-key",
    nested: { apiSecret: "secret-value" },
  });
  const raw = await fs.readFile(filePath, "utf8");
  const summary = await logger.getSummary();

  assert.doesNotMatch(raw, /secret-key|secret-value/);
  assert.match(raw, /\[redacted\]/);
  assert.equal(summary.byType.auto_trade_skipped, 1);
  assert.equal(summary.skipReasons["risk off"], 1);
});

test("sanitizeAuditPayload redacts sensitive keys recursively", () => {
  assert.deepEqual(sanitizeAuditPayload({ webhookUrl: "x", safe: "ok" }), {
    webhookUrl: "[redacted]",
    safe: "ok",
  });
});
