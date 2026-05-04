const DECIMAL_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function countDecimals(value) {
  const normalized = normalizeDecimalString(value);
  const [, fraction = ""] = normalized.split(".");
  return fraction.length;
}

function powerOfTen(exponent) {
  return 10n ** BigInt(exponent);
}

function toScaledInteger(value, scale) {
  const normalized = normalizeDecimalString(value);
  let sign = 1n;
  let rawValue = normalized;

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

  if (rawValue < 0) {
    sign = "-";
    rawValue = -rawValue;
  }

  const digits = rawValue.toString().padStart(scale + 1, "0");
  if (scale === 0) {
    return `${sign}${digits}`;
  }

  const whole = digits.slice(0, -scale) || "0";
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  const normalized = fraction ? `${whole}.${fraction}` : whole;
  return `${sign}${normalized.replace(/^0+(?=\d)/, "")}`;
}

export function normalizeDecimalString(value) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) {
    throw new Error("请输入数字。");
  }

  if (!DECIMAL_PATTERN.test(rawValue)) {
    throw new Error(`无效数字: ${value}`);
  }

  let sign = "";
  let unsigned = rawValue;

  if (unsigned.startsWith("+") || unsigned.startsWith("-")) {
    sign = unsigned[0] === "-" ? "-" : "";
    unsigned = unsigned.slice(1);
  }

  if (unsigned.startsWith(".")) {
    unsigned = `0${unsigned}`;
  }

  let [whole, fraction = ""] = unsigned.split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  if (!whole) {
    whole = "0";
  }

  fraction = fraction.replace(/0+$/, "");

  const normalized = fraction ? `${whole}.${fraction}` : whole;
  if (normalized === "0") {
    return "0";
  }

  return sign ? `${sign}${normalized}` : normalized;
}

export function compareDecimalStrings(left, right) {
  const scale = Math.max(countDecimals(left), countDecimals(right));
  const difference = toScaledInteger(left, scale) - toScaledInteger(right, scale);
  if (difference === 0n) {
    return 0;
  }

  return difference > 0n ? 1 : -1;
}

export function isStepAligned(value, step) {
  if (compareDecimalStrings(step, "0") <= 0) {
    throw new Error("步进值必须大于 0。");
  }

  const scale = Math.max(countDecimals(value), countDecimals(step));
  const valueInt = toScaledInteger(value, scale);
  const stepInt = toScaledInteger(step, scale);
  return valueInt % stepInt === 0n;
}

export function multiplyDecimalStrings(left, right) {
  const normalizedLeft = normalizeDecimalString(left);
  const normalizedRight = normalizeDecimalString(right);
  const leftScale = countDecimals(normalizedLeft);
  const rightScale = countDecimals(normalizedRight);
  const product =
    toScaledInteger(normalizedLeft, leftScale) * toScaledInteger(normalizedRight, rightScale);
  return normalizeDecimalString(fromScaledInteger(product, leftScale + rightScale));
}

export function addDecimalStrings(left, right) {
  const normalizedLeft = normalizeDecimalString(left);
  const normalizedRight = normalizeDecimalString(right);
  const scale = Math.max(countDecimals(normalizedLeft), countDecimals(normalizedRight));
  const sum = toScaledInteger(normalizedLeft, scale) + toScaledInteger(normalizedRight, scale);
  return normalizeDecimalString(fromScaledInteger(sum, scale));
}

export function subtractDecimalStrings(left, right) {
  return addDecimalStrings(left, `-${normalizeDecimalString(right)}`);
}

export function divideDecimalStrings(left, right, precision = 18) {
  const normalizedLeft = normalizeDecimalString(left);
  const normalizedRight = normalizeDecimalString(right);

  if (compareDecimalStrings(normalizedRight, "0") === 0) {
    throw new Error("除数不能为 0。");
  }

  const leftScale = countDecimals(normalizedLeft);
  const rightScale = countDecimals(normalizedRight);
  const leftInt = toScaledInteger(normalizedLeft, leftScale);
  const rightInt = toScaledInteger(normalizedRight, rightScale);
  const exponent = precision + rightScale - leftScale;
  const scaledDividend =
    exponent >= 0
      ? leftInt * powerOfTen(exponent)
      : leftInt / powerOfTen(Math.abs(exponent));
  const quotient = scaledDividend / rightInt;

  return normalizeDecimalString(fromScaledInteger(quotient, precision));
}

export function floorDecimalToStep(value, step) {
  const normalizedValue = normalizeDecimalString(value);
  const normalizedStep = normalizeDecimalString(step);

  if (compareDecimalStrings(normalizedStep, "0") <= 0) {
    throw new Error("步进值必须大于 0。");
  }

  const scale = Math.max(countDecimals(normalizedValue), countDecimals(normalizedStep));
  const valueInt = toScaledInteger(normalizedValue, scale);
  const stepInt = toScaledInteger(normalizedStep, scale);
  const floored = (valueInt / stepInt) * stepInt;

  return normalizeDecimalString(fromScaledInteger(floored, scale));
}

export function absDecimalString(value) {
  const normalized = normalizeDecimalString(value);
  return normalized.startsWith("-") ? normalized.slice(1) : normalized;
}
