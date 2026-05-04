import {
  absDecimalString,
  compareDecimalStrings,
  divideDecimalStrings,
  floorDecimalToStep,
  isStepAligned,
  multiplyDecimalStrings,
  normalizeDecimalString,
} from "./decimal.mjs";

function hasNonZeroValue(value) {
  return compareDecimalStrings(value ?? "0", "0") !== 0;
}

function isCloseIntent(intent) {
  return intent === "close_long" || intent === "close_short";
}

export function buildSymbolIndex(exchangeInfo) {
  const index = new Map();
  for (const symbolInfo of exchangeInfo?.symbols ?? []) {
    index.set(symbolInfo.symbol, symbolInfo);
  }

  return index;
}

export function getSymbolInfo(symbolIndex, rawSymbol) {
  const symbol = String(rawSymbol ?? "").trim().toUpperCase();
  if (!symbol) {
    throw new Error("请输入交易对，例如 BTCUSDT。");
  }

  const symbolInfo = symbolIndex.get(symbol);
  if (!symbolInfo) {
    throw new Error(`未找到交易对 ${symbol}。`);
  }

  if (symbolInfo.status !== "TRADING") {
    throw new Error(`${symbol} 当前不可交易，状态为 ${symbolInfo.status}。`);
  }

  return symbolInfo;
}

export function getSymbolRules(symbolInfo) {
  const filterMap = new Map((symbolInfo.filters ?? []).map((item) => [item.filterType, item]));
  const priceFilter = filterMap.get("PRICE_FILTER");
  const lotSize = filterMap.get("LOT_SIZE");
  const minNotional = filterMap.get("MIN_NOTIONAL");

  if (!priceFilter || !lotSize) {
    throw new Error(`${symbolInfo.symbol} 缺少必要的交易规则。`);
  }

  return {
    symbol: symbolInfo.symbol,
    tickSize: priceFilter.tickSize,
    minPrice: priceFilter.minPrice,
    maxPrice: priceFilter.maxPrice,
    stepSize: lotSize.stepSize,
    minQty: lotSize.minQty,
    maxQty: lotSize.maxQty,
    minNotional: minNotional?.notional ?? "0",
    baseAsset: symbolInfo.baseAsset ?? "",
    quoteAsset: symbolInfo.quoteAsset ?? "",
    marginAsset: symbolInfo.marginAsset ?? symbolInfo.quoteAsset ?? "",
  };
}

export function validatePositiveDecimal(value, label) {
  const normalized = normalizeDecimalString(value);
  if (compareDecimalStrings(normalized, "0") <= 0) {
    throw new Error(`${label} 必须大于 0。`);
  }

  return normalized;
}

export function validateLimitPrice(rawPrice, rules) {
  const price = validatePositiveDecimal(rawPrice, "价格");

  if (compareDecimalStrings(price, rules.minPrice) < 0) {
    throw new Error(`价格不能低于 ${rules.minPrice}。`);
  }

  if (rules.maxPrice && compareDecimalStrings(price, rules.maxPrice) > 0) {
    throw new Error(`价格不能高于 ${rules.maxPrice}。`);
  }

  if (!isStepAligned(price, rules.tickSize)) {
    throw new Error(`价格必须符合最小变动单位 ${rules.tickSize}。`);
  }

  return price;
}

export function validateLimitQuantity(rawQuantity, rules) {
  const quantity = validatePositiveDecimal(rawQuantity, "数量");

  if (compareDecimalStrings(quantity, rules.minQty) < 0) {
    throw new Error(`数量不能小于 ${rules.minQty}。`);
  }

  if (rules.maxQty && compareDecimalStrings(quantity, rules.maxQty) > 0) {
    throw new Error(`数量不能大于 ${rules.maxQty}。`);
  }

  if (!isStepAligned(quantity, rules.stepSize)) {
    throw new Error(`数量必须符合最小步进 ${rules.stepSize}。`);
  }

  return quantity;
}

export function validateMinNotional(price, quantity, rules) {
  const notional = multiplyDecimalStrings(price, quantity);

  if (
    rules.minNotional &&
    compareDecimalStrings(rules.minNotional, "0") > 0 &&
    compareDecimalStrings(notional, rules.minNotional) < 0
  ) {
    throw new Error(`名义价值 ${notional} 低于最小下单要求 ${rules.minNotional}。`);
  }

  return notional;
}

export function deriveQuantityFromMargin({ margin, leverage, price, rules }) {
  const normalizedMargin = validatePositiveDecimal(margin, "保证金");
  const normalizedLeverage = validatePositiveDecimal(leverage, "杠杆");
  const targetNotional = multiplyDecimalStrings(normalizedMargin, normalizedLeverage);
  const rawQuantity = divideDecimalStrings(targetNotional, price, 18);
  const flooredQuantity = floorDecimalToStep(rawQuantity, rules.stepSize);

  if (compareDecimalStrings(flooredQuantity, "0") <= 0) {
    throw new Error("保证金太小，换算后的下单数量不足最小步进。");
  }

  const quantity = validateLimitQuantity(flooredQuantity, rules);
  const notional = validateMinNotional(price, quantity, rules);
  const estimatedMargin = divideDecimalStrings(notional, normalizedLeverage, 18);

  return {
    margin: normalizedMargin,
    leverage: normalizedLeverage,
    targetNotional,
    quantity,
    notional,
    estimatedMargin,
  };
}

export function buildOrderInstruction({ intent, symbol, price, quantity, dualSidePosition }) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  switch (intent) {
    case "open_long":
      return dualSidePosition
        ? { symbol: normalizedSymbol, side: "BUY", positionSide: "LONG", price, quantity }
        : { symbol: normalizedSymbol, side: "BUY", price, quantity };
    case "open_short":
      return dualSidePosition
        ? { symbol: normalizedSymbol, side: "SELL", positionSide: "SHORT", price, quantity }
        : { symbol: normalizedSymbol, side: "SELL", price, quantity };
    case "close_long":
      return dualSidePosition
        ? { symbol: normalizedSymbol, side: "SELL", positionSide: "LONG", price, quantity }
        : { symbol: normalizedSymbol, side: "SELL", reduceOnly: "true", price, quantity };
    case "close_short":
      return dualSidePosition
        ? { symbol: normalizedSymbol, side: "BUY", positionSide: "SHORT", price, quantity }
        : { symbol: normalizedSymbol, side: "BUY", reduceOnly: "true", price, quantity };
    default:
      throw new Error(`不支持的交易意图: ${intent}`);
  }
}

export function getCloseableQuantity({ accountInfo, symbol, intent, dualSidePosition }) {
  if (!isCloseIntent(intent)) {
    return "0";
  }

  const positions = accountInfo?.positions ?? [];
  if (dualSidePosition) {
    const targetSide = intent === "close_long" ? "LONG" : "SHORT";
    const targetPosition = positions.find(
      (item) => item.symbol === symbol && item.positionSide === targetSide,
    );
    return targetPosition ? absDecimalString(targetPosition.positionAmt ?? "0") : "0";
  }

  const netPosition = positions.find((item) => item.symbol === symbol);
  if (!netPosition) {
    return "0";
  }

  const positionAmount = normalizeDecimalString(netPosition.positionAmt ?? "0");
  if (intent === "close_long" && compareDecimalStrings(positionAmount, "0") > 0) {
    return positionAmount;
  }

  if (intent === "close_short" && compareDecimalStrings(positionAmount, "0") < 0) {
    return absDecimalString(positionAmount);
  }

  return "0";
}

export function assertCloseQuantityAllowed({
  accountInfo,
  symbol,
  intent,
  quantity,
  dualSidePosition,
}) {
  const closeableQuantity = getCloseableQuantity({
    accountInfo,
    symbol,
    intent,
    dualSidePosition,
  });

  if (compareDecimalStrings(closeableQuantity, "0") <= 0) {
    throw new Error(intent === "close_long" ? "当前没有可平的多头仓位。" : "当前没有可平的空头仓位。");
  }

  if (compareDecimalStrings(quantity, closeableQuantity) > 0) {
    throw new Error(`当前最多可平数量为 ${closeableQuantity}。`);
  }

  return closeableQuantity;
}

export function describePositionMode(dualSidePosition) {
  return dualSidePosition ? "双向持仓模式" : "单向持仓模式";
}

export function describeTradeIntent(intent) {
  switch (intent) {
    case "open_long":
      return "开多";
    case "open_short":
      return "开空";
    case "close_long":
      return "平多";
    case "close_short":
      return "平空";
    default:
      return intent;
  }
}

export function formatMarginType(marginType) {
  const normalized = String(marginType ?? "").trim().toUpperCase();
  if (normalized === "CROSSED" || normalized === "CROSS") {
    return "全仓";
  }

  if (normalized === "ISOLATED") {
    return "逐仓";
  }

  return normalized || "-";
}

export function getActivePositions(accountInfo) {
  return (accountInfo?.positions ?? []).filter(
    (item) =>
      hasNonZeroValue(item.positionAmt ?? "0") ||
      hasNonZeroValue(item.notional ?? "0") ||
      hasNonZeroValue(item.initialMargin ?? "0"),
  );
}

export function formatPositionDirection(position, dualSidePosition) {
  if (dualSidePosition) {
    if (position.positionSide === "LONG") {
      return "多";
    }

    if (position.positionSide === "SHORT") {
      return "空";
    }

    return position.positionSide || "未知";
  }

  const amount = normalizeDecimalString(position.positionAmt ?? "0");
  if (compareDecimalStrings(amount, "0") > 0) {
    return "多";
  }

  if (compareDecimalStrings(amount, "0") < 0) {
    return "空";
  }

  return position.positionSide || "双向";
}
