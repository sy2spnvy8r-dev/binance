import assert from "node:assert/strict";
import test from "node:test";
import { SquareDailySource, extractPostsFromPayload } from "../src/trader/squareDailySource.mjs";
import { buildSquareNotes, normalizeSquareSymbols } from "../src/trader/squareSentiment.mjs";

test("extractPostsFromPayload finds nested Binance Square-like posts", () => {
  const posts = extractPostsFromPayload({
    data: {
      rows: [
        {
          postId: "1",
          title: "BTCUSDT 突破",
          content: "BTCUSDT 今日突破压力位，看多",
          publishTime: 1777564800000,
          url: "/en/square/post/1",
        },
      ],
    },
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, "1");
  assert.equal(posts[0].title, "BTCUSDT 突破");
  assert.equal(posts[0].link, "https://www.binance.com/en/square/post/1");
});

test("SquareDailySource filters today posts by symbol and tolerates source failures", async () => {
  const source = new SquareDailySource({
    sourceUrls: ["https://example.com/square"],
    timeZone: "Asia/Shanghai",
    now: () => new Date("2026-05-01T12:00:00+08:00"),
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get: () => "application/json",
      },
      text: async () =>
        JSON.stringify({
          data: [
            {
              postId: "today",
              title: "BTCUSDT 看多",
              content: "BTCUSDT 资金回流，突破后看多",
              publishTime: "2026-05-01T10:30:00+08:00",
            },
            {
              postId: "old",
              title: "ETHUSDT 昨天",
              content: "ETHUSDT 昨天内容",
              publishTime: "2026-04-30T10:30:00+08:00",
            },
          ],
        }),
    }),
  });

  const result = await source.fetchToday({ symbols: ["BTCUSDT"] });

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].id, "today");
  assert.equal(result.date, "2026-05-01");
});

test("buildSquareNotes aggregates post sentiment", () => {
  const notes = buildSquareNotes({
    symbols: ["BTCUSDT"],
    posts: [
      {
        id: "1",
        title: "BTCUSDT 突破",
        text: "BTCUSDT 突破，看多",
        publishedAt: "2026-05-01T10:30:00+08:00",
      },
    ],
  });

  assert.equal(notes.sentiment, "偏多");
  assert.equal(notes.postCount, 1);
  assert.ok(notes.keywords.includes("BTCUSDT"));
});

test("normalizeSquareSymbols keeps only valid USDT symbols", () => {
  assert.deepEqual(
    normalizeSquareSymbols(["BTC", "$ETH", "#1000PEPE", "龙虾", "BTCUSDT"]),
    ["BTCUSDT", "ETHUSDT", "1000PEPEUSDT"],
  );
});
