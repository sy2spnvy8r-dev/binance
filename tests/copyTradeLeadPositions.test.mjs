import test from "node:test";
import assert from "node:assert/strict";
import {
  createLeadPositionsSnapshotHash,
  diffLeadPositions,
  normalizeLeadPositions,
  resolveCopyTradeRows,
} from "../src/binance/copyTradeLeadPositions.mjs";
import { formatEventMessage } from "../src/core/eventFormatter.mjs";

test("normalizeLeadPositions keeps only active rows by default", () => {
  const positions = normalizeLeadPositions([
    {
      symbol: "BTCUSDT",
      collateral: "USDT",
      positionSide: "BOTH",
      positionAmount: "0.5",
      entryPrice: "60000",
      breakEvenPrice: "60010",
      markPrice: "61000",
      leverage: 10,
      isolated: true,
      isolatedWallet: "3000",
      notionalValue: "30500",
      unrealizedProfit: "500",
      cumRealized: "100",
      adl: 1,
    },
    {
      symbol: "ETHUSDT",
      collateral: "USDT",
      positionSide: "BOTH",
      positionAmount: "0",
      entryPrice: "0",
      breakEvenPrice: "0",
      markPrice: "3000",
      leverage: 5,
      isolated: false,
      isolatedWallet: "0",
      notionalValue: "0",
      unrealizedProfit: "0",
      cumRealized: "0",
      adl: 0,
    },
  ]);

  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, "BTCUSDT");
  assert.equal(positions[0].direction, "多");
  assert.equal(positions[0].marginMode, "逐仓");
});

test("normalizeLeadPositions supports smart-money style aliases", () => {
  const positions = normalizeLeadPositions([
    {
      symbol: "ETHUSDT",
      side: "SELL",
      amount: "-12.5",
      avgPrice: "1800",
      price: "1750",
      leverage: 20,
      marginType: "ISOLATED",
      margin: "1200",
      positionValue: "21875",
      pnl: "625",
      realizedPnl: "10",
    },
  ]);

  assert.equal(positions.length, 1);
  assert.equal(positions[0].positionSide, "SHORT");
  assert.equal(positions[0].direction, "空");
  assert.equal(positions[0].notionalValue, "21875");
  assert.equal(positions[0].marginMode, "逐仓");
});

test("resolveCopyTradeRows falls back across common response shapes", () => {
  assert.deepEqual(resolveCopyTradeRows({ data: [{ symbol: "BTCUSDT" }] }), [
    { symbol: "BTCUSDT" },
  ]);
  assert.deepEqual(resolveCopyTradeRows({ data: { rows: [{ symbol: "ETHUSDT" }] } }, "data.rows"), [
    { symbol: "ETHUSDT" },
  ]);
  assert.deepEqual(resolveCopyTradeRows({ data: { list: [{ symbol: "SOLUSDT" }] } }, "data"), [
    { symbol: "SOLUSDT" },
  ]);
});

test("diffLeadPositions reports added, changed, and removed rows", () => {
  const previous = [
    {
      key: "BTCUSDT|BOTH",
      symbol: "BTCUSDT",
      positionAmount: "0.5",
      notionalValue: "30500",
      unrealizedProfit: "500",
    },
    {
      key: "ETHUSDT|BOTH",
      symbol: "ETHUSDT",
      positionAmount: "2",
      notionalValue: "6000",
      unrealizedProfit: "50",
    },
  ];
  const current = [
    {
      key: "BTCUSDT|BOTH",
      symbol: "BTCUSDT",
      positionAmount: "0.8",
      notionalValue: "48800",
      unrealizedProfit: "800",
    },
    {
      key: "SOLUSDT|BOTH",
      symbol: "SOLUSDT",
      positionAmount: "10",
      notionalValue: "1500",
      unrealizedProfit: "30",
    },
  ];

  const diff = diffLeadPositions(previous, current);

  assert.equal(diff.added.length, 1);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added[0].symbol, "SOLUSDT");
  assert.equal(diff.changed[0].after.positionAmount, "0.8");
  assert.equal(diff.removed[0].symbol, "ETHUSDT");
});

test("createLeadPositionsSnapshotHash is stable for equal snapshots", () => {
  const snapshot = [
    {
      key: "BTCUSDT|BOTH",
      symbol: "BTCUSDT",
      positionAmount: "0.5",
    },
  ];

  assert.equal(
    createLeadPositionsSnapshotHash(snapshot),
    createLeadPositionsSnapshotHash(snapshot),
  );
});

test("formatEventMessage renders a markdown table for lead positions", () => {
  const message = formatEventMessage(
    {
      e: "copyTradeLeadPositionsSnapshot",
      E: 1710000000000,
      entityLabel: "交易员ID",
      entityValue: "4988811260243579393",
      changeType: "update",
      changes: {
        added: [{ symbol: "SOLUSDT" }],
        changed: [],
        removed: [],
      },
      positions: [
        {
          symbol: "BTCUSDT",
          direction: "多",
          positionAmount: "0.5",
          entryPrice: "60000",
          markPrice: "61000",
          leverage: 10,
          marginMode: "逐仓",
          isolatedWallet: "3000",
          notionalValue: "30500",
          unrealizedProfit: "500",
        },
      ],
    },
    "[Test]",
  );

  assert.match(message, /\[Test\] 跟单仓位变动/);
  assert.match(message, /交易员ID: 4988811260243579393/);
  assert.match(message, /\| 合约 \| 方向 \| 持仓量 \|/);
  assert.match(message, /\| BTCUSDT \| 多 \| 0.5 \|/);
});

test("formatEventMessage renders startup snapshots with dedicated summary", () => {
  const message = formatEventMessage(
    {
      e: "copyTradeLeadPositionsSnapshot",
      E: 1710000000000,
      entityLabel: "交易员ID",
      entityValue: "4988811260243579393",
      changeType: "startup",
      changes: {
        added: [],
        changed: [],
        removed: [],
      },
      positions: [
        {
          symbol: "BTCUSDT",
          direction: "多",
          positionAmount: "0.5",
          entryPrice: "60000",
          markPrice: "61000",
          leverage: 10,
          marginMode: "逐仓",
          isolatedWallet: "3000",
          notionalValue: "30500",
          unrealizedProfit: "500",
        },
      ],
    },
    "[Test]",
  );

  assert.match(message, /变动: 启动快照，共 1 个持仓/);
});
