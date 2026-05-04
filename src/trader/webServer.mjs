import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BinanceApiError } from "../binance/futuresRestClient.mjs";
import { AutoScanFeishuService } from "./autoScanFeishuService.mjs";
import { AutoTradeService } from "./autoTradeService.mjs";
import { loadTraderConfig } from "./traderConfig.mjs";
import { TraderRuntime } from "./runtime.mjs";
import { upsertEnvFile } from "./envFile.mjs";
import { FeishuNotifier } from "../notifiers/feishuNotifier.mjs";
import { StrategyAuditLogger } from "./strategyAudit.mjs";
import { StrategyCoordinator } from "./strategyCoordinator.mjs";
import { StrategyShadowBook } from "./strategyShadow.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "web");
const config = loadTraderConfig();
const accountConfigs = config.accounts?.length
  ? config.accounts
  : [{ ...config, accountId: "default", accountLabel: "default" }];
const runtime = new TraderRuntime(accountConfigs[0]);
const strategyAuditLogger = new StrategyAuditLogger({
  filePath: accountConfigs[0].autoTrade.auditLogFile,
  enabled: accountConfigs[0].autoTrade.auditEnabled !== false,
});
const strategyShadowBook = new StrategyShadowBook({
  filePath: accountConfigs[0].autoTrade.shadowStateFile,
  enabled: accountConfigs[0].autoTrade.shadowModeEnabled !== false,
  defaultNotionalUsdt: Number(accountConfigs[0].autoTrade.orderMarginUsdt ?? 20) * Number(config.auto.defaultLeverage ?? 5),
  feeRate: Number(accountConfigs[0].autoTrade.shadowFeeRate ?? 0.0005),
});
const strategyCoordinator = new StrategyCoordinator({
  runtime,
  config: accountConfigs[0].autoTrade,
  shadowBook: strategyShadowBook,
  auditLogger: strategyAuditLogger,
});
const autoScanFeishuService = new AutoScanFeishuService({
  runtime,
  config: config.autoFeishu,
  strategy: strategyCoordinator,
});
const tradeNotifier =
  config.autoTradeFeishu?.enabled && config.autoTradeFeishu?.webhookUrl
    ? new FeishuNotifier({
        webhookUrl: config.autoTradeFeishu.webhookUrl,
        messageStyle: config.autoTradeFeishu.messageStyle,
      })
    : null;
const autoTradeServices = accountConfigs.map((accountConfig) => {
  const accountRuntime =
    accountConfig === accountConfigs[0] ? runtime : new TraderRuntime(accountConfig);
  return new AutoTradeService({
    runtime: accountRuntime,
    config: accountConfig.autoTrade,
    strategy: strategyCoordinator,
    notifier: tradeNotifier,
    accountId: accountConfig.accountId,
    accountLabel: accountConfig.accountLabel,
  });
});
const autoTradeService = autoTradeServices[0];
const ACCOUNT_SNAPSHOT_CACHE_TTL_MS = Number(process.env.TRADER_ACCOUNT_SNAPSHOT_CACHE_TTL_MS ?? 15000);
const accountSnapshotCache = new Map();
const accountRuntimeCache = new Map();
let accountConfigStore = config.accounts?.length
  ? config.accounts.map((account) => ({
      id: account.accountId,
      label: account.accountLabel,
      apiKey: account.apiKey ?? "",
      apiSecret: account.apiSecret ?? "",
      baseUrl: account.baseUrl ?? config.baseUrl,
      dryRun: account.dryRun ?? config.dryRun,
      orderMarginUsdt: account.autoTrade?.orderMarginUsdt,
      maxTotalRiskUsdt: account.autoTrade?.maxTotalRiskUsdt,
      maxOrdersPerRun: account.autoTrade?.maxOrdersPerRun,
      minConfidence: account.autoTrade?.minConfidence,
      maxOpenPositions: account.autoTrade?.maxOpenPositions,
    }))
  : [];

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

function listAccessUrls(host, port) {
  if (host !== "0.0.0.0" && host !== "::") {
    return [`http://${host}:${port}`];
  }

  const urls = new Set([`http://127.0.0.1:${port}`]);
  for (const group of Object.values(os.networkInterfaces())) {
    for (const address of group ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      urls.add(`http://${address.address}:${port}`);
    }
  }

  return Array.from(urls);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function maskValue(value) {
  const raw = String(value ?? "");
  if (!raw) {
    return "";
  }

  if (raw.length <= 8) {
    return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  }

  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

function safeAccountId(value, fallback) {
  const id = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || fallback;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function publicAccount(account) {
  return {
    id: account.id,
    label: account.label,
    baseUrl: account.baseUrl,
    dryRun: Boolean(account.dryRun),
    hasApiKey: Boolean(account.apiKey),
    hasApiSecret: Boolean(account.apiSecret),
    apiKeyPreview: maskValue(account.apiKey),
    orderMarginUsdt: account.orderMarginUsdt,
    maxTotalRiskUsdt: account.maxTotalRiskUsdt,
    maxOrdersPerRun: account.maxOrdersPerRun,
    minConfidence: account.minConfidence,
    maxOpenPositions: account.maxOpenPositions,
  };
}

function normalizeAccountConfig(input, index, previous) {
  const id = safeAccountId(input?.id ?? input?.label, `account-${index + 1}`);
  const apiKey = String(input?.apiKey ?? "").trim() || previous?.apiKey || "";
  const apiSecret = String(input?.apiSecret ?? "").trim() || previous?.apiSecret || "";
  if (!apiKey || !apiSecret) {
    throw new Error(`账户 ${id} 缺少 API Key / Secret。`);
  }

  const account = {
    id,
    label: String(input?.label ?? previous?.label ?? id).trim() || id,
    apiKey,
    apiSecret,
    baseUrl: String(input?.baseUrl ?? previous?.baseUrl ?? config.baseUrl).trim() || config.baseUrl,
    dryRun: input?.dryRun !== undefined ? Boolean(input.dryRun) : Boolean(previous?.dryRun ?? config.dryRun),
  };

  for (const key of [
    "orderMarginUsdt",
    "maxTotalRiskUsdt",
    "maxOrdersPerRun",
    "minConfidence",
    "maxOpenPositions",
  ]) {
    const value = optionalNumber(input?.[key] ?? previous?.[key]);
    if (value !== undefined) {
      account[key] = value;
    }
  }

  return account;
}

async function updateAccountConfigs(body) {
  const rawAccounts = Array.isArray(body?.accounts) ? body.accounts : [];
  if (rawAccounts.length > 20) {
    throw new Error("最多支持 20 个账户。");
  }

  const previousById = new Map(accountConfigStore.map((account) => [account.id, account]));
  const seen = new Set();
  const accounts = rawAccounts.map((input, index) => {
    const candidateId = safeAccountId(input?.id ?? input?.label, `account-${index + 1}`);
    const previous = previousById.get(candidateId) ?? accountConfigStore[index];
    const account = normalizeAccountConfig(input, index, previous);
    if (seen.has(account.id)) {
      throw new Error(`账户 ID 重复：${account.id}`);
    }
    seen.add(account.id);
    return account;
  });

  accountConfigStore = accounts;
  await upsertEnvFile(config.envFile, {
    TRADER_ACCOUNTS_JSON: JSON.stringify(accounts),
  });

  return {
    accounts: accounts.map(publicAccount),
    restartRequired: true,
  };
}

function buildAccountRuntimeConfig(account, index = 0) {
  const id = safeAccountId(account?.id, `account-${index + 1}`);
  const autoTradeOverrides = {};
  for (const key of [
    "orderMarginUsdt",
    "maxTotalRiskUsdt",
    "maxOrdersPerRun",
    "minConfidence",
    "maxOpenPositions",
  ]) {
    if (account?.[key] !== undefined) {
      autoTradeOverrides[key] = account[key];
    }
  }

  return {
    ...config,
    accountId: id,
    accountLabel: String(account?.label ?? id),
    apiKey: String(account?.apiKey ?? ""),
    apiSecret: String(account?.apiSecret ?? ""),
    baseUrl: String(account?.baseUrl ?? config.baseUrl),
    dryRun: account?.dryRun !== undefined ? Boolean(account.dryRun) : config.dryRun,
    autoTrade: {
      ...config.autoTrade,
      ...autoTradeOverrides,
      stateFile: path.resolve(process.cwd(), `.state/auto-trade-real-${id}.json`),
      auditLogFile: path.resolve(process.cwd(), `.state/strategy-audit-${id}.jsonl`),
    },
  };
}

function accountSnapshotCacheKey(account, index) {
  return [
    safeAccountId(account?.id, `account-${index + 1}`),
    account?.baseUrl ?? config.baseUrl,
    account?.apiKey ?? "",
    Boolean(account?.dryRun ?? config.dryRun),
  ].join("::");
}

function getCachedAccountRuntime(account, index) {
  const key = accountSnapshotCacheKey(account, index);
  const cached = accountRuntimeCache.get(key);
  if (cached) {
    return cached;
  }

  const accountRuntime = new TraderRuntime(buildAccountRuntimeConfig(account, index));
  accountRuntimeCache.set(key, accountRuntime);
  return accountRuntime;
}

async function getAccountSnapshotCached(account, index, { forceRefresh = false } = {}) {
  const key = accountSnapshotCacheKey(account, index);
  const now = Date.now();
  const cached = accountSnapshotCache.get(key);
  const ttl = Number.isFinite(ACCOUNT_SNAPSHOT_CACHE_TTL_MS)
    ? Math.max(5000, ACCOUNT_SNAPSHOT_CACHE_TTL_MS)
    : 15000;

  if (!forceRefresh && cached?.value && now - cached.fetchedAt < ttl) {
    return {
      ...cached.value,
      cached: true,
    };
  }

  if (!forceRefresh && cached?.promise) {
    return cached.promise;
  }

  const promise = (async () => {
    try {
      const accountRuntime = getCachedAccountRuntime(account, index);
      const value = {
        id: account.id,
        label: account.label,
        ok: true,
        snapshot: await accountRuntime.getAccountSnapshot(),
      };
      accountSnapshotCache.set(key, {
        fetchedAt: Date.now(),
        value,
      });
      return value;
    } catch (error) {
      if (cached?.value) {
        return {
          ...cached.value,
          cached: true,
          stale: true,
          warning: error?.message || String(error),
        };
      }

      return {
        id: account.id,
        label: account.label,
        ok: false,
        error: error?.message || String(error),
      };
    } finally {
      const latest = accountSnapshotCache.get(key);
      if (latest?.promise === promise) {
        delete latest.promise;
      }
    }
  })();

  accountSnapshotCache.set(key, {
    ...(cached ?? {}),
    promise,
  });
  return promise;
}

function getSnapshotAccounts() {
  if (accountConfigStore.length) {
    return accountConfigStore;
  }

  if (!config.apiKey || !config.apiSecret) {
    return [];
  }

  return [
    {
      id: "default",
      label: "default",
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      baseUrl: config.baseUrl,
      dryRun: config.dryRun,
    },
  ];
}

async function getAccountSnapshots({ forceRefresh = false } = {}) {
  const accounts = getSnapshotAccounts();
  return Promise.all(
    accounts.map((account, index) =>
      getAccountSnapshotCached(account, index, { forceRefresh }),
    ),
  );
}

function sendText(response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(text);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new Error("请求体过大。");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法的 JSON。");
  }
}

async function serveStatic(requestPath, response) {
  const match = STATIC_FILES.get(requestPath);
  if (!match) {
    return false;
  }

  const filePath = path.join(webRoot, match.file);
  const content = await fs.readFile(filePath, "utf8");
  sendText(response, 200, content, match.type);
  return true;
}

function buildErrorPayload(error) {
  const payload = {
    error: error?.message || "未知错误",
  };

  if (error instanceof BinanceApiError) {
    payload.code = error.code;
    payload.status = error.status;
    payload.details = error.details;
  }

  if (error?.leveragePossiblyChanged) {
    payload.leveragePossiblyChanged = true;
    payload.updatedLeverage = error.updatedLeverage;
    payload.symbol = error.symbol;
  }

  return payload;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { config: runtime.getPublicConfig() });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/accounts/config") {
    sendJson(response, 200, { accounts: accountConfigStore.map(publicAccount) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/accounts/config") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await updateAccountConfigs(body));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    const config = await runtime.updateConfig(body);
    sendJson(response, 200, { config });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/test") {
    const body = await readJsonBody(request);
    const result = await runtime.testConnection(body);
    sendJson(response, 200, { result });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/symbols") {
    const symbols = await runtime.getSymbols();
    sendJson(response, 200, { symbols });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/account") {
    const snapshot = await runtime.getAccountSnapshot();
    sendJson(response, 200, { snapshot });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/accounts/snapshots") {
    sendJson(response, 200, {
      accounts: await getAccountSnapshots({
        forceRefresh: url.searchParams.get("force") === "1",
      }),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/auto/scan") {
    const scan = await runtime.getAutoScan({
      forceRefresh: url.searchParams.get("force") === "1",
      background: url.searchParams.get("background") === "1",
    });
    sendJson(response, 200, { scan });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/auto/trade/status") {
    const accounts = await Promise.all(autoTradeServices.map((service) => service.getStatus()));
    sendJson(response, 200, { status: accounts[0], accounts });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/strategy/regime") {
    const symbol = url.searchParams.get("symbol") || "BTCUSDT";
    const action = url.searchParams.get("action");
    const regime = await strategyCoordinator.getRegime({
      symbol,
      candidate: action ? { symbol, action } : null,
      forceRefresh: url.searchParams.get("force") === "1",
    });
    sendJson(response, 200, { regime });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/strategy/diagnostics") {
    const diagnostics = await strategyCoordinator.getDiagnostics();
    sendJson(response, 200, { diagnostics });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auto/trade/run") {
    const results = await Promise.all(
      autoTradeServices.map((service) => service.runOnce({ forceEntryScan: true })),
    );
    const accounts = await Promise.all(autoTradeServices.map((service) => service.getStatus()));
    sendJson(response, 200, { result: results[0], results, status: accounts[0], accounts });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/analysis") {
    const analysis = await runtime.getMarketAnalysis({
      symbol: url.searchParams.get("symbol"),
      forceRefresh: url.searchParams.get("force") === "1",
    });
    sendJson(response, 200, { analysis });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/square/today") {
    const symbols = (url.searchParams.get("symbols") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const squareNotes = await runtime.getTodaySquareNotes({
      symbols,
      forceRefresh: url.searchParams.get("force") === "1",
    });
    sendJson(response, 200, { squareNotes });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/analysis/square") {
    const body = await readJsonBody(request);
    const squareNotes = runtime.analyzeSquareNotes(body);
    sendJson(response, 200, { squareNotes });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/order/preview") {
    const body = await readJsonBody(request);
    const preview = await runtime.previewOrder(body);
    sendJson(response, 200, { preview });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/order") {
    const body = await readJsonBody(request);
    const result = await runtime.submitOrder(body);
    sendJson(response, 200, result);
    return true;
  }

  return false;
}

function resolveErrorStatus(error) {
  if (error instanceof BinanceApiError) {
    return 400;
  }

  if (error instanceof Error) {
    return 400;
  }

  return 500;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url);
      if (!handled) {
        sendJson(response, 404, { error: "接口不存在。" });
      }
      return;
    }

    const handled = await serveStatic(url.pathname, response);
    if (!handled) {
      sendText(response, 404, "Not Found");
    }
  } catch (error) {
    sendJson(response, resolveErrorStatus(error), buildErrorPayload(error));
  }
});

server.listen(runtime.config.webPort, runtime.config.webHost, () => {
  console.log("Binance Futures Trader Web");
  console.log(`Listening on ${runtime.config.webHost}:${runtime.config.webPort}`);
  for (const url of listAccessUrls(runtime.config.webHost, runtime.config.webPort)) {
    console.log(`Open: ${url}`);
  }
  if (runtime.config.webHost === "0.0.0.0" || runtime.config.webHost === "::") {
    console.log("Remote access: use http://<server-ip>:<port> from your local browser.");
  }
  console.log(`Trading mode: ${runtime.config.dryRun ? "dry-run" : "real trading"}`);
  if (autoScanFeishuService.start({ immediate: true })) {
    console.log(
      `Auto scan Feishu push: enabled every ${Math.round(config.autoFeishu.intervalMs / 1000)}s`,
    );
  }
  for (const service of autoTradeServices) {
    if (service.start({ immediate: true })) {
      console.log(
        `Auto real trade [${service.accountLabel}]: enabled every ${Math.round(service.config.intervalMs / 1000)}s`,
      );
    }
  }
});

function shutdown() {
  autoScanFeishuService.stop();
  for (const service of autoTradeServices) {
    service.stop();
  }
  server.close(() => {
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
