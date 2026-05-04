import {
  compareDecimalStrings,
  multiplyDecimalStrings,
  normalizeDecimalString,
} from "./decimal.mjs";
import {
  validateLimitPrice,
  validateLimitQuantity,
  validateMinNotional,
} from "./futuresTradeHelpers.mjs";

function countDecimals(value) {
  const normalized = normalizeDecimalString(value);
  const [, fraction = ""] = normalized.split(".");
  return fraction.length;
}

function toScaledInteger(value, scale) {
  const normalized = normalizeDecimalString(value);
  let rawValue = normalized;
  let sign = 1n;

  if (rawValue.startsWith("-")) {
    sign = -1n;
    rawValue = rawValue.slice(1);
  }

  const [whole, fraction = ""] = rawValue.split(".");
  const digits = `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "") || "0";
  return sign * BigInt(digits);
}

function fromScaledInteger(value, scale) {
  let rawValue = value;
  let sign = "";

  if (rawValue < 0n) {
    sign = "-";
    rawValue = -rawValue;
  }

  const digits = rawValue.toString().padStart(scale + 1, "0");
  if (scale === 0) {
    return `${sign}${digits}`;
  }

  const whole = digits.slice(0, -scale) || "0";
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return normalizeDecimalString(`${sign}${whole}${fraction ? `.${fraction}` : ""}`);
}

function power10(value) {
  return 10n ** BigInt(value);
}

export function divideDecimalStrings(numerator, denominator, precision = 18) {
  if (compareDecimalStrings(denominator, "0") <= 0) {
    throw new Error("denominator must be greater than 0");
  }

  const scale = Math.max(countDecimals(numerator), countDecimals(denominator));
  const numeratorInt = toScaledInteger(numerator, scale);
  const denominatorInt = toScaledInteger(denominator, scale);
  const quotient = (numeratorInt * power10(precision)) / denominatorInt;
  return normalizeDecimalString(fromScaledInteger(quotient, precision));
}

export function floorToStep(value, step) {
  if (compareDecimalStrings(step, "0") <= 0) {
    throw new Error("step must be greater than 0");
  }

  const scale = Math.max(countDecimals(value), countDecimals(step));
  const valueInt = toScaledInteger(value, scale);
  const stepInt = toScaledInteger(step, scale);
  const floored = (valueInt / stepInt) * stepInt;
  return normalizeDecimalString(fromScaledInteger(floored, scale));
}

export function buildAutoOrderInput({ decision, rules, orderNotionalUsdt, maxLeverage }) {
  const intent = decision.action || decision.intent;
  if (intent !== "open_long" && intent !== "open_short") {
    throw new Error("auto order only supports open_long/open_short");
  }

  const leverage = String(Number(decision.leverage || maxLeverage));
  if (!Number.isInteger(Number(leverage)) || Number(leverage) < 1 || Number(leverage) > Number(maxLeverage)) {
    throw new Error("invalid leverage");
  }

  const price = validateLimitPrice(floorToStep(decision.entryPrice, rules.tickSize), rules);
  const rawQuantity = divideDecimalStrings(orderNotionalUsdt, price, 18);
  const quantity = validateLimitQuantity(floorToStep(rawQuantity, rules.stepSize), rules);
  const notional = validateMinNotional(price, quantity, rules);

  return {
    intent,
    symbol: rules.symbol,
    quantity,
    price,
    leverage,
    notional,
    requestedNotional: normalizeDecimalString(orderNotionalUsdt),
    actualNotional: multiplyDecimalStrings(price, quantity),
  };
}
