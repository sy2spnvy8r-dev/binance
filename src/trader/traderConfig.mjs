import path from "node:path";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function readOptional(names, fallback = "") {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return fallback;
}

function readNumber(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} 必须是数字。`);
  }

  return parsed;
}

function readBoolean(name, fallback = false) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  return TRUE_VALUES.has(value.toLowerCase());
}

function readOptionalNumber(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }

  return parsed;
}

function readList(name, fallback = []) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readJson(name, fallback = null) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function safeAccountId(value, fallback) {
  const raw = String(value || fallback || "default").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}

function pickAccountAutoTradeOverrides(account) {
  const keys = [
    "enabled",
    "testnetOnly",
    "initialCapitalUsdt",
    "maxOpenPositions",
    "orderMarginUsdt",
    "minOrderMarginUsdt",
    "maxOrdersPerRun",
    "minConfidence",
    "maxTotalRiskUsdt",
    "intervalMs",
    "entryOrderTtlMs",
    "protectionRetryMs",
    "splitTakeProfitEnabled",
    "trailingCallbackRate",
    "regimeGateEnabled",
    "regimeSymbol",
    "regimeConflictOverrideConfidence",
    "regimeConflictMarginScale",
    "shadowModeEnabled",
    "auditEnabled",
    "shadowFeeRate",
  ];
  const overrides = { ...(account.autoTrade ?? {}) };
  for (const key of keys) {
    if (account[key] !== undefined) {
      overrides[key] = account[key];
    }
  }
  return overrides;
}

function buildAccountConfigs(config) {
  const rawAccounts = readJson("TRADER_ACCOUNTS_JSON", []);
  if (!Array.isArray(rawAccounts) || !rawAccounts.length) {
    return [];
  }

  return rawAccounts.map((account, index) => {
    const id = safeAccountId(account.id ?? account.label, `account-${index + 1}`);
    const label = String(account.label ?? account.name ?? id);
    const autoTradeOverrides = pickAccountAutoTradeOverrides(account);
    return {
      ...config,
      accountId: id,
      accountLabel: label,
      apiKey: String(account.apiKey ?? account.api_key ?? ""),
      apiSecret: String(account.apiSecret ?? account.api_secret ?? ""),
      baseUrl: String(account.baseUrl ?? config.baseUrl),
      dryRun: account.dryRun !== undefined ? Boolean(account.dryRun) : config.dryRun,
      autoTrade: {
        ...config.autoTrade,
        ...autoTradeOverrides,
        stateFile: path.resolve(
          process.cwd(),
          account.stateFile ?? autoTradeOverrides.stateFile ?? `.state/auto-trade-real-${id}.json`,
        ),
        auditLogFile: path.resolve(
          process.cwd(),
          account.auditLogFile ?? autoTradeOverrides.auditLogFile ?? `.state/strategy-audit-${id}.jsonl`,
        ),
      },
    };
  });
}

export function loadTraderConfig(argv = process.argv.slice(2)) {
  const config = {
    apiKey: readOptional(["BINANCE_FUTURES_API_KEY", "BINANCE_API_KEY"]),
    apiSecret: readOptional(["BINANCE_FUTURES_API_SECRET", "BINANCE_API_SECRET"]),
    baseUrl: readOptional("BINANCE_FUTURES_BASE_URL", "https://fapi.binance.com"),
    recvWindow: readNumber("BINANCE_FUTURES_RECV_WINDOW", 5000),
    dryRun: argv.includes("--dry-run") || readBoolean("BINANCE_FUTURES_DRY_RUN", false),
    envFile: path.resolve(process.cwd(), readOptional("TRADER_ENV_FILE", ".env")),
    webHost: readOptional("TRADER_WEB_HOST", "0.0.0.0"),
    webPort: readNumber("TRADER_WEB_PORT", 4580),
    auto: {
      orderNotionalUsdt: readOptionalNumber("AUTO_ORDER_NOTIONAL_USDT", 100),
      defaultLeverage: readOptionalNumber("AUTO_DEFAULT_LEVERAGE", 20),
      maxLeverage: readOptionalNumber("AUTO_MAX_LEVERAGE", 20),
      scanIntervalMs: readOptionalNumber("AUTO_SCAN_INTERVAL_MS", 900000),
      scanEnabled: readBoolean("AUTO_SCAN_ENABLED", false),
      llmMaxCandidates: readOptionalNumber("AUTO_LLM_MAX_CANDIDATES", 20),
    },
    llm: {
      baseUrl: readOptional("LLM_BASE_URL"),
      apiKey: readOptional("LLM_API_KEY"),
      model: readOptional("LLM_MODEL"),
      temperature: readOptionalNumber("LLM_TEMPERATURE", 0.1),
      timeoutMs: readOptionalNumber("LLM_TIMEOUT_MS", 120000),
    },
    square: {
      enabled: readBoolean("SQUARE_FETCH_ENABLED", true),
      refreshIntervalMs: readOptionalNumber("SQUARE_REFRESH_INTERVAL_MS", 600000),
      maxPosts: readOptionalNumber("SQUARE_MAX_POSTS", 50),
      pageSize: readOptionalNumber("SQUARE_PAGE_SIZE", 20),
      sourceUrls: readList("SQUARE_SOURCE_URLS"),
      timeZone: readOptional("SQUARE_TIME_ZONE", "Asia/Shanghai"),
    },
    autoFeishu: {
      enabled: readBoolean("AUTO_FEISHU_ENABLED", false),
      webhookUrl: readOptional(["AUTO_FEISHU_WEBHOOK_URL", "FEISHU_WEBHOOK_URL"]),
      messageStyle: readOptional("AUTO_FEISHU_MESSAGE_STYLE", "interactive_table"),
      intervalMs: readOptionalNumber(
        "AUTO_FEISHU_INTERVAL_MS",
        readOptionalNumber("AUTO_SCAN_INTERVAL_MS", 900000),
      ),
    },
    autoTradeFeishu: {
      enabled: readBoolean("AUTO_TRADE_FEISHU_ENABLED", false),
      webhookUrl: readOptional(["AUTO_TRADE_FEISHU_WEBHOOK_URL", "AUTO_FEISHU_WEBHOOK_URL", "FEISHU_WEBHOOK_URL"]),
      messageStyle: readOptional("AUTO_TRADE_FEISHU_MESSAGE_STYLE", "interactive_table"),
    },
    autoTrade: {
      enabled: readBoolean("AUTO_TRADE_ENABLED", false),
      testnetOnly: readBoolean("AUTO_TRADE_TESTNET_ONLY", true),
      initialCapitalUsdt: String(readOptionalNumber("AUTO_TRADE_INITIAL_CAPITAL_USDT", 0)),
      maxOpenPositions: readOptionalNumber("AUTO_TRADE_MAX_OPEN_POSITIONS", 1),
      orderMarginUsdt: readOptionalNumber("AUTO_TRADE_ORDER_MARGIN_USDT", 20),
      minOrderMarginUsdt: readOptionalNumber("AUTO_TRADE_MIN_ORDER_MARGIN_USDT", 10),
      maxOrdersPerRun: readOptionalNumber("AUTO_TRADE_MAX_ORDERS_PER_RUN", 3),
      minConfidence: readOptionalNumber("AUTO_TRADE_MIN_CONFIDENCE", 70),
      maxTotalRiskUsdt: readOptionalNumber("AUTO_TRADE_MAX_TOTAL_RISK_USDT", 30),
      intervalMs: readOptionalNumber(
        "AUTO_TRADE_INTERVAL_MS",
        readOptionalNumber("AUTO_SCAN_INTERVAL_MS", 900000),
      ),
      entryOrderTtlMs: readOptionalNumber("AUTO_TRADE_ENTRY_ORDER_TTL_MS", 600000),
      protectionRetryMs: readOptionalNumber("AUTO_TRADE_PROTECTION_RETRY_MS", 60000),
      splitTakeProfitEnabled: readBoolean("AUTO_TRADE_SPLIT_TP_ENABLED", true),
      trailingCallbackRate: readOptionalNumber("AUTO_TRADE_TRAILING_CALLBACK_RATE", 0.8),
      regimeGateEnabled: readBoolean("AUTO_TRADE_REGIME_GATE_ENABLED", true),
      regimeSymbol: readOptional("AUTO_TRADE_REGIME_SYMBOL", "BTCUSDT"),
      regimeConflictOverrideConfidence: readOptionalNumber(
        "AUTO_TRADE_REGIME_CONFLICT_OVERRIDE_CONFIDENCE",
        75,
      ),
      regimeConflictMarginScale: readOptionalNumber(
        "AUTO_TRADE_REGIME_CONFLICT_MARGIN_SCALE",
        0.5,
      ),
      shadowModeEnabled: readBoolean("AUTO_TRADE_SHADOW_MODE_ENABLED", true),
      auditEnabled: readBoolean("AUTO_TRADE_AUDIT_ENABLED", true),
      shadowStateFile: path.resolve(
        process.cwd(),
        readOptional("AUTO_TRADE_SHADOW_STATE_FILE", ".state/strategy-shadow.json"),
      ),
      auditLogFile: path.resolve(
        process.cwd(),
        readOptional("AUTO_TRADE_AUDIT_LOG_FILE", ".state/strategy-audit.jsonl"),
      ),
      shadowFeeRate: readOptionalNumber("AUTO_TRADE_SHADOW_FEE_RATE", 0.0005),
      stateFile: path.resolve(
        process.cwd(),
        readOptional("AUTO_TRADE_STATE_FILE", ".state/auto-trade-real-default.json"),
      ),
    },
  };
  config.accounts = buildAccountConfigs(config);
  return config;
}
