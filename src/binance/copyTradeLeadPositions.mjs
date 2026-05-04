import crypto from "node:crypto";
import { stableStringify } from "../utils/stableStringify.mjs";

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNonZero(value) {
  return Math.abs(toNumber(value)) > 0;
}

function pickValue(record, keys, fallback = "") {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return fallback;
}

function normalizePositionSide(record) {
  const explicit = String(
    pickValue(record, ["positionSide", "side", "direction", "positionDirection"], "BOTH"),
  ).toUpperCase();

  if (explicit === "BUY") {
    return "LONG";
  }

  if (explicit === "SELL") {
    return "SHORT";
  }

  return explicit;
}

function translateDirection(positionSide, positionAmount) {
  if (positionSide === "LONG") {
    return "多";
  }

  if (positionSide === "SHORT") {
    return "空";
  }

  return toNumber(positionAmount) < 0 ? "空" : "多";
}

function toMarginMode(record) {
  if (typeof record?.isolated === "boolean") {
    return record.isolated ? "逐仓" : "全仓";
  }

  const marginType = String(pickValue(record, ["marginType", "marginMode"], "")).toUpperCase();
  return marginType === "ISOLATED" ? "逐仓" : "全仓";
}

function createPositionKey(position) {
  return `${position.symbol}|${position.positionSide}`;
}

function sortByExposure(left, right) {
  return toNumber(right.notionalValue) - toNumber(left.notionalValue);
}

function getValueByPath(value, path) {
  if (!path) {
    return undefined;
  }

  return path.split(".").reduce((current, segment) => current?.[segment], value);
}

export function resolveCopyTradeRows(payload, responseItemsPath = "data") {
  const candidate = getValueByPath(payload, responseItemsPath);
  if (Array.isArray(candidate)) {
    return candidate;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.data?.rows)) {
    return payload.data.rows;
  }

  if (Array.isArray(payload?.data?.list)) {
    return payload.data.list;
  }

  if (Array.isArray(payload?.rows)) {
    return payload.rows;
  }

  if (Array.isArray(payload?.list)) {
    return payload.list;
  }

  return undefined;
}

export function normalizeLeadPositions(
  positions,
  { activeOnly = true, symbolAllowlist = new Set() } = {},
) {
  const normalized = (Array.isArray(positions) ? positions : [])
    .map((position) => {
      const symbol = String(pickValue(position, ["symbol", "pair", "asset"], ""));
      const positionAmount = String(
        pickValue(position, ["positionAmount", "amount", "positionAmt", "qty", "size"], "0"),
      );
      const positionSide = normalizePositionSide(position);
      const notionalValue = String(
        pickValue(position, ["notionalValue", "positionValue", "notional", "value", "marketValue"], "0"),
      );

      return {
        key: createPositionKey({ symbol, positionSide }),
        symbol,
        collateral: String(pickValue(position, ["collateral", "marginAsset", "quoteAsset"], "USDT")),
        positionSide,
        direction: translateDirection(positionSide, positionAmount),
        positionAmount,
        entryPrice: String(
          pickValue(position, ["entryPrice", "avgPrice", "averageOpenPrice", "openPrice"], "0"),
        ),
        breakEvenPrice: String(
          pickValue(position, ["breakEvenPrice", "breakevenPrice", "breakEven"], "0"),
        ),
        markPrice: String(
          pickValue(position, ["markPrice", "lastPrice", "currentPrice", "price"], "0"),
        ),
        leverage: Number(pickValue(position, ["leverage"], 0)),
        marginMode: toMarginMode(position),
        isolatedWallet: String(
          pickValue(position, ["isolatedWallet", "margin", "marginAmount", "initialMargin"], "0"),
        ),
        notionalValue,
        unrealizedProfit: String(
          pickValue(position, ["unrealizedProfit", "pnl", "unPnl", "unrealizedPnl", "floatingPnL"], "0"),
        ),
        cumRealized: String(
          pickValue(position, ["cumRealized", "realizedPnl", "realizedProfit", "closedPnl"], "0"),
        ),
        adl: Number(pickValue(position, ["adl", "adlLevel"], 0)),
      };
    })
    .filter((position) => {
      if (!position.symbol) {
        return false;
      }

      if (symbolAllowlist.size > 0 && !symbolAllowlist.has(position.symbol)) {
        return false;
      }

      if (!activeOnly) {
        return true;
      }

      return isNonZero(position.positionAmount) || isNonZero(position.notionalValue);
    })
    .sort(sortByExposure);

  return normalized;
}

export function createLeadPositionsSnapshotHash(positions) {
  return crypto.createHash("sha256").update(stableStringify(positions)).digest("hex");
}

export function diffLeadPositions(previousPositions = [], currentPositions = []) {
  const previousMap = new Map(previousPositions.map((position) => [position.key, position]));
  const currentMap = new Map(currentPositions.map((position) => [position.key, position]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const currentPosition of currentPositions) {
    const previousPosition = previousMap.get(currentPosition.key);
    if (!previousPosition) {
      added.push(currentPosition);
      continue;
    }

    if (stableStringify(previousPosition) !== stableStringify(currentPosition)) {
      changed.push({
        before: previousPosition,
        after: currentPosition,
      });
    }
  }

  for (const previousPosition of previousPositions) {
    if (!currentMap.has(previousPosition.key)) {
      removed.push(previousPosition);
    }
  }

  return {
    added,
    removed,
    changed,
  };
}
