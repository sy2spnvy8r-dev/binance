import { BinanceApiError, BinanceFuturesClient } from "../binance/futuresRestClient.mjs";
import { upsertEnvFile } from "./envFile.mjs";
import { absDecimalString, compareDecimalStrings } from "./decimal.mjs";
import { ANALYSIS_PERIODS, analyzeSquareText, buildMarketAnalysis } from "./analysisHelpers.mjs";
import { AutoAnalyzer } from "./autoAnalyzer.mjs";
import { OpenAICompatibleClient } from "./autoLlm.mjs";
import { SquareDailySource } from "./squareDailySource.mjs";
import { buildSquareNotes, normalizeSquareSymbols } from "./squareSentiment.mjs";
import {
  assertCloseQuantityAllowed,
  buildOrderInstruction,
  buildSymbolIndex,
  deriveQuantityFromMargin,
  describePositionMode,
  describeTradeIntent,
  formatMarginType,
  formatPositionDirection,
  getActivePositions,
  getSymbolInfo,
  getSymbolRules,
  validateLimitPrice,
  validateLimitQuantity,
  validateMinNotional,
} from "./futuresTradeHelpers.mjs";

const OPEN_INTENTS = new Set(["open_long", "open_short"]);
const CLOSE_INTENTS = new Set(["close_long", "close_short"]);
const VALID_INTENTS = new Set([...OPEN_INTENTS, ...CLOSE_INTENTS]);

const EXCHANGE_INFO_CACHE_TTL_MS = 5 * 60_000;
const POSITION_MODE_CACHE_TTL_MS = 10 * 60_000;
const SYMBOL_CONFIG_CACHE_TTL_MS = 15_000;
const ANALYSIS_CACHE_TTL_MS = 60_000;
const OPEN_POSITION_SYMBOLS_CACHE_TTL_MS = 60_000;
const DEFAULT_SQUARE_SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const FUTURES_ENVIRONMENTS = [
  {
    id: "mainnet",
    label: "正式盘",
    baseUrl: "https://fapi.binance.com",
  },
  {
    id: "testnet",
    label: "测试网",
    baseUrl: "https://demo-fapi.binance.com",
  },
  {
    id: "legacy_testnet",
    label: "旧测试网",
    baseUrl: "https://testnet.binancefuture.com",
  },
];

function maskValue(value) {
  if (!value) {
    return "";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function validateBaseUrl(value) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) {
    throw new Error("BINANCE_FUTURES_BASE_URL 不能为空。");
  }

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("BINANCE_FUTURES_BASE_URL 不是合法的 URL。");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("BINANCE_FUTURES_BASE_URL 只支持 http 或 https。");
  }

  return rawValue;
}

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

export function describeFuturesEnvironment(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const environment = FUTURES_ENVIRONMENTS.find(
    (item) => normalizeBaseUrl(item.baseUrl) === normalized,
  );

  if (environment) {
    return {
      ...environment,
      isKnown: true,
    };
  }

  return {
    id: "custom",
    label: "自定义",
    baseUrl,
    isKnown: false,
  };
}

function validateRecvWindow(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("recvWindow 必须是大于 0 的整数。");
  }

  return parsed;
}

function validateLeverage(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 125) {
    throw new Error("杠杆必须是 1 到 125 的整数。");
  }

  return String(parsed);
}

function createCache() {
  return {
    fetchedAt: 0,
    value: null,
  };
}

function serializeConfig(config) {
  const environment = describeFuturesEnvironment(config.baseUrl);

  return {
    baseUrl: config.baseUrl,
    environment: environment.id,
    environmentLabel: environment.label,
    recvWindow: config.recvWindow,
    dryRun: config.dryRun,
    envFile: config.envFile,
    hasApiKey: Boolean(config.apiKey),
    hasApiSecret: Boolean(config.apiSecret),
    apiKeyPreview: maskValue(config.apiKey),
  };
}

function normalizeConnectionError(error) {
  const payload = {
    ok: false,
    error: error?.message || "请求失败",
  };

  if (error instanceof BinanceApiError) {
    payload.code = error.code;
    payload.status = error.status;
  }

  return payload;
}

function buildPositionKey(symbol, positionSide = "BOTH") {
  return `${symbol}::${positionSide || "BOTH"}`;
}

function isPositionLikeActive(position) {
  return (
    compareDecimalStrings(position.positionAmt ?? "0", "0") !== 0 ||
    compareDecimalStrings(position.notional ?? "0", "0") !== 0 ||
    compareDecimalStrings(position.initialMargin ?? "0", "0") !== 0
  );
}

function enrichPosition(position, riskPosition, symbolConfig) {
  return {
    ...position,
    entryPrice: riskPosition?.entryPrice ?? position.entryPrice ?? "0",
    breakEvenPrice: riskPosition?.breakEvenPrice ?? position.breakEvenPrice ?? "0",
    markPrice: riskPosition?.markPrice ?? position.markPrice ?? "0",
    unrealizedProfit:
      riskPosition?.unRealizedProfit ??
      riskPosition?.unrealizedProfit ??
      position.unrealizedProfit ??
      "0",
    liquidationPrice: riskPosition?.liquidationPrice ?? position.liquidationPrice ?? "0",
    isolatedMargin: riskPosition?.isolatedMargin ?? position.isolatedMargin ?? "0",
    isolatedWallet: riskPosition?.isolatedWallet ?? position.isolatedWallet ?? "0",
    initialMargin: riskPosition?.initialMargin ?? position.initialMargin ?? "0",
    notional: riskPosition?.notional ?? position.notional ?? "0",
    marginAsset: riskPosition?.marginAsset ?? position.marginAsset ?? "",
    leverage:
      symbolConfig?.leverage !== undefined && symbolConfig?.leverage !== null
        ? String(symbolConfig.leverage)
        : position.leverage ?? "",
    marginType: symbolConfig?.marginType ?? position.marginType ?? "",
    isAutoAddMargin:
      symbolConfig?.isAutoAddMargin !== undefined
        ? symbolConfig.isAutoAddMargin
        : position.isAutoAddMargin,
  };
}

function mergeAccountInfo({ accountInfo, positionRisk, symbolConfigs }) {
  const riskMap = new Map();
  for (const position of positionRisk ?? []) {
    riskMap.set(buildPositionKey(position.symbol, position.positionSide), position);
  }

  const configMap = new Map((symbolConfigs ?? []).map((item) => [item.symbol, item]));
  const mergedMap = new Map();

  for (const position of accountInfo.positions ?? []) {
    const key = buildPositionKey(position.symbol, position.positionSide);
    const riskPosition =
      riskMap.get(key) ??
      riskMap.get(buildPositionKey(position.symbol, "BOTH")) ??
      riskMap.get(buildPositionKey(position.symbol, position.positionSide || "BOTH"));

    mergedMap.set(key, enrichPosition(position, riskPosition, configMap.get(position.symbol)));
  }

  for (const position of positionRisk ?? []) {
    const key = buildPositionKey(position.symbol, position.positionSide);
    if (mergedMap.has(key) || !isPositionLikeActive(position)) {
      continue;
    }

    mergedMap.set(
      key,
      enrichPosition(
        {
          symbol: position.symbol,
          positionSide: position.positionSide ?? "BOTH",
          positionAmt: position.positionAmt ?? "0",
          unrealizedProfit: position.unRealizedProfit ?? position.unrealizedProfit ?? "0",
          isolatedMargin: position.isolatedMargin ?? "0",
          notional: position.notional ?? "0",
          isolatedWallet: position.isolatedWallet ?? "0",
          initialMargin: position.initialMargin ?? "0",
        },
        position,
        configMap.get(position.symbol),
      ),
    );
  }

  return {
    ...accountInfo,
    positions: Array.from(mergedMap.values()),
  };
}

function normalizeAsset(asset) {
  return {
    asset: asset.asset,
    walletBalance: asset.walletBalance ?? "0",
    availableBalance: asset.availableBalance ?? "0",
    unrealizedProfit: asset.unrealizedProfit ?? "0",
  };
}

function normalizePosition(position, dualSidePosition) {
  return {
    symbol: position.symbol,
    direction: formatPositionDirection(position, dualSidePosition),
    positionSide: position.positionSide ?? "BOTH",
    quantity: absDecimalString(position.positionAmt ?? "0"),
    signedQuantity: position.positionAmt ?? "0",
    entryPrice: position.entryPrice ?? "0",
    breakEvenPrice: position.breakEvenPrice ?? "0",
    markPrice: position.markPrice ?? "0",
    leverage: position.leverage ? `${position.leverage}x` : "-",
    marginMode: formatMarginType(position.marginType),
    notional: position.notional ?? "0",
    initialMargin: position.initialMargin ?? "0",
    unrealizedProfit: position.unrealizedProfit ?? "0",
  };
}

function serializeSnapshot(snapshot) {
  const { accountInfo, dualSidePosition } = snapshot;
  const assets = (accountInfo.assets ?? [])
    .filter(
      (item) =>
        compareDecimalStrings(item.walletBalance ?? "0", "0") !== 0 ||
        compareDecimalStrings(item.availableBalance ?? "0", "0") !== 0 ||
        compareDecimalStrings(item.unrealizedProfit ?? "0", "0") !== 0,
    )
    .map(normalizeAsset)
    .sort((left, right) => right.asset.localeCompare(left.asset));
  const positions = getActivePositions(accountInfo)
    .map((item) => normalizePosition(item, dualSidePosition))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));

  return {
    summary: {
      positionMode: describePositionMode(dualSidePosition),
      dualSidePosition,
      totalWalletBalance: accountInfo.totalWalletBalance ?? "0",
      availableBalance: accountInfo.availableBalance ?? "0",
      totalUnrealizedProfit: accountInfo.totalUnrealizedProfit ?? "0",
      maxWithdrawAmount: accountInfo.maxWithdrawAmount ?? "0",
    },
    assets,
    positions,
    notes: dualSidePosition
      ? []
      : ["当前是单向持仓模式，买卖会按净仓处理，开多和开空不会并存。"],
  };
}

function serializePreview(prepared) {
  return {
    symbol: prepared.symbolInfo.symbol,
    intent: prepared.intent,
    intentLabel: describeTradeIntent(prepared.intent),
    quantity: prepared.quantity,
    price: prepared.price,
    leverage: prepared.leverage,
    margin: prepared.margin,
    estimatedMargin: prepared.estimatedMargin,
    notional: prepared.notional,
    closeableQuantity: prepared.closeableQuantity,
    positionMode: describePositionMode(prepared.snapshot.dualSidePosition),
    orderInstruction: prepared.orderInstruction,
    rules: prepared.rules,
    snapshot: serializeSnapshot(prepared.snapshot),
  };
}

export class TraderRuntime {
  constructor(initialConfig) {
    this.config = {
      ...initialConfig,
      baseUrl: validateBaseUrl(initialConfig.baseUrl),
      recvWindow: validateRecvWindow(initialConfig.recvWindow),
    };
    this.exchangeInfoCache = createCache();
    this.positionModeCache = createCache();
    this.symbolConfigCache = createCache();
    this.analysisCache = new Map();
    this.autoScanCache = createCache();
    this.autoScanPromise = null;
    this.squareCache = new Map();
    this.openPositionSymbolsCache = createCache();
    this.llmClient = new OpenAICompatibleClient(this.config.llm ?? {});
    this.autoAnalyzer = new AutoAnalyzer({ runtime: this, llmClient: this.llmClient });
    this.squareSource = new SquareDailySource(this.config.square ?? {});
  }

  invalidateSessionCaches() {
    this.exchangeInfoCache = createCache();
    this.positionModeCache = createCache();
    this.symbolConfigCache = createCache();
    this.analysisCache = new Map();
    this.autoScanCache = createCache();
    this.autoScanPromise = null;
    this.squareCache = new Map();
    this.openPositionSymbolsCache = createCache();
  }

  invalidateSymbolConfigCache() {
    this.symbolConfigCache = createCache();
  }

  getPublicConfig() {
    return serializeConfig(this.config);
  }

  getAutoConfig() {
    return {
      orderNotionalUsdt: this.config.auto?.orderNotionalUsdt ?? 100,
      defaultLeverage: this.config.auto?.defaultLeverage ?? 20,
      maxLeverage: this.config.auto?.maxLeverage ?? 20,
      scanIntervalMs: this.config.auto?.scanIntervalMs ?? 900000,
      scanEnabled: Boolean(this.config.auto?.scanEnabled),
      llmMaxCandidates: this.config.auto?.llmMaxCandidates ?? 20,
    };
  }

  async updateConfig({ apiKey, apiSecret, baseUrl, recvWindow, dryRun, save }) {
    const nextConfig = {
      ...this.config,
    };

    if (apiKey !== undefined && String(apiKey).trim()) {
      nextConfig.apiKey = String(apiKey).trim();
    }

    if (apiSecret !== undefined && String(apiSecret).trim()) {
      nextConfig.apiSecret = String(apiSecret).trim();
    }

    if (baseUrl !== undefined) {
      nextConfig.baseUrl = validateBaseUrl(baseUrl);
    }

    if (recvWindow !== undefined) {
      nextConfig.recvWindow = validateRecvWindow(recvWindow);
    }

    if (dryRun !== undefined) {
      nextConfig.dryRun = Boolean(dryRun);
    }

    const shouldResetCaches =
      nextConfig.baseUrl !== this.config.baseUrl ||
      nextConfig.apiKey !== this.config.apiKey ||
      nextConfig.apiSecret !== this.config.apiSecret;

    this.config = nextConfig;

    if (shouldResetCaches) {
      this.invalidateSessionCaches();
    }

    if (save) {
      await upsertEnvFile(this.config.envFile, {
        BINANCE_FUTURES_API_KEY: this.config.apiKey ?? "",
        BINANCE_FUTURES_API_SECRET: this.config.apiSecret ?? "",
        BINANCE_FUTURES_BASE_URL: this.config.baseUrl,
        BINANCE_FUTURES_RECV_WINDOW: String(this.config.recvWindow),
        BINANCE_FUTURES_DRY_RUN: String(this.config.dryRun),
        TRADER_ENV_FILE: this.config.envFile.replace(`${process.cwd()}\\`, ""),
        TRADER_WEB_HOST: this.config.webHost,
        TRADER_WEB_PORT: String(this.config.webPort),
      });
    }

    return this.getPublicConfig();
  }

  createClient(config = this.config) {
    return new BinanceFuturesClient(config);
  }

  async testConnection({ apiKey, apiSecret, baseUrl, recvWindow, dryRun } = {}) {
    const testConfig = {
      ...this.config,
      baseUrl: baseUrl !== undefined ? validateBaseUrl(baseUrl) : this.config.baseUrl,
      recvWindow:
        recvWindow !== undefined ? validateRecvWindow(recvWindow) : this.config.recvWindow,
      dryRun: dryRun !== undefined ? Boolean(dryRun) : this.config.dryRun,
    };

    if (apiKey !== undefined && String(apiKey).trim()) {
      testConfig.apiKey = String(apiKey).trim();
    }

    if (apiSecret !== undefined && String(apiSecret).trim()) {
      testConfig.apiSecret = String(apiSecret).trim();
    }

    const environment = describeFuturesEnvironment(testConfig.baseUrl);
    const client = this.createClient(testConfig);
    const result = {
      baseUrl: testConfig.baseUrl,
      environment: environment.id,
      environmentLabel: environment.label,
      testedAt: new Date().toISOString(),
      public: null,
      account: null,
    };

    try {
      const exchangeInfo = await client.getExchangeInfo();
      result.public = {
        ok: true,
        symbolCount: Array.isArray(exchangeInfo.symbols) ? exchangeInfo.symbols.length : 0,
      };
    } catch (error) {
      result.public = normalizeConnectionError(error);
      return result;
    }

    if (!testConfig.apiKey || !testConfig.apiSecret) {
      result.account = {
        ok: false,
        skipped: true,
        error: "未提供 API Key / Secret，仅测试公共接口。",
      };
      return result;
    }

    try {
      const accountInfo = await client.getAccountInfo();
      result.account = {
        ok: true,
        assetCount: Array.isArray(accountInfo.assets) ? accountInfo.assets.length : 0,
        positionCount: Array.isArray(accountInfo.positions) ? accountInfo.positions.length : 0,
      };
    } catch (error) {
      result.account = normalizeConnectionError(error);
    }

    return result;
  }

  async getExchangeInfo({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.exchangeInfoCache.value &&
      now - this.exchangeInfoCache.fetchedAt < EXCHANGE_INFO_CACHE_TTL_MS
    ) {
      return this.exchangeInfoCache.value;
    }

    const exchangeInfo = await this.createClient().getExchangeInfo();
    this.exchangeInfoCache = {
      fetchedAt: now,
      value: exchangeInfo,
    };
    return exchangeInfo;
  }

  async getPositionMode({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.positionModeCache.value &&
      now - this.positionModeCache.fetchedAt < POSITION_MODE_CACHE_TTL_MS
    ) {
      return this.positionModeCache.value;
    }

    const positionMode = await this.createClient().getPositionMode();
    this.positionModeCache = {
      fetchedAt: now,
      value: positionMode,
    };
    return positionMode;
  }

  async getSymbolConfigs({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.symbolConfigCache.value &&
      now - this.symbolConfigCache.fetchedAt < SYMBOL_CONFIG_CACHE_TTL_MS
    ) {
      return this.symbolConfigCache.value;
    }

    const symbolConfigs = await this.createClient().getSymbolConfig();
    this.symbolConfigCache = {
      fetchedAt: now,
      value: symbolConfigs,
    };
    return symbolConfigs;
  }

  async getSymbols() {
    const exchangeInfo = await this.getExchangeInfo();
    return (exchangeInfo.symbols ?? [])
      .filter((item) => item.status === "TRADING")
      .map((item) => item.symbol)
      .sort((left, right) => left.localeCompare(right));
  }

  buildAutoScanPlaceholder(status = "scanning") {
    return {
      status,
      scannedAt: new Date().toISOString(),
      universeSize: 0,
      scannedSymbols: 0,
      prefilteredFrom: 0,
      analyzedCandidates: 0,
      llmStatus: "pending",
      llmError: null,
      candidates: [],
    };
  }

  async runAutoScan() {
    const scan = await this.autoAnalyzer.scan();
    this.autoScanCache = {
      fetchedAt: Date.now(),
      value: {
        ...scan,
        status: "ready",
      },
    };
    return this.autoScanCache.value;
  }

  async getAutoScan({ forceRefresh = false, background = false } = {}) {
    const now = Date.now();
    const ttl = this.getAutoConfig().scanIntervalMs;
    if (
      !forceRefresh &&
      this.autoScanCache.value &&
      now - this.autoScanCache.fetchedAt < ttl
    ) {
      return this.autoScanCache.value;
    }

    if (!this.autoScanPromise) {
      this.autoScanPromise = this.runAutoScan().finally(() => {
        this.autoScanPromise = null;
      });
    }

    if (background) {
      return this.autoScanCache.value
        ? {
            ...this.autoScanCache.value,
            status: "refreshing",
          }
        : this.buildAutoScanPlaceholder();
    }

    return this.autoScanPromise;
  }

  async getCachedAutoScanSymbols() {
    const cached = this.autoScanCache.value;
    if (!cached?.candidates?.length) {
      return [];
    }

    return cached.candidates.slice(0, 20).map((candidate) => candidate.symbol);
  }

  async getOpenPositionSymbols() {
    const now = Date.now();
    if (
      this.openPositionSymbolsCache.value &&
      now - this.openPositionSymbolsCache.fetchedAt < OPEN_POSITION_SYMBOLS_CACHE_TTL_MS
    ) {
      return this.openPositionSymbolsCache.value;
    }

    try {
      const snapshot = await this.fetchTradingSnapshot();
      const symbols = getActivePositions(snapshot.accountInfo).map((position) => position.symbol);
      this.openPositionSymbolsCache = {
        fetchedAt: now,
        value: symbols,
      };
      return symbols;
    } catch {
      return this.openPositionSymbolsCache.value ?? [];
    }
  }

  async getTodaySquareNotes({ symbols = [], forceRefresh = false, includeCachedAuto = true } = {}) {
    if (this.config.square?.enabled === false) {
      return buildSquareNotes({
        posts: [],
        symbols,
        sourceErrors: {
          square: "Square fetch disabled",
        },
      });
    }

    const allSymbols = normalizeSquareSymbols([
      ...DEFAULT_SQUARE_SYMBOLS,
      ...symbols,
      ...(await this.getOpenPositionSymbols()),
      ...(includeCachedAuto ? await this.getCachedAutoScanSymbols() : []),
    ]);
    const cacheKey = allSymbols.join(",");
    const now = Date.now();
    const cached = this.squareCache.get(cacheKey);
    const ttl = this.config.square?.refreshIntervalMs ?? 600000;

    if (!forceRefresh && cached && now - cached.fetchedAt < ttl) {
      return cached.value;
    }

    const result = await this.squareSource.fetchToday({ symbols: allSymbols });
    const notes = buildSquareNotes({
      posts: result.posts,
      symbols: allSymbols,
      sourceErrors: result.sourceErrors,
    });
    const value = {
      ...notes,
      date: result.date,
      timeZone: result.timeZone,
      fetchedAt: result.fetchedAt,
      symbols: allSymbols,
    };

    this.squareCache.set(cacheKey, {
      fetchedAt: now,
      value,
    });
    return value;
  }

  async getMarketAnalysis({ symbol, forceRefresh = false } = {}) {
    const exchangeInfo = await this.getExchangeInfo();
    const symbolInfo = getSymbolInfo(buildSymbolIndex(exchangeInfo), symbol);
    const normalizedSymbol = symbolInfo.symbol;
    const now = Date.now();
    const cached = this.analysisCache.get(normalizedSymbol);

    if (!forceRefresh && cached && now - cached.fetchedAt < ANALYSIS_CACHE_TTL_MS) {
      return cached.value;
    }

    const client = this.createClient();
    const sourceErrors = {};
    const capture = async (sourceName, action) => {
      try {
        return await action();
      } catch (error) {
        sourceErrors[sourceName] = error?.message || "请求失败";
        return null;
      }
    };
    const periodResults = await Promise.all(
      ANALYSIS_PERIODS.map(async (period) => {
        const [openInterestHistory, longShortRatio, topTraderRatio, takerBuySellVolume] =
          await Promise.all([
            capture(`openInterestHistory:${period}`, () =>
              client.getOpenInterestHistory({ symbol: normalizedSymbol, period, limit: 2 }),
            ),
            capture(`longShortRatio:${period}`, () =>
              client.getGlobalLongShortRatio({ symbol: normalizedSymbol, period, limit: 1 }),
            ),
            capture(`topTraderRatio:${period}`, () =>
              client.getTopTraderLongShortRatio({ symbol: normalizedSymbol, period, limit: 1 }),
            ),
            capture(`takerBuySell:${period}`, () =>
              client.getTakerBuySellVolume({ symbol: normalizedSymbol, period, limit: 1 }),
            ),
          ]);

        return {
          period,
          openInterestHistory,
          longShortRatio,
          topTraderRatio,
          takerBuySellVolume,
        };
      }),
    );
    const [fundingRateHistory, openInterest] = await Promise.all([
      capture("fundingRate", () =>
        client.getFundingRateHistory({ symbol: normalizedSymbol, limit: 1 }),
      ),
      capture("openInterest", () => client.getOpenInterest({ symbol: normalizedSymbol })),
    ]);
    const openInterestHistories = {};
    const longShortRatios = {};
    const topTraderRatios = {};
    const takerBuySellVolumes = {};

    for (const result of periodResults) {
      openInterestHistories[result.period] = result.openInterestHistory ?? [];
      longShortRatios[result.period] = result.longShortRatio ?? [];
      topTraderRatios[result.period] = result.topTraderRatio ?? [];
      takerBuySellVolumes[result.period] = result.takerBuySellVolume ?? [];
    }

    const squareNotes = await this.getTodaySquareNotes({
      symbols: [normalizedSymbol],
      forceRefresh,
    });
    const analysis = {
      ...buildMarketAnalysis({
        symbol: normalizedSymbol,
        fundingRateHistory: fundingRateHistory ?? [],
        openInterest,
        openInterestHistories,
        longShortRatios,
        topTraderRatios,
        takerBuySellVolumes,
        sourceErrors,
      }),
      squareNotes,
    };

    this.analysisCache.set(normalizedSymbol, {
      fetchedAt: now,
      value: analysis,
    });
    return analysis;
  }

  analyzeSquareNotes({ text } = {}) {
    return analyzeSquareText(text);
  }

  requireCredentials() {
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new Error("请先在网页面板里配置 Binance 合约 API Key 和 Secret。");
    }
  }

  async fetchTradingSnapshot({
    forceRefreshPositionMode = false,
    forceRefreshSymbolConfig = false,
  } = {}) {
    this.requireCredentials();
    const client = this.createClient();
    const [accountInfo, positionRisk, positionMode, symbolConfigs] = await Promise.all([
      client.getAccountInfo(),
      client.getPositionRisk(),
      this.getPositionMode({ forceRefresh: forceRefreshPositionMode }),
      this.getSymbolConfigs({ forceRefresh: forceRefreshSymbolConfig }),
    ]);

    return {
      accountInfo: mergeAccountInfo({
        accountInfo,
        positionRisk,
        symbolConfigs,
      }),
      dualSidePosition: positionMode.dualSidePosition === true || positionMode.dualSidePosition === "true",
    };
  }

  async getAccountSnapshot() {
    const snapshot = await this.fetchTradingSnapshot();
    return serializeSnapshot(snapshot);
  }

  async prepareOrder({ symbol, intent, quantity, margin, price, leverage }) {
    if (!VALID_INTENTS.has(intent)) {
      throw new Error("不支持的订单意图。");
    }

    const exchangeInfo = await this.getExchangeInfo();
    const symbolIndex = buildSymbolIndex(exchangeInfo);
    const snapshot = await this.fetchTradingSnapshot();
    const symbolInfo = getSymbolInfo(symbolIndex, symbol);
    const rules = getSymbolRules(symbolInfo);
    const normalizedPrice = validateLimitPrice(price, rules);
    const normalizedLeverage = OPEN_INTENTS.has(intent) ? validateLeverage(leverage) : null;

    let normalizedQuantity;
    let normalizedMargin = null;
    let estimatedMargin = null;
    let notional;

    if (OPEN_INTENTS.has(intent)) {
      const derived = deriveQuantityFromMargin({
        margin,
        leverage: normalizedLeverage,
        price: normalizedPrice,
        rules,
      });
      normalizedQuantity = derived.quantity;
      normalizedMargin = derived.margin;
      estimatedMargin = derived.estimatedMargin;
      notional = derived.notional;
    } else {
      normalizedQuantity = validateLimitQuantity(quantity, rules);
      notional = validateMinNotional(normalizedPrice, normalizedQuantity, rules);
    }

    const closeableQuantity = CLOSE_INTENTS.has(intent)
      ? assertCloseQuantityAllowed({
          accountInfo: snapshot.accountInfo,
          symbol: symbolInfo.symbol,
          intent,
          quantity: normalizedQuantity,
          dualSidePosition: snapshot.dualSidePosition,
        })
      : null;

    const orderInstruction = buildOrderInstruction({
      intent,
      symbol: symbolInfo.symbol,
      quantity: normalizedQuantity,
      price: normalizedPrice,
      dualSidePosition: snapshot.dualSidePosition,
    });

    return {
      intent,
      symbolInfo,
      rules,
      quantity: normalizedQuantity,
      margin: normalizedMargin,
      estimatedMargin,
      price: normalizedPrice,
      leverage: normalizedLeverage,
      notional,
      closeableQuantity,
      orderInstruction,
      snapshot,
    };
  }

  async previewOrder(payload) {
    const prepared = await this.prepareOrder(payload);
    return serializePreview(prepared);
  }

  async submitOrder(payload) {
    const prepared = await this.prepareOrder(payload);
    const client = this.createClient();
    let leverageResponse = null;

    if (prepared.leverage) {
      leverageResponse = await client.changeLeverage({
        symbol: prepared.symbolInfo.symbol,
        leverage: prepared.leverage,
      });
      this.invalidateSymbolConfigCache();
    }

    let orderResponse;
    try {
      orderResponse = await client.createLimitOrder(prepared.orderInstruction);
    } catch (error) {
      if (prepared.leverage && !this.config.dryRun) {
        error.leveragePossiblyChanged = true;
        error.updatedLeverage = prepared.leverage;
        error.symbol = prepared.symbolInfo.symbol;
      }
      throw error;
    }

    const snapshot = serializeSnapshot(
      await this.fetchTradingSnapshot({
        forceRefreshSymbolConfig: Boolean(prepared.leverage),
      }),
    );

    return {
      preview: serializePreview(prepared),
      leverageResponse,
      orderResponse,
      snapshot,
    };
  }
}
