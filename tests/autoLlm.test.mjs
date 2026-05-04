import assert from "node:assert/strict";
import test from "node:test";
import { buildLlmMessages, parseLlmDecisions } from "../src/trader/autoLlm.mjs";

const allowedSymbols = new Set(["BTCUSDT", "ETHUSDT"]);

test("parseLlmDecisions accepts strict valid JSON", () => {
  const decisions = parseLlmDecisions(
    JSON.stringify({
      decisions: [
        {
          symbol: "BTCUSDT",
          action: "open_long",
          confidence: 82,
          entryPrice: "65000.1",
          stopLoss: "64000",
          takeProfit: "68000",
          leverage: 20,
          reason: "trend and volume agree",
        },
      ],
    }),
    { allowedSymbols, maxLeverage: 20 },
  );

  assert.equal(decisions[0].symbol, "BTCUSDT");
  assert.equal(decisions[0].action, "open_long");
  assert.equal(decisions[0].confidence, 82);
});

test("parseLlmDecisions rejects unsupported fields and unsafe values", () => {
  assert.throws(
    () =>
      parseLlmDecisions(
        JSON.stringify({
          decisions: [
            {
              symbol: "BTCUSDT",
              action: "open_long",
              confidence: 82,
              entryPrice: "65000.1",
              stopLoss: "64000",
              takeProfit: "68000",
              leverage: 20,
              reason: "ok",
              quantity: "999",
            },
          ],
        }),
        { allowedSymbols, maxLeverage: 20 },
      ),
    /unsupported field/,
  );

  assert.throws(
    () =>
      parseLlmDecisions(
        JSON.stringify({
          decisions: [
            {
              symbol: "BTCUSDT",
              action: "open_long",
              confidence: 82,
              entryPrice: "65000.1",
              stopLoss: "64000",
              takeProfit: "68000",
              leverage: 21,
              reason: "too much leverage",
            },
          ],
        }),
        { allowedSymbols, maxLeverage: 20 },
      ),
    /invalid leverage/,
  );

  assert.throws(
    () =>
      parseLlmDecisions(
        JSON.stringify({
          decisions: [
            {
              symbol: "BTCUSDT",
              action: "open_short",
              confidence: 82,
              stopLoss: "66000",
              takeProfit: "62000",
              leverage: 10,
              reason: "missing entry",
            },
          ],
        }),
        { allowedSymbols, maxLeverage: 20 },
      ),
    /entryPrice/,
  );
});

test("buildLlmMessages asks for Simplified Chinese reasons", () => {
  const messages = buildLlmMessages({
    maxLeverage: 20,
    candidates: [
      {
        symbol: "BTCUSDT",
        localIntent: "open_long",
        localScore: 80,
        reason: "成交量放大",
      },
    ],
  });

  assert.match(messages[0].content, /Simplified Chinese/);
  assert.match(messages[1].content, /Simplified Chinese/);
});
