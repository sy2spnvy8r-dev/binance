function formatDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (item) => String(item).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("/") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatAction(action) {
  switch (action) {
    case "open_long":
      return "做多";
    case "open_short":
      return "做空";
    default:
      return action || "-";
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").replaceAll("|", "/").trim();
}

function shortText(value, limit = 160) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function renderTradesTable(trades) {
  const lines = [
    "| 合约 | 方向 | 状态 | 保证金 | 数量 | 入场 | 止损 | 止盈 | 风险 | 理由 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const trade of trades ?? []) {
    lines.push(
      [
        trade.symbol,
        formatAction(trade.intent || trade.action),
        trade.status || "-",
        `${trade.marginUsdt ?? "-"}U`,
        trade.protectionQuantity || trade.quantity || "-",
        trade.entryPrice ?? "-",
        trade.stopLoss ?? "-",
        trade.takeProfit ?? "-",
        trade.riskUsdt ? `${trade.riskUsdt}U` : "-",
        shortText(trade.reason || "-"),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }

  return lines;
}

function renderPositionsTable(trades) {
  const active = (trades ?? []).filter((trade) => ["pending", "open"].includes(trade.status));
  if (!active.length) {
    return ["当前自动持仓: 暂无"];
  }

  const lines = [
    "| 合约 | 方向 | 状态 | 数量 | 入场 | 标记 | 未实现 | 止损 | 风险 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const trade of active) {
    lines.push(
      [
        trade.symbol,
        formatAction(trade.intent || trade.action),
        trade.status || "-",
        trade.protectionQuantity || trade.quantity || "-",
        trade.entryPrice ?? "-",
        trade.markPrice ?? "-",
        trade.unrealizedProfitUsdt ? `${trade.unrealizedProfitUsdt}U` : "-",
        trade.stopLoss ?? "-",
        trade.riskUsdt ? `${trade.riskUsdt}U` : "-",
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }

  return lines;
}

export function createAutoTradeFeishuMessage({ accountLabel, placements = [], openTrades = [], budget = {}, at = new Date() } = {}) {
  const placedTrades = placements.map((placement) => placement.trade ?? placement).filter(Boolean);
  const lines = [
    "[真实盘] 自动下单通知",
    `账户: ${accountLabel || "default"}`,
    `时间: ${formatDateTime(at)}`,
    `本轮下单: ${placedTrades.map((trade) => trade.symbol).join(", ") || "无"}`,
    `资金: 权益 ${budget.equityUsdt ?? "-"}U / 可用 ${budget.availableCapitalUsdt ?? "-"}U / 总风险 ${budget.totalRiskUsdt ?? "-"}U / 上限 ${budget.maxTotalRiskUsdt ?? "-"}U`,
    "",
    "本轮下单明细:",
    ...renderTradesTable(placedTrades),
    "",
    "当前自动持仓:",
    ...renderPositionsTable(openTrades),
  ];

  return lines.join("\n");
}
