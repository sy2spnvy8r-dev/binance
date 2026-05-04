import path from "node:path";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function readOptional(name, fallback = "") {
  return process.env[name]?.trim() ?? fallback;
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

function readNumber(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
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

function readJsonObject(name, fallback = {}) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Environment variable ${name} must be a JSON object`);
  }

  return parsed;
}

function readQueryParams(name, fallback = "") {
  const value = process.env[name]?.trim() ?? fallback;
  return Object.fromEntries(new URLSearchParams(value));
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
}

function resolveStateFile() {
  const configured = readOptional("STATE_FILE", ".state/events.json");
  return path.resolve(process.cwd(), configured);
}

function resolveCopyTradeStateFile(entityValue) {
  const configured = readOptional(
    "COPY_TRADE_STATE_FILE",
    `.state/copy-trade-${entityValue || "default"}.json`,
  );
  return path.resolve(process.cwd(), configured);
}

function deriveEntityLabel(queryParams) {
  if (queryParams.topTraderId) {
    return "交易员ID";
  }

  if (queryParams.portfolioId) {
    return "项目ID";
  }

  return "监控对象";
}

function deriveEntityValue(queryParams) {
  return queryParams.topTraderId || queryParams.portfolioId || "";
}

export function loadConfig() {
  const legacyPortfolioId = readOptional("COPY_TRADE_PORTFOLIO_ID");
  const defaultQueryParams = legacyPortfolioId ? `portfolioId=${legacyPortfolioId}` : "";
  const queryParams = readQueryParams("COPY_TRADE_QUERY_PARAMS", defaultQueryParams);
  const defaultSourceType =
    Object.keys(queryParams).length > 0 ? "binance_copy_trade_lead_positions" : "binance_spot_user_stream";
  const sourceType = readOptional("SOURCE_TYPE", defaultSourceType);
  const notifierTypes = readList("NOTIFIERS", ["feishu"]);
  const defaultMonitorEvents =
    sourceType === "binance_copy_trade_lead_positions"
      ? ["copyTradeLeadPositionsSnapshot"]
      : [
          "executionReport",
          "balanceUpdate",
          "outboundAccountPosition",
          "externalLockUpdate",
          "eventStreamTerminated",
        ];
  const monitorEvents = new Set(readList("MONITOR_EVENTS", defaultMonitorEvents));
  const symbolAllowlist = new Set(readList("SYMBOL_ALLOWLIST", []));
  const entityLabel = readOptional("COPY_TRADE_ENTITY_LABEL", deriveEntityLabel(queryParams));
  const entityValue = readOptional("COPY_TRADE_ENTITY_VALUE", deriveEntityValue(queryParams));

  const config = {
    dryRun: readBoolean("DRY_RUN", false),
    sourceType,
    notifierTypes,
    messagePrefix: readOptional("MESSAGE_PREFIX", "[Binance Monitor]"),
    monitorEvents,
    symbolAllowlist,
    stateFile: resolveStateFile(),
    stateMaxEntries: readNumber("STATE_MAX_ENTRIES", 1000),
    binance: {
      apiKey: readOptional("BINANCE_API_KEY"),
      apiSecret: readOptional("BINANCE_API_SECRET"),
      wsUrl: readOptional("BINANCE_WS_URL", "wss://ws-api.binance.com:443/ws-api/v3"),
    },
    copyTrade: {
      apiUrl: readOptional(
        "COPY_TRADE_SOURCE_URL",
        "https://www.binance.com/bapi/asset/v1/private/future/smart-money/profile/query-positions",
      ),
      queryParams,
      headers: compactObject({
        csrftoken: readOptional("COPY_TRADE_HEADER_CSRFTOKEN"),
        "bnc-uuid": readOptional("COPY_TRADE_HEADER_BNC_UUID"),
        cookie: readOptional("COPY_TRADE_HEADER_COOKIE"),
        clienttype: readOptional("COPY_TRADE_HEADER_CLIENTTYPE", "web"),
        accept: readOptional("COPY_TRADE_HEADER_ACCEPT", "application/json, text/plain, */*"),
        "user-agent": readOptional("COPY_TRADE_HEADER_USER_AGENT", "Mozilla/5.0"),
        referer: readOptional("COPY_TRADE_HEADER_REFERER"),
        origin: readOptional("COPY_TRADE_HEADER_ORIGIN"),
        ...readJsonObject("COPY_TRADE_EXTRA_HEADERS_JSON", {}),
      }),
      pollIntervalMs: readNumber("COPY_TRADE_POLL_INTERVAL_MS", 60_000),
      stateFile: resolveCopyTradeStateFile(entityValue),
      activeOnly: readBoolean("COPY_TRADE_ACTIVE_ONLY", true),
      includeInitialSnapshot: readBoolean("COPY_TRADE_INCLUDE_INITIAL_SNAPSHOT", true),
      sendStartupSnapshot: readBoolean("COPY_TRADE_SEND_STARTUP_SNAPSHOT", true),
      entityLabel,
      entityValue,
      responseItemsPath: readOptional("COPY_TRADE_RESPONSE_ITEMS_PATH", "data"),
      expectedCode: readOptional("COPY_TRADE_EXPECTED_CODE", "000000"),
    },
    notifiers: {
      feishu: {
        webhookUrl: readOptional("FEISHU_WEBHOOK_URL"),
        messageStyle: readOptional("FEISHU_MESSAGE_STYLE", "interactive_table"),
      },
      telegram: {
        botToken: readOptional("TELEGRAM_BOT_TOKEN"),
        chatId: readOptional("TELEGRAM_CHAT_ID"),
      },
      wecom: {
        webhookUrl: readOptional("WECOM_WEBHOOK_URL"),
      },
      dingtalk: {
        webhookUrl: readOptional("DINGTALK_WEBHOOK_URL"),
      },
      slack: {
        webhookUrl: readOptional("SLACK_WEBHOOK_URL"),
      },
      genericWebhook: {
        webhookUrl: readOptional("GENERIC_WEBHOOK_URL"),
      },
    },
  };

  if (config.notifierTypes.length === 0) {
    throw new Error("At least one notifier must be configured in NOTIFIERS");
  }

  if (sourceType === "binance_spot_user_stream") {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
      throw new Error(
        "BINANCE_API_KEY and BINANCE_API_SECRET are required for SOURCE_TYPE=binance_spot_user_stream",
      );
    }
  }

  if (sourceType === "binance_copy_trade_lead_positions") {
    if (Object.keys(config.copyTrade.queryParams).length === 0) {
      throw new Error(
        "COPY_TRADE_QUERY_PARAMS is required for SOURCE_TYPE=binance_copy_trade_lead_positions",
      );
    }

    if (!config.copyTrade.entityValue) {
      throw new Error(
        "COPY_TRADE_ENTITY_VALUE is empty. Provide it explicitly or include topTraderId/portfolioId in COPY_TRADE_QUERY_PARAMS",
      );
    }
  }

  return config;
}
