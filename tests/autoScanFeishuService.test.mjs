import assert from "node:assert/strict";
import test from "node:test";
import { AutoScanFeishuService } from "../src/trader/autoScanFeishuService.mjs";

test("AutoScanFeishuService sends scan result to notifier", async () => {
  const sent = [];
  let scans = 0;
  const service = new AutoScanFeishuService({
    runtime: {
      getAutoScan: async (options) => {
        scans += 1;
        assert.deepEqual(options, { forceRefresh: false });
        return {
          scannedAt: "2026-05-01T00:00:00.000Z",
          universeSize: 1,
          scannedSymbols: 1,
          candidates: [
            {
              symbol: "BTCUSDT",
              action: "open_long",
              confidence: 80,
              entryPrice: "65000",
            },
          ],
        };
      },
    },
    config: {
      enabled: true,
      webhookUrl: "https://example.com/webhook",
      messageStyle: "interactive_table",
      intervalMs: 900000,
    },
    notifier: {
      send: async (message) => {
        sent.push(message);
      },
    },
    logger: {
      log() {},
      error() {},
    },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });

  const result = await service.runOnce();

  assert.equal(result.ok, true);
  assert.equal(result.candidateCount, 1);
  assert.equal(scans, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /BTCUSDT/);
});

test("AutoScanFeishuService does not start when disabled", () => {
  let scheduled = false;
  const service = new AutoScanFeishuService({
    runtime: {},
    config: {
      enabled: false,
      webhookUrl: "https://example.com/webhook",
      intervalMs: 900000,
    },
    notifier: {
      send: async () => {},
    },
    logger: {
      log() {},
      error() {},
    },
    setTimeoutImpl: () => {
      scheduled = true;
    },
    clearTimeoutImpl: () => {},
  });

  assert.equal(service.start(), false);
  assert.equal(scheduled, false);
});
