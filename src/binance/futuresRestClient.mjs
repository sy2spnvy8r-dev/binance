import { buildQuery, signQuery } from "./signature.mjs";

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
}

function appendSignature(params, secret) {
  const { query, signature } = signQuery(params, secret);
  return query ? `${query}&signature=${signature}` : `signature=${signature}`;
}

function parseResponseBody(text) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function redactHeaders(headers) {
  if (!headers["X-MBX-APIKEY"]) {
    return headers;
  }

  return {
    ...headers,
    "X-MBX-APIKEY": `${String(headers["X-MBX-APIKEY"]).slice(0, 4)}***`,
  };
}

const REST_COOLDOWNS = new Map();

function cooldownKey(baseUrl) {
  return String(baseUrl ?? "").replace(/\/+$/, "").toLowerCase();
}

function parseBanUntilMs(message) {
  const match = String(message ?? "").match(/banned until\s+(\d+)/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > Date.now() ? parsed : null;
}

function setRestCooldown(baseUrl, until, message) {
  if (!Number.isFinite(until) || until <= Date.now()) {
    return;
  }

  REST_COOLDOWNS.set(cooldownKey(baseUrl), {
    until,
    message,
  });
}

function getRestCooldown(baseUrl) {
  const key = cooldownKey(baseUrl);
  const cooldown = REST_COOLDOWNS.get(key);
  if (!cooldown) {
    return null;
  }

  if (cooldown.until <= Date.now()) {
    REST_COOLDOWNS.delete(key);
    return null;
  }

  return cooldown;
}

export class BinanceApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "BinanceApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BinanceFuturesClient {
  constructor({
    apiKey,
    apiSecret,
    baseUrl = "https://fapi.binance.com",
    recvWindow = 5000,
    dryRun = false,
    userAgent = "binance-futures-cli/0.1.0",
    fetchImpl = globalThis.fetch,
  }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
    this.recvWindow = recvWindow;
    this.dryRun = dryRun;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
  }

  async getExchangeInfo() {
    return this.publicGet("/fapi/v1/exchangeInfo");
  }

  async get24hTickers({ symbol } = {}) {
    return this.publicGet("/fapi/v1/ticker/24hr", { symbol });
  }

  async getKlines({ symbol, interval = "1h", limit = 120 }) {
    return this.publicGet("/fapi/v1/klines", { symbol, interval, limit });
  }

  async getFundingRates({ symbol } = {}) {
    return this.publicGet("/fapi/v1/premiumIndex", { symbol });
  }

  async getAccountInfo() {
    return this.signedGet("/fapi/v3/account");
  }

  async getPositionMode() {
    return this.signedGet("/fapi/v1/positionSide/dual");
  }

  async getPositionRisk() {
    return this.signedGet("/fapi/v3/positionRisk");
  }

  async getSymbolConfig() {
    return this.signedGet("/fapi/v1/symbolConfig");
  }

  async getOrder({ symbol, orderId, origClientOrderId }) {
    return this.signedGet("/fapi/v1/order", compactObject({ symbol, orderId, origClientOrderId }));
  }

  async getIncomeHistory({ symbol, incomeType, startTime, endTime, limit = 1000 } = {}) {
    return this.signedGet(
      "/fapi/v1/income",
      compactObject({ symbol, incomeType, startTime, endTime, limit }),
    );
  }

  async getOpenInterest({ symbol }) {
    return this.publicGet("/fapi/v1/openInterest", { symbol });
  }

  async getOpenInterestHistory({ symbol, period = "5m", limit = 2 }) {
    return this.publicGet("/futures/data/openInterestHist", { symbol, period, limit });
  }

  async getGlobalLongShortRatio({ symbol, period = "5m", limit = 1 }) {
    return this.publicGet("/futures/data/globalLongShortAccountRatio", { symbol, period, limit });
  }

  async getTopTraderLongShortRatio({ symbol, period = "5m", limit = 1 }) {
    return this.publicGet("/futures/data/topLongShortPositionRatio", { symbol, period, limit });
  }

  async getTakerBuySellVolume({ symbol, period = "5m", limit = 1 }) {
    return this.publicGet("/futures/data/takerlongshortRatio", { symbol, period, limit });
  }

  async getFundingRateHistory({ symbol, limit = 1 }) {
    return this.publicGet("/fapi/v1/fundingRate", { symbol, limit });
  }

  async changeLeverage({ symbol, leverage }) {
    return this.signedPost("/fapi/v1/leverage", { symbol, leverage });
  }

  async createLimitOrder({ symbol, side, positionSide, quantity, price, reduceOnly }) {
    return this.signedPost(
      "/fapi/v1/order",
      compactObject({
        symbol,
        side,
        positionSide,
        type: "LIMIT",
        timeInForce: "GTC",
        quantity,
        price,
        reduceOnly,
        newOrderRespType: "ACK",
      }),
    );
  }

  async getOpenAlgoOrders({ symbol, algoType } = {}) {
    return this.signedGet("/fapi/v1/openAlgoOrders", compactObject({ symbol, algoType }));
  }

  async getAlgoOrder({ algoId, clientAlgoId }) {
    return this.signedGet("/fapi/v1/algoOrder", compactObject({ algoId, clientAlgoId }));
  }

  async cancelAlgoOrder({ algoId, clientAlgoId }) {
    return this.signedDelete("/fapi/v1/algoOrder", compactObject({ algoId, clientAlgoId }));
  }

  async createStopMarketOrder({
    symbol,
    side,
    positionSide,
    stopPrice,
    triggerPrice,
    workingType = "MARK_PRICE",
    priceProtect = "TRUE",
  }) {
    return this.signedPost(
      "/fapi/v1/algoOrder",
      compactObject({
        algoType: "CONDITIONAL",
        symbol,
        side,
        positionSide,
        type: "STOP_MARKET",
        triggerPrice: triggerPrice ?? stopPrice,
        closePosition: "true",
        workingType,
        priceProtect,
        newOrderRespType: "ACK",
      }),
    );
  }

  async createTakeProfitMarketOrder({
    symbol,
    side,
    positionSide,
    quantity,
    reduceOnly,
    closePosition,
    stopPrice,
    triggerPrice,
    workingType = "MARK_PRICE",
    priceProtect = "TRUE",
  }) {
    const shouldClosePosition = closePosition ?? !quantity;
    return this.signedPost(
      "/fapi/v1/algoOrder",
      compactObject({
        algoType: "CONDITIONAL",
        symbol,
        side,
        positionSide,
        type: "TAKE_PROFIT_MARKET",
        quantity,
        triggerPrice: triggerPrice ?? stopPrice,
        closePosition: shouldClosePosition ? "true" : undefined,
        reduceOnly,
        workingType,
        priceProtect,
        newOrderRespType: "ACK",
      }),
    );
  }

  async createTrailingStopMarketOrder({
    symbol,
    side,
    positionSide,
    quantity,
    reduceOnly,
    activatePrice,
    callbackRate,
    workingType = "MARK_PRICE",
  }) {
    return this.signedPost(
      "/fapi/v1/algoOrder",
      compactObject({
        algoType: "CONDITIONAL",
        symbol,
        side,
        positionSide,
        type: "TRAILING_STOP_MARKET",
        quantity,
        reduceOnly,
        activatePrice,
        callbackRate,
        workingType,
        newOrderRespType: "ACK",
      }),
    );
  }

  async cancelOrder({ symbol, orderId, origClientOrderId }) {
    return this.signedDelete(
      "/fapi/v1/order",
      compactObject({ symbol, orderId, origClientOrderId }),
    );
  }

  async publicGet(path, params = {}) {
    return this.request("GET", path, params, { signed: false });
  }

  async signedGet(path, params = {}) {
    return this.request("GET", path, params, { signed: true });
  }

  async signedPost(path, params = {}) {
    return this.request("POST", path, params, { signed: true });
  }

  async signedDelete(path, params = {}) {
    return this.request("DELETE", path, params, { signed: true });
  }

  async request(method, path, params, { signed }) {
    if (signed && (!this.apiKey || !this.apiSecret)) {
      throw new Error("Binance API key and secret are required for signed requests.");
    }

    const cooldown = getRestCooldown(this.baseUrl);
    if (cooldown) {
      throw new BinanceApiError(
        `Binance request paused: REST cooldown until ${new Date(cooldown.until).toISOString()}`,
        {
          status: 429,
          code: "REST_COOLDOWN",
          details: {
            msg: cooldown.message,
            retryAfterMs: cooldown.until - Date.now(),
          },
        },
      );
    }

    const cleanedParams = compactObject(params);
    const payload = signed
      ? compactObject({
          ...cleanedParams,
          recvWindow: this.recvWindow,
          timestamp: Date.now(),
        })
      : cleanedParams;
    const query = signed ? appendSignature(payload, this.apiSecret) : buildQuery(payload);
    const url = new URL(path, this.baseUrl);
    const headers = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };

    if (this.apiKey) {
      headers["X-MBX-APIKEY"] = this.apiKey;
    }

    let body;
    if (method === "GET" || method === "DELETE") {
      if (query) {
        url.search = query;
      }
    } else if (query) {
      headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      body = query;
    }

    if (this.dryRun && signed && method !== "GET") {
      return {
        dryRun: true,
        method,
        url: url.toString(),
        body,
        headers: redactHeaders(headers),
      };
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
    });
    const text = await response.text();
    const data = parseResponseBody(text);

    if (!response.ok) {
      const details = data && typeof data === "object" ? data : { raw: text };
      const message = details.msg || response.statusText;
      if (
        response.status === 418 ||
        response.status === 429 ||
        /too many requests|banned until/i.test(String(message))
      ) {
        setRestCooldown(
          this.baseUrl,
          parseBanUntilMs(message) ?? Date.now() + 60_000,
          String(message),
        );
      }
      throw new BinanceApiError(`Binance request failed: ${message}`, {
        status: response.status,
        code: details.code,
        details,
      });
    }

    return data;
  }
}
