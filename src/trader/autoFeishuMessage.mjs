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
    case "hold":
      return "观望";
    default:
      return action || "-";
  }
}

const TABLE_REASON_LIMIT = 180;
const DETAIL_REASON_LIMIT = 800;

function cleanReason(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replaceAll("|", "/")
    .trim();
}

function truncateReason(value, limit) {
  const text = cleanReason(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function shortReason(value) {
  return truncateReason(value, TABLE_REASON_LIMIT);
}

function detailReason(value) {
  return truncateReason(value, DETAIL_REASON_LIMIT);
}

function buildReasonDetails(candidates) {
  return candidates
    .slice(0, 8)
    .map((item, index) => {
      const reason = detailReason(item.reason || item.localReason);
      return reason ? `详细理由${index + 1}-${item.symbol}: ${reason}` : null;
    })
    .filter(Boolean);
}

export function createAutoScanFeishuMessage(scan, diagnostics = null) {
  const candidates = scan?.candidates ?? [];
  const timeText = formatDateTime(scan?.scannedAt);
  const modelText = scan?.llmStatus === "ok" ? "LLM analyzed" : scan?.llmStatus || "local";
  const lines = [
    "[监控] 自动分析候选",
    `时间: ${timeText}`,
    `模型状态: ${modelText}`,
    `扫描范围: ${scan?.prefilteredFrom ?? scan?.universeSize ?? 0} -> 深扫 ${scan?.scannedSymbols ?? 0}`,
    `候选记录数: ${candidates.length}`,
    "",
    "| 时间 | 合约 | 操作 | 入场价 | 止损 | 止盈 | 杠杆 | 信心 | 来源 | 理由 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];

  if (diagnostics?.regimeGate) {
    lines.splice(
      5,
      0,
      `策略闸门: ${diagnostics.regimeGate.state} / 风险 ${diagnostics.regimeGate.riskScore} / ${diagnostics.regimeGate.allowNewTrade ? "允许" : "禁止"}`,
    );
  }
  if (diagnostics?.shadowStats) {
    lines.splice(
      diagnostics?.regimeGate ? 6 : 5,
      0,
      `影子盘: 胜率 ${diagnostics.shadowStats.winRate}% / 已平 ${diagnostics.shadowStats.closed} / 回撤 ${diagnostics.shadowStats.maxDrawdownR}R`,
    );
  }

  const tableIndex = lines.findIndex((line) => String(line).startsWith("|"));
  const reasonDetails = buildReasonDetails(candidates);
  if (reasonDetails.length && tableIndex !== -1) {
    lines.splice(tableIndex, 0, ...reasonDetails, "");
  }

  for (const item of candidates) {
    lines.push(
      [
        timeText,
        item.symbol,
        formatAction(item.action || item.intent),
        item.entryPrice ?? item.price ?? "-",
        item.stopLoss || "-",
        item.takeProfit || "-",
        `${item.leverage ?? "-"}x`,
        item.confidence ?? item.localScore ?? "-",
        item.source || "-",
        shortReason(item.reason || item.localReason),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }

  return lines.join("\n");
}
