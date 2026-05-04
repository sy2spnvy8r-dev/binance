import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StrategyShadowBook } from "../src/trader/strategyShadow.mjs";

async function createShadowFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-shadow-"));
  return path.join(dir, "shadow.json");
}

test("StrategyShadowBook records candidates and updates wins", async () => {
  const book = new StrategyShadowBook({
    filePath: await createShadowFile(),
    defaultNotionalUsdt: 100,
    feeRate: 0.0005,
  });
  await book.recordScan(
    {
      scannedAt: "2026-05-04T00:00:00.000Z",
      candidates: [
        {
          symbol: "BTCUSDT",
          action: "open_long",
          confidence: 80,
          entryPrice: "100",
          stopLoss: "95",
          takeProfit: "110",
          leverage: 5,
          source: "llm",
        },
      ],
    },
    { regime: { state: "震荡" } },
  );
  await book.updateOpenTrades({
    get24hTickers: async () => ({ lastPrice: "111" }),
  });
  const stats = await book.getStats();

  assert.equal(stats.total, 1);
  assert.equal(stats.closed, 1);
  assert.equal(stats.wins, 1);
  assert.equal(stats.winRate, 100);
  assert.equal(stats.feeEstimateUsdt, 0.1);
  assert.equal(stats.groups.byDirection["做多"].wins, 1);
  assert.equal(stats.groups.byRegime["震荡"].wins, 1);
  assert.equal(stats.groups.bySource.llm.wins, 1);
  assert.equal(stats.groups.byConfidence["80-89"].wins, 1);
});

test("StrategyShadowBook avoids duplicate open candidate keys", async () => {
  const book = new StrategyShadowBook({ filePath: await createShadowFile() });
  const scan = {
    candidates: [
      {
        symbol: "ETHUSDT",
        action: "open_short",
        entryPrice: "100",
        stopLoss: "105",
        takeProfit: "90",
      },
    ],
  };

  await book.recordScan(scan);
  await book.recordScan(scan);
  const stats = await book.getStats();

  assert.equal(stats.total, 1);
  assert.equal(stats.open, 1);
});
