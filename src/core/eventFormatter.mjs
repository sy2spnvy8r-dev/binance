function formatNumber(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toString() : String(value);
}

function formatTime(timestamp) {
  if (!timestamp) {
    return new Date().toLocaleString("zh-CN");
  }

  return new Date(Number(timestamp)).toLocaleString("zh-CN", {
    hour12: false,
  });
}

function translateExecutionType(type) {
  const map = {
    NEW: "新挂单",
    CANCELED: "取消订单",
    REPLACED: "改单",
    REJECTED: "下单被拒绝",
    TRADE: "成交",
    EXPIRED: "订单过期",
    TRADE_PREVENTION: "触发自成交保护",
  };

  return map[type] ?? type;
}

function translateOrderStatus(status) {
  const map = {
    NEW: "未成交",
    PARTIALLY_FILLED: "部分成交",
    FILLED: "完全成交",
    CANCELED: "已取消",
    PENDING_CANCEL: "取消中",
    REJECTED: "已拒绝",
    EXPIRED: "已过期",
    EXPIRED_IN_MATCH: "撮合中过期",
  };

  return map[status] ?? status;
}

function formatBalances(balances = []) {
  if (!Array.isArray(balances) || balances.length === 0) {
    return "无余额变化详情";
  }

  return balances
    .map(
      (balance) =>
        `${balance.a}: 可用 ${formatNumber(balance.f)}, 冻结 ${formatNumber(balance.l)}`,
    )
    .join("；");
}

function formatLeadPositionChanges(event) {
  if (event.changeType === "initial") {
    return `首次基线，共 ${event.positions.length} 个持仓`;
  }

  if (event.changeType === "startup") {
    return `启动快照，共 ${event.positions.length} 个持仓`;
  }

  const parts = [];

  if (event.changes.added.length > 0) {
    parts.push(`新增 ${event.changes.added.length}`);
  }

  if (event.changes.changed.length > 0) {
    parts.push(`变化 ${event.changes.changed.length}`);
  }

  if (event.changes.removed.length > 0) {
    parts.push(`平仓 ${event.changes.removed.length}`);
  }

  return parts.join("，") || "仓位有更新";
}

function formatEntityLine(event) {
  const label = event.entityLabel ?? "监控对象";
  const value = event.entityValue ?? "-";
  return `${label}: ${value}`;
}

function formatLeadPositionTable(positions) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return "当前无持仓";
  }

  const header = [
    "| 合约 | 方向 | 持仓量 | 开仓价 | 标记价 | 杠杆 | 模式 | 保证金 | 名义价值 | 未实现盈亏 |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
  ];

  const rows = positions.map((position) =>
    [
      position.symbol,
      position.direction,
      position.positionAmount,
      position.entryPrice,
      position.markPrice,
      `${position.leverage}x`,
      position.marginMode,
      position.isolatedWallet,
      position.notionalValue,
      position.unrealizedProfit,
    ].join(" | "),
  );

  return [...header, ...rows.map((row) => `| ${row} |`)].join("\n");
}

export function formatEventMessage(event, prefix = "[Binance Monitor]") {
  switch (event.e) {
    case "executionReport":
      return [
        `${prefix} 检测到订单操作`,
        `时间: ${formatTime(event.E ?? event.T ?? Date.now())}`,
        `类型: ${translateExecutionType(event.x)} / ${translateOrderStatus(event.X)}`,
        `交易对: ${event.s}`,
        `方向: ${event.S}`,
        `订单类型: ${event.o}`,
        `价格: ${formatNumber(event.p)}`,
        `下单数量: ${formatNumber(event.q)}`,
        `本次成交: ${formatNumber(event.l)} @ ${formatNumber(event.L)}`,
        `累计成交: ${formatNumber(event.z)}`,
        `订单号: ${event.i}`,
        `客户端单号: ${event.c}`,
      ].join("\n");
    case "balanceUpdate":
      return [
        `${prefix} 检测到资金变动`,
        `时间: ${formatTime(event.E ?? event.T ?? Date.now())}`,
        `资产: ${event.a}`,
        `变化: ${formatNumber(event.d)}`,
        `清算时间: ${formatTime(event.T ?? event.E ?? Date.now())}`,
      ].join("\n");
    case "outboundAccountPosition":
      return [
        `${prefix} 检测到账户余额更新`,
        `时间: ${formatTime(event.E ?? event.u ?? Date.now())}`,
        `详情: ${formatBalances(event.B)}`,
      ].join("\n");
    case "externalLockUpdate":
      return [
        `${prefix} 检测到外部锁仓变化`,
        `时间: ${formatTime(event.E ?? event.T ?? Date.now())}`,
        `资产: ${event.a}`,
        `变化: ${formatNumber(event.d)}`,
        `事务时间: ${formatTime(event.T ?? event.E ?? Date.now())}`,
      ].join("\n");
    case "eventStreamTerminated":
      return [
        `${prefix} 用户数据流已终止`,
        `时间: ${formatTime(event.E ?? Date.now())}`,
        `原因: 收到 eventStreamTerminated 事件，监控器会自动重连`,
      ].join("\n");
    case "copyTradeLeadPositionsSnapshot":
      return [
        `${prefix} 跟单仓位变动`,
        `时间: ${formatTime(event.E ?? Date.now())}`,
        formatEntityLine(event),
        `变动: ${formatLeadPositionChanges(event)}`,
        `当前持仓数: ${event.positions.length}`,
        "",
        formatLeadPositionTable(event.positions),
      ].join("\n");
    default:
      return [
        `${prefix} 检测到未分类事件`,
        `时间: ${formatTime(event.E ?? Date.now())}`,
        `事件类型: ${event.e ?? "unknown"}`,
        `原始内容: ${JSON.stringify(event)}`,
      ].join("\n");
  }
}

export function formatSystemMessage(message, prefix = "[Binance Monitor]") {
  return `${prefix} ${message}`;
}
