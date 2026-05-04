const AUTO_REFRESH_INTERVAL_MS = 15000;
const ANALYSIS_REFRESH_INTERVAL_MS = 60000;
const AUTO_SCAN_REFRESH_INTERVAL_MS = 900000;
const FUTURES_ENVIRONMENTS = {
  mainnet: {
    label: "正式盘",
    baseUrl: "https://fapi.binance.com",
  },
  testnet: {
    label: "测试网",
    baseUrl: "https://demo-fapi.binance.com",
  },
};

const state = {
  config: null,
  snapshot: null,
  preview: null,
  analysis: null,
  autoScan: null,
  squareNotes: null,
  accountsConfig: [],
  symbols: [],
  autoRefreshEnabled: true,
  autoRefreshTimer: null,
  analysisRefreshTimer: null,
  autoScanTimer: null,
  refreshInFlight: false,
  refreshPromise: null,
  analysisInFlight: false,
  analysisPromise: null,
  autoScanInFlight: false,
  autoScanPromise: null,
  autoRefreshErrorShown: false,
  analysisErrorShown: false,
};

const elements = {
  modePill: document.querySelector("#mode-pill"),
  credentialPill: document.querySelector("#credential-pill"),
  livePill: document.querySelector("#live-pill"),
  autoRefreshToggle: document.querySelector("#auto-refresh-toggle"),
  apiKey: document.querySelector("#api-key"),
  apiSecret: document.querySelector("#api-secret"),
  environmentSelect: document.querySelector("#environment-select"),
  baseUrl: document.querySelector("#base-url"),
  recvWindow: document.querySelector("#recv-window"),
  dryRun: document.querySelector("#dry-run"),
  saveConfig: document.querySelector("#save-config"),
  configHint: document.querySelector("#config-hint"),
  configForm: document.querySelector("#config-form"),
  testConnection: document.querySelector("#test-connection"),
  refreshAccount: document.querySelector("#refresh-account"),
  reloadConfig: document.querySelector("#reload-config"),
  accountConfigList: document.querySelector("#account-config-list"),
  addAccount: document.querySelector("#add-account"),
  saveAccounts: document.querySelector("#save-accounts"),
  accountsHint: document.querySelector("#accounts-hint"),
  metrics: document.querySelector("#metrics"),
  accountNotes: document.querySelector("#account-notes"),
  accountUpdatedAt: document.querySelector("#account-updated-at"),
  assetsBody: document.querySelector("#assets-body"),
  positionsBody: document.querySelector("#positions-body"),
  refreshAutoScan: document.querySelector("#refresh-auto-scan"),
  autoScanUpdatedAt: document.querySelector("#auto-scan-updated-at"),
  autoScanSummary: document.querySelector("#auto-scan-summary"),
  autoCandidates: document.querySelector("#auto-candidates"),
  refreshAutoTrade: document.querySelector("#refresh-auto-trade"),
  runAutoTrade: document.querySelector("#run-auto-trade"),
  autoTradeStatus: document.querySelector("#auto-trade-status"),
  autoTradeTrades: document.querySelector("#auto-trade-trades"),
  refreshStrategy: document.querySelector("#refresh-strategy"),
  strategyUpdatedAt: document.querySelector("#strategy-updated-at"),
  strategySummary: document.querySelector("#strategy-summary"),
  strategyDetails: document.querySelector("#strategy-details"),
  analysisSymbol: document.querySelector("#analysis-symbol"),
  refreshAnalysis: document.querySelector("#refresh-analysis"),
  analysisUpdatedAt: document.querySelector("#analysis-updated-at"),
  analysisSignal: document.querySelector("#analysis-signal"),
  analysisGrid: document.querySelector("#analysis-grid"),
  analysisReasons: document.querySelector("#analysis-reasons"),
  analysisPositionChips: document.querySelector("#analysis-position-chips"),
  squareText: document.querySelector("#square-text"),
  refreshSquareToday: document.querySelector("#refresh-square-today"),
  analyzeSquare: document.querySelector("#analyze-square"),
  squareResult: document.querySelector("#square-result"),
  orderAnalysisNote: document.querySelector("#order-analysis-note"),
  orderForm: document.querySelector("#order-form"),
  intent: document.querySelector("#intent"),
  symbol: document.querySelector("#symbol"),
  sizeLabel: document.querySelector("#size-label"),
  sizeInput: document.querySelector("#size-input"),
  sizeHint: document.querySelector("#size-hint"),
  price: document.querySelector("#price"),
  leverage: document.querySelector("#leverage"),
  leverageField: document.querySelector("#leverage-field"),
  symbolList: document.querySelector("#symbol-list"),
  previewBox: document.querySelector("#preview-box"),
  previewOrder: document.querySelector("#preview-order"),
  submitOrder: document.querySelector("#submit-order"),
  logList: document.querySelector("#log-list"),
  clearLog: document.querySelector("#clear-log"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayValue(value, fallback = "-") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value);
}

function displayNumber(value, digits = 4, fallback = "暂无") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed.toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
}

function displayPercent(value, digits = 2, fallback = "暂无") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return `${parsed.toFixed(digits)}%`;
}

function displayFundingRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "暂无";
  }

  return `${(parsed * 100).toFixed(4)}%`;
}

function hasCredentials(config = state.config) {
  return Boolean(config?.hasApiKey && config?.hasApiSecret);
}

function hasAccountCredentials() {
  return (
    hasCredentials() ||
    (state.accountsConfig ?? []).some((account) => account.hasApiKey && account.hasApiSecret)
  );
}

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

function detectEnvironment(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  for (const [id, environment] of Object.entries(FUTURES_ENVIRONMENTS)) {
    if (normalizeBaseUrl(environment.baseUrl) === normalized) {
      return id;
    }
  }

  return "custom";
}

function getEnvironmentLabel(config = state.config) {
  if (config?.environmentLabel) {
    return config.environmentLabel;
  }

  const id = detectEnvironment(config?.baseUrl ?? elements.baseUrl.value);
  return FUTURES_ENVIRONMENTS[id]?.label ?? "自定义";
}

function syncEnvironmentSelect(baseUrl) {
  if (!elements.environmentSelect) {
    return;
  }

  elements.environmentSelect.value = detectEnvironment(baseUrl);
}

function getConfigPayload({ save = elements.saveConfig.checked } = {}) {
  const payload = {
    baseUrl: elements.baseUrl.value.trim(),
    recvWindow: Number(elements.recvWindow.value),
    dryRun: elements.dryRun.checked,
    save,
  };

  if (elements.apiKey.value.trim()) {
    payload.apiKey = elements.apiKey.value.trim();
  }

  if (elements.apiSecret.value.trim()) {
    payload.apiSecret = elements.apiSecret.value.trim();
  }

  return payload;
}

function applyEnvironmentSelection() {
  const selected = elements.environmentSelect?.value;
  const environment = FUTURES_ENVIRONMENTS[selected];
  if (environment) {
    elements.baseUrl.value = environment.baseUrl;
  }

  const label = environment?.label ?? "自定义";
  const extra =
    selected === "testnet"
      ? "测试网必须使用 Futures Testnet / Demo 单独生成的 API Key，正式盘 Key 不能通用。"
      : "如需测试网，选择“测试网”即可自动填入官方测试网地址。";
  elements.configHint.textContent = `${label}：${extra}`;
}

function isOpenIntent(intent = elements.intent.value) {
  return intent === "open_long" || intent === "open_short";
}

function clearAutoRefreshTimer() {
  if (state.autoRefreshTimer) {
    clearTimeout(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

function clearAnalysisRefreshTimer() {
  if (state.analysisRefreshTimer) {
    clearTimeout(state.analysisRefreshTimer);
    state.analysisRefreshTimer = null;
  }
}

function clearAutoScanTimer() {
  if (state.autoScanTimer) {
    clearTimeout(state.autoScanTimer);
    state.autoScanTimer = null;
  }
}

function updateLiveStatus({ text, tone = "live" } = {}) {
  const pill = elements.livePill;
  if (!pill) {
    return;
  }

  if (text) {
    pill.textContent = text;
  }

  pill.classList.remove("live", "paused", "syncing", "warning");
  pill.classList.add(tone);
}

function renderLog(message, tone = "info") {
  const item = document.createElement("article");
  item.className = `log-item ${tone}`;
  item.innerHTML = `
    <span class="log-time">${new Date().toLocaleTimeString()}</span>
    <p>${escapeHtml(message)}</p>
  `;
  elements.logList.prepend(item);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    Object.assign(error, payload);
    throw error;
  }

  return payload;
}

function setBusy(target, busy, loadingText) {
  if (!target) {
    return;
  }

  if (busy) {
    target.dataset.originalText = target.textContent;
    target.disabled = true;
    if (loadingText) {
      target.textContent = loadingText;
    }
    return;
  }

  target.disabled = false;
  if (target.dataset.originalText) {
    target.textContent = target.dataset.originalText;
  }
}

function updateModeUi() {
  if (!state.config) {
    return;
  }

  elements.modePill.textContent = `${getEnvironmentLabel()} · ${
    state.config.dryRun ? "Dry Run" : "Real Trading"
  }`;
  elements.modePill.classList.toggle("danger", !state.config.dryRun);
  if (hasCredentials()) {
    elements.credentialPill.textContent = `已配置 API ${state.config.apiKeyPreview || ""}`;
  } else if (hasAccountCredentials()) {
    elements.credentialPill.textContent = `已配置 ${state.accountsConfig.length} 个账户`;
  } else {
    elements.credentialPill.textContent = "未配置 API";
  }
}

function updateSizeField() {
  if (isOpenIntent()) {
    elements.sizeLabel.textContent = "保证金";
    elements.sizeInput.placeholder = "10";
    elements.sizeHint.textContent =
      "开仓时输入保证金，系统会按 保证金 × 杠杆 / 限价 自动换算下单数量。";
    elements.leverageField.classList.remove("muted");
    elements.leverage.disabled = false;
    return;
  }

  elements.sizeLabel.textContent = "数量";
  elements.sizeInput.placeholder = "0.001";
  elements.sizeHint.textContent = "平仓时直接输入要平掉的数量。";
  elements.leverageField.classList.add("muted");
  elements.leverage.disabled = true;
}

function renderConfig(config) {
  state.config = config;
  elements.baseUrl.value = config.baseUrl;
  syncEnvironmentSelect(config.baseUrl);
  elements.recvWindow.value = config.recvWindow;
  elements.dryRun.checked = Boolean(config.dryRun);
  elements.apiKey.value = "";
  elements.apiSecret.value = "";
  elements.configHint.textContent =
    hasCredentials(config)
      ? `${getEnvironmentLabel(config)}：当前已检测到 API 凭证${
          config.apiKeyPreview ? ` (${config.apiKeyPreview})` : ""
        }。留空表示继续使用当前值。`
      : `${getEnvironmentLabel(config)}：尚未配置 API Key / Secret，保存后即可连接账户。`;
  updateModeUi();
}

function accountCardHtml(account = {}, index = 0) {
  const id = account.id ?? `account-${index + 1}`;
  const label = account.label ?? id;
  const apiKeyPlaceholder = account.hasApiKey
    ? `已配置 ${account.apiKeyPreview || ""}，留空不改`
    : "输入 API Key";
  const apiSecretPlaceholder = account.hasApiSecret ? "已配置，留空不改" : "输入 API Secret";
  const existing = account.hasApiKey || account.hasApiSecret ? "1" : "0";

  return `
    <article class="account-config-card" data-existing="${existing}">
      <div class="account-config-head">
        <strong>${escapeHtml(label || id)}</strong>
        <button class="ghost-button compact-button remove-account" type="button">删除</button>
      </div>
      <div class="form-grid account-form-grid">
        <label>
          <span>账户 ID</span>
          <input data-field="id" autocomplete="off" value="${escapeHtml(id)}" placeholder="main" />
        </label>
        <label>
          <span>显示名称</span>
          <input data-field="label" autocomplete="off" value="${escapeHtml(label)}" placeholder="主账户" />
        </label>
        <label>
          <span>API Key</span>
          <input data-field="apiKey" autocomplete="off" placeholder="${escapeHtml(apiKeyPlaceholder)}" />
        </label>
        <label>
          <span>API Secret</span>
          <input data-field="apiSecret" type="password" autocomplete="off" placeholder="${escapeHtml(apiSecretPlaceholder)}" />
        </label>
        <label>
          <span>Base URL</span>
          <input data-field="baseUrl" autocomplete="off" value="${escapeHtml(account.baseUrl ?? state.config?.baseUrl ?? "")}" />
        </label>
        <label>
          <span>单笔保证金 U</span>
          <input data-field="orderMarginUsdt" type="number" min="0" step="0.01" value="${escapeHtml(account.orderMarginUsdt ?? "")}" placeholder="20" />
        </label>
        <label>
          <span>总风险上限 U</span>
          <input data-field="maxTotalRiskUsdt" type="number" min="0" step="0.01" value="${escapeHtml(account.maxTotalRiskUsdt ?? "")}" placeholder="100" />
        </label>
        <label>
          <span>最低信心</span>
          <input data-field="minConfidence" type="number" min="0" max="100" step="1" value="${escapeHtml(account.minConfidence ?? "")}" placeholder="80" />
        </label>
      </div>
      <label class="toggle account-toggle">
        <input data-field="dryRun" type="checkbox" ${account.dryRun ? "checked" : ""} />
        <span>Dry Run</span>
      </label>
    </article>
  `;
}

function renderAccountsConfig(accounts = []) {
  state.accountsConfig = accounts;
  if (!elements.accountConfigList) {
    return;
  }

  elements.accountConfigList.innerHTML = "";
  if (!accounts.length) {
    elements.accountConfigList.innerHTML =
      `<div class="empty-cell">还没有多账户配置，点击“添加账户”开始。</div>`;
    elements.accountsHint.textContent =
      "保存后会写入 TRADER_ACCOUNTS_JSON；自动交易读取新账户需要重启服务。";
    return;
  }

  for (const [index, account] of accounts.entries()) {
    elements.accountConfigList.insertAdjacentHTML("beforeend", accountCardHtml(account, index));
  }
  elements.accountsHint.textContent = `已配置 ${accounts.length} 个账户；Secret 不回显，留空不改。`;
}

function addAccountCard() {
  if (elements.accountConfigList.querySelector(".empty-cell")) {
    elements.accountConfigList.innerHTML = "";
  }

  const index = elements.accountConfigList.querySelectorAll(".account-config-card").length;
  elements.accountConfigList.insertAdjacentHTML(
    "beforeend",
    accountCardHtml(
      {
        id: `account-${index + 1}`,
        label: `账户 ${index + 1}`,
        baseUrl: state.config?.baseUrl,
        dryRun: state.config?.dryRun,
      },
      index,
    ),
  );
}

function optionalInputNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectAccountsConfig() {
  return Array.from(elements.accountConfigList.querySelectorAll(".account-config-card"))
    .map((card) => {
      const field = (name) => card.querySelector(`[data-field="${name}"]`);
      return {
        id: field("id")?.value.trim(),
        label: field("label")?.value.trim(),
        apiKey: field("apiKey")?.value.trim(),
        apiSecret: field("apiSecret")?.value.trim(),
        baseUrl: field("baseUrl")?.value.trim(),
        dryRun: field("dryRun")?.checked,
        orderMarginUsdt: optionalInputNumber(field("orderMarginUsdt")?.value),
        maxTotalRiskUsdt: optionalInputNumber(field("maxTotalRiskUsdt")?.value),
        minConfidence: optionalInputNumber(field("minConfidence")?.value),
      };
    })
    .filter(
      (account) =>
        account.id || account.label || account.apiKey || account.apiSecret || account.baseUrl,
    );
}

function renderMetrics(snapshot) {
  const { summary } = snapshot;
  const metrics = [
    { label: "持仓模式", value: summary.positionMode },
    { label: "总钱包余额", value: summary.totalWalletBalance },
    { label: "可用余额", value: summary.availableBalance },
    { label: "未实现盈亏", value: summary.totalUnrealizedProfit },
    { label: "最大可转出", value: summary.maxWithdrawAmount },
  ];

  elements.metrics.innerHTML = metrics
    .map(
      (item) => `
        <article class="metric-card">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>
      `,
    )
    .join("");
}

function renderAssets(assets) {
  if (!assets.length) {
    elements.assetsBody.innerHTML = `<tr><td colspan="4" class="empty-cell">暂无非零资产</td></tr>`;
    return;
  }

  elements.assetsBody.innerHTML = assets
    .map(
      (asset) => `
        <tr>
          <td>${escapeHtml(asset.asset)}</td>
          <td>${escapeHtml(asset.walletBalance)}</td>
          <td>${escapeHtml(asset.availableBalance)}</td>
          <td>${escapeHtml(asset.unrealizedProfit)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderPositions(positions) {
  if (!positions.length) {
    elements.positionsBody.innerHTML = `<tr><td colspan="8" class="empty-cell">暂无持仓</td></tr>`;
    return;
  }

  elements.positionsBody.innerHTML = positions
    .map(
      (position) => `
        <tr>
          <td>${escapeHtml(position.symbol)}</td>
          <td>${escapeHtml(position.direction)}</td>
          <td>${escapeHtml(position.quantity)}</td>
          <td>${escapeHtml(displayValue(position.entryPrice))}</td>
          <td>${escapeHtml(displayValue(position.markPrice))}</td>
          <td>${escapeHtml(displayValue(position.leverage))}</td>
          <td>${escapeHtml(displayValue(position.marginMode))}</td>
          <td>${escapeHtml(position.unrealizedProfit)}</td>
        </tr>
      `,
    )
    .join("");
}

function getAnalysisSymbol() {
  return elements.analysisSymbol.value.trim().toUpperCase();
}

function findPosition(symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  return (state.snapshot?.positions ?? []).find((position) => position.symbol === normalizedSymbol);
}

function calculatePriceDeviation(symbol) {
  const position = findPosition(symbol);
  const entryPrice = Number(position?.entryPrice);
  const markPrice = Number(position?.markPrice);

  if (!Number.isFinite(entryPrice) || !Number.isFinite(markPrice) || entryPrice <= 0) {
    return null;
  }

  return ((markPrice - entryPrice) / entryPrice) * 100;
}

function renderPositionChips(positions = state.snapshot?.positions ?? []) {
  if (!positions.length) {
    elements.analysisPositionChips.innerHTML = `<span class="quiet-pill">暂无持仓合约</span>`;
    return;
  }

  const activeSymbol = getAnalysisSymbol();
  elements.analysisPositionChips.innerHTML = positions
    .map(
      (position) => `
        <button
          class="chip-button${position.symbol === activeSymbol ? " active" : ""}"
          data-symbol="${escapeHtml(position.symbol)}"
          type="button"
        >
          ${escapeHtml(position.symbol)}
        </button>
      `,
    )
    .join("");

  for (const button of elements.analysisPositionChips.querySelectorAll(".chip-button")) {
    button.addEventListener("click", () => {
      const symbol = button.dataset.symbol;
      elements.analysisSymbol.value = symbol;
      elements.symbol.value = symbol;
      renderPositionChips();
      void refreshAnalysis({ silent: false, force: true });
    });
  }
}

function syncDefaultAnalysisSymbol(positions = []) {
  if (getAnalysisSymbol()) {
    renderPositionChips(positions);
    return false;
  }

  const symbol = positions[0]?.symbol || elements.symbol.value.trim().toUpperCase();
  if (!symbol) {
    renderPositionChips(positions);
    return false;
  }

  elements.analysisSymbol.value = symbol;
  if (!elements.symbol.value.trim()) {
    elements.symbol.value = symbol;
  }
  renderPositionChips(positions);
  return true;
}

function signalClass(signal) {
  switch (signal) {
    case "偏多":
      return "bullish";
    case "偏空":
      return "bearish";
    case "风险偏高":
      return "risk";
    default:
      return "neutral";
  }
}

function formatAction(action) {
  switch (action) {
    case "open_long":
      return "开多";
    case "open_short":
      return "开空";
    case "hold":
      return "观望";
    default:
      return action || "-";
  }
}

function getReferenceSymbols() {
  const symbols = [
    elements.analysisSymbol.value,
    elements.symbol.value,
    ...(state.snapshot?.positions ?? []).map((position) => position.symbol),
    ...(state.autoScan?.candidates ?? []).slice(0, 20).map((candidate) => candidate.symbol),
    "BTCUSDT",
    "ETHUSDT",
  ];

  return Array.from(
    new Set(
      symbols
        .map((symbol) => String(symbol ?? "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

function renderAutoScan(scan) {
  state.autoScan = scan;
  const candidates = scan.candidates ?? [];
  if (scan.status === "scanning") {
    elements.autoScanSummary.textContent = "自动分析正在后台扫描，稍后会刷新结果。";
    elements.autoScanUpdatedAt.textContent = `扫描中 ${new Date().toLocaleString()}`;
    elements.autoCandidates.innerHTML = `<div class="empty-cell">正在扫描候选合约...</div>`;
    return;
  }

  elements.autoScanSummary.textContent =
    `${scan.status === "refreshing" ? "后台刷新中，当前缓存：" : ""}扫描 ${scan.prefilteredFrom ?? scan.universeSize ?? 0} 个合约，深扫 ${scan.scannedSymbols ?? 0} 个，候选 ${candidates.length} 个，模型状态 ${scan.llmStatus || "local"}`;
  elements.autoScanUpdatedAt.textContent = `最近扫描 ${new Date().toLocaleString()}`;

  if (!candidates.length) {
    elements.autoCandidates.innerHTML = `<div class="empty-cell">暂无候选</div>`;
    return;
  }

  elements.autoCandidates.innerHTML = candidates
    .slice(0, 8)
    .map(
      (candidate) => `
        <article class="auto-candidate">
          <div>
            <strong>${escapeHtml(candidate.symbol)} · ${escapeHtml(formatAction(candidate.action || candidate.intent))} · ${escapeHtml(candidate.confidence ?? candidate.localScore ?? "-")}</strong>
            <p>入场 ${escapeHtml(candidate.entryPrice ?? candidate.price ?? "-")} / 止损 ${escapeHtml(candidate.stopLoss || "-")} / 止盈 ${escapeHtml(candidate.takeProfit || "-")} / 杠杆 ${escapeHtml(candidate.leverage ?? "-")}x</p>
            <p>${escapeHtml(candidate.reason || candidate.localReason || "-")}</p>
          </div>
          <button class="ghost-button compact-button" data-auto-symbol="${escapeHtml(candidate.symbol)}" type="button">分析</button>
        </article>
      `,
    )
    .join("");

  for (const button of elements.autoCandidates.querySelectorAll("[data-auto-symbol]")) {
    button.addEventListener("click", () => {
      const symbol = button.dataset.autoSymbol;
      elements.analysisSymbol.value = symbol;
      elements.symbol.value = symbol;
      void refreshAnalysis({ silent: false, force: true });
    });
  }
}

function formatAutoTradeResult(result) {
  if (!result) {
    return "暂无运行结果";
  }

  if (result.error) {
    return `最近结果：失败，${result.error}`;
  }

  if (result.skipped) {
    return `最近结果：跳过，${result.reason || "无交易"}`;
  }

  if (result.trade) {
    return `最近结果：已挂单 ${result.trade.symbol} ${formatAction(result.trade.intent)}，保证金 ${result.trade.marginUsdt}U`;
  }

  return "最近结果：已完成";
}

function formatTakeProfitPlan(trade) {
  const plan = trade.takeProfitPlan;
  if (!plan?.legs?.length) {
    return `止盈 ${escapeHtml(trade.takeProfit ?? "-")}`;
  }

  if (plan.mode === "single") {
    const leg = plan.legs[0] ?? {};
    const reason = plan.fallbackReason ? ` / 回退：${escapeHtml(plan.fallbackReason)}` : "";
    return `单一止盈 ${escapeHtml(leg.triggerPrice ?? trade.takeProfit ?? "-")}${reason}`;
  }

  return plan.legs
    .map((leg) => {
      const status = leg.status || (leg.orderId ? "open" : "planned");
      if (leg.kind === "trailing_stop") {
        return `${escapeHtml(leg.label || leg.id)} ${escapeHtml(leg.percent)}%：追踪 ${escapeHtml(leg.quantity ?? "-")} @ 激活 ${escapeHtml(leg.activatePrice ?? "-")} / 回调 ${escapeHtml(leg.callbackRate ?? "-")}% / ${escapeHtml(status)}`;
      }
      return `${escapeHtml(leg.label || leg.id)} ${escapeHtml(leg.percent)}%：${escapeHtml(leg.quantity ?? "-")} @ ${escapeHtml(leg.triggerPrice ?? "-")} / ${escapeHtml(status)}`;
    })
    .join("；");
}

function autoTradeSummaryHtml(status) {
  const budget = status.budget ?? {};
  const enabledText = status.enabled ? "已开启" : "未开启";
  const safetyText = status.safety?.allowed ? "安全锁通过" : "安全锁未通过";
  const environmentText = status.safety?.currentEnvironment || "-";
  const maxOpenPositions = Number(status.config?.maxOpenPositions ?? 1);
  const maxOpenText = maxOpenPositions > 0 ? `${maxOpenPositions} 单` : "按资金不限制";

  return `
    <article class="auto-status-card">
      <strong>${escapeHtml(status.accountLabel || status.accountId || "账户")}</strong>
      <p>总风险 ${escapeHtml(budget.totalRiskUsdt ?? "-")} / ${escapeHtml(budget.maxTotalRiskUsdt ?? "不限制")}U；剩余风险 ${escapeHtml(budget.remainingRiskUsdt ?? "-")}U</p>
      <p>${escapeHtml(enabledText)}；环境 ${escapeHtml(environmentText)}；${escapeHtml(safetyText)}；账户余额 ${escapeHtml(budget.capitalUsdt ?? "-")}U；权益 ${escapeHtml(budget.equityUsdt ?? "-")}U；未实现 ${escapeHtml(budget.unrealizedProfitUsdt ?? "-")}U；可用 ${escapeHtml(budget.availableCapitalUsdt ?? "-")}U</p>
      <p>最多同时 ${escapeHtml(maxOpenText)}；单笔最多 ${escapeHtml(status.config?.orderMarginUsdt ?? 20)}U；最低下单 ${escapeHtml(status.config?.minOrderMarginUsdt ?? 10)}U；每轮最多 ${escapeHtml(status.config?.maxOrdersPerRun ?? 3)} 单；最低信心 ${escapeHtml(status.config?.minConfidence ?? 70)}</p>
      <p>分仓止盈 ${status.config?.splitTakeProfitEnabled ? "已开启" : "未开启"} / 追踪回调 ${escapeHtml(status.config?.trailingCallbackRate ?? "0.8")}%。${escapeHtml(formatAutoTradeResult(status.lastResult))}</p>
    </article>
  `;
}

function autoTradeCardsHtml(status) {
  const trades = status.openTrades ?? [];
  const label = status.accountLabel || status.accountId || "账户";
  const body = trades.length
    ? trades
    .map(
      (trade) => `
        <article class="auto-candidate">
          <div>
            <strong>${escapeHtml(trade.symbol)} · ${escapeHtml(formatAction(trade.intent))} · ${escapeHtml(trade.status)}</strong>
            <p>保证金 ${escapeHtml(trade.marginUsdt)}U / 名义 ${escapeHtml(trade.notionalUsdt)}U / 杠杆 ${escapeHtml(trade.leverage)}x / 数量 ${escapeHtml(trade.quantity)}</p>
            <p>入场 ${escapeHtml(trade.entryPrice)} / 标记 ${escapeHtml(trade.markPrice ?? "-")} / 未实现 ${escapeHtml(trade.unrealizedProfitUsdt ?? "-")}U / 当前止损 ${escapeHtml(trade.stopLoss)}</p>
            <p>${formatTakeProfitPlan(trade)}</p>
          </div>
        </article>
      `,
    )
    .join("")
    : `<div class="empty-cell">${escapeHtml(label)} 暂无自动交易挂单/持仓</div>`;

  return `
    <section class="auto-account-block">
      <strong>${escapeHtml(label)}</strong>
      ${body}
    </section>
  `;
}

function renderAutoTradeAccounts(accounts = []) {
  const list = accounts.filter(Boolean);
  if (!list.length) {
    elements.autoTradeStatus.textContent = "自动交易状态未加载";
    elements.autoTradeTrades.innerHTML = `<div class="empty-cell">暂无自动交易挂单/持仓</div>`;
    return;
  }

  const enabledCount = list.filter((account) => account.enabled).length;
  const totalAvailable = list.reduce(
    (sum, account) => sum + Number(account.budget?.availableCapitalUsdt ?? 0),
    0,
  );
  const totalEquity = list.reduce((sum, account) => sum + Number(account.budget?.equityUsdt ?? 0), 0);
  elements.autoTradeStatus.innerHTML = `
    <div class="auto-status-overview">共 ${list.length} 个账户；已开启 ${enabledCount} 个；总权益 ${formatUsdtNumber(totalEquity)}U；总可用 ${formatUsdtNumber(totalAvailable)}U</div>
    <div class="auto-status-grid">${list.map(autoTradeSummaryHtml).join("")}</div>
  `;
  elements.autoTradeTrades.innerHTML = list.map(autoTradeCardsHtml).join("");
}

function formatUsdtNumber(value) {
  return Number.isFinite(value) ? value.toFixed(4).replace(/\.?0+$/, "") : "-";
}

function renderAutoTradeStatus(status) {
  renderAutoTradeAccounts(status ? [status] : []);
}

function renderStrategyDiagnostics(diagnostics) {
  const regime = diagnostics?.regimeGate;
  const shadow = diagnostics?.shadowStats ?? {};
  const audit = diagnostics?.auditSummary ?? {};
  elements.strategyUpdatedAt.textContent = diagnostics?.updatedAt
    ? `更新 ${new Date(diagnostics.updatedAt).toLocaleString()}`
    : "尚未加载";
  elements.strategySummary.textContent = regime
    ? `市场状态 ${regime.state}；风险 ${regime.riskScore}；${regime.allowNewTrade ? "允许新开仓" : "禁止新开仓"}；影子盘胜率 ${shadow.winRate ?? 0}%；已平 ${shadow.closed ?? 0}；最大回撤 ${shadow.maxDrawdownR ?? 0}R。`
    : `市场状态暂未生成；影子盘胜率 ${shadow.winRate ?? 0}%；已平 ${shadow.closed ?? 0}；最大回撤 ${shadow.maxDrawdownR ?? 0}R。`;

  const reasonHtml = (regime?.reasons ?? [])
    .map((reason) => `<span class="quiet-pill">${escapeHtml(reason)}</span>`)
    .join("");
  const skipHtml = Object.entries(audit.skipReasons ?? {})
    .slice(0, 6)
    .map(([reason, count]) => `<p>${escapeHtml(reason)}：${escapeHtml(count)}</p>`)
    .join("");
  const recentShadowHtml = (shadow.recent ?? [])
    .slice(0, 5)
    .map(
      (trade) => `
        <p>${escapeHtml(trade.symbol)} ${escapeHtml(formatAction(trade.action))} · ${escapeHtml(trade.status)} · ${escapeHtml(trade.lastR ?? trade.finalR ?? 0)}R</p>
      `,
    )
    .join("");
  const shadowGroups = shadow.groups ?? {};
  const formatGroup = (groups) =>
    Object.entries(groups ?? {})
      .slice(0, 5)
      .map(
        ([name, item]) =>
          `<p>${escapeHtml(name)}：胜率 ${escapeHtml(item.winRate ?? 0)}% / 已平 ${escapeHtml(item.closed ?? 0)} / ${escapeHtml(item.grossR ?? 0)}R</p>`,
      )
      .join("");
  const shadowGroupHtml = [
    ["方向", shadowGroups.byDirection],
    ["市场状态", shadowGroups.byRegime],
    ["来源", shadowGroups.bySource],
    ["信心档", shadowGroups.byConfidence],
  ]
    .map(([title, groups]) => {
      const content = formatGroup(groups);
      return content ? `<p><strong>${title}</strong></p>${content}` : "";
    })
    .filter(Boolean)
    .join("");

  elements.strategyDetails.innerHTML = `
    <article class="auto-candidate"><div><strong>闸门原因</strong><p>${reasonHtml || "暂无"}</p></div></article>
    <article class="auto-candidate"><div><strong>跳过原因统计</strong>${skipHtml || "<p>暂无</p>"}</div></article>
    <article class="auto-candidate"><div><strong>影子盘最近记录</strong>${recentShadowHtml || "<p>暂无</p>"}</div></article>
    <article class="auto-candidate"><div><strong>影子盘分组统计</strong>${shadowGroupHtml || "<p>暂无</p>"}</div></article>
  `;
}

async function refreshStrategyDiagnostics({ silent = false } = {}) {
  if (!silent) {
    setBusy(elements.refreshStrategy, true, "刷新中...");
  }

  try {
    const payload = await api("/api/strategy/diagnostics");
    renderStrategyDiagnostics(payload.diagnostics);
    return payload.diagnostics;
  } catch (error) {
    if (!silent) {
      renderLog(error.error || error.message, "error");
    }
    return null;
  } finally {
    if (!silent) {
      setBusy(elements.refreshStrategy, false);
    }
  }
}

async function refreshAutoTradeStatus({ silent = false } = {}) {
  if (!silent) {
    setBusy(elements.refreshAutoTrade, true, "刷新中...");
  }

  try {
    const payload = await api("/api/auto/trade/status");
    renderAutoTradeAccounts(payload.accounts?.length ? payload.accounts : [payload.status]);
    return payload.accounts ?? [payload.status];
  } catch (error) {
    if (!silent) {
      renderLog(error.error || error.message, "error");
    }
    return null;
  } finally {
    if (!silent) {
      setBusy(elements.refreshAutoTrade, false);
    }
  }
}

async function runAutoTradeOnce() {
  setBusy(elements.runAutoTrade, true, "运行中...");
  try {
    const payload = await api("/api/auto/trade/run", {
      method: "POST",
      body: JSON.stringify({}),
    });
    renderAutoTradeAccounts(payload.accounts?.length ? payload.accounts : [payload.status]);
    void refreshStrategyDiagnostics({ silent: true });
    const results = payload.results?.length ? payload.results : [payload.result];
    const failed = results.find((result) => result?.error);
    const placedCount = results.reduce((sum, result) => sum + Number(result?.placedCount ?? 0), 0);
    const skipped = results.filter((result) => result?.skipped).length;
    if (failed) {
      renderLog(`自动交易失败：${failed.error}`, "error");
    } else if (placedCount > 0) {
      renderLog(`自动交易已提交：${placedCount} 单`, "success");
    } else if (skipped) {
      renderLog(`自动交易跳过：${results.find((result) => result?.reason)?.reason ?? "无交易"}`, "info");
    } else {
      renderLog("自动交易已完成。", "success");
    }
  } catch (error) {
    renderLog(error.error || error.message, "error");
  } finally {
    setBusy(elements.runAutoTrade, false);
  }
}

function renderAnalysis(analysis) {
  state.analysis = analysis;
  elements.analysisSymbol.value = analysis.symbol;
  renderPositionChips();

  const deviation = calculatePriceDeviation(analysis.symbol);
  const cards = [
    { label: "资金费率", value: displayFundingRate(analysis.fundingRate?.rate) },
    { label: "当前持仓量", value: displayNumber(analysis.openInterest?.openInterest, 3) },
    {
      label: "持仓量 5m",
      value: displayPercent(analysis.openInterestChange?.["5m"]?.percentChange),
    },
    {
      label: "持仓量 1h",
      value: displayPercent(analysis.openInterestChange?.["1h"]?.percentChange),
    },
    {
      label: "全市场多空比",
      value: displayNumber(analysis.longShortRatio?.["5m"]?.longShortRatio, 4),
    },
    {
      label: "顶级交易员多空比",
      value: displayNumber(analysis.topTraderRatio?.["5m"]?.longShortRatio, 4),
    },
    {
      label: "主动买卖量",
      value: displayNumber(analysis.takerBuySell?.["5m"]?.buySellRatio, 4),
    },
    {
      label: "标记价偏离开仓价",
      value: displayPercent(deviation),
    },
  ];

  elements.analysisSignal.className = `analysis-signal ${signalClass(analysis.signal)}`;
  elements.analysisSignal.textContent = `${analysis.symbol}：${analysis.signal}`;
  elements.analysisGrid.innerHTML = cards
    .map(
      (card) => `
        <article class="analysis-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
        </article>
      `,
    )
    .join("");
  elements.analysisReasons.innerHTML = (analysis.reasons ?? [])
    .map((reason) => `<span class="quiet-pill">${escapeHtml(reason)}</span>`)
    .join("");
  elements.analysisUpdatedAt.textContent = `最近分析 ${new Date().toLocaleString()}`;
  if (analysis.squareNotes) {
    renderSquareNotes(analysis.squareNotes);
  }
  renderOrderAnalysisNote();
}

function renderSquareNotes(squareNotes) {
  state.squareNotes = squareNotes;
  const keywords = squareNotes.keywords?.length ? squareNotes.keywords.join(" / ") : "暂无关键词";
  const riskWords = squareNotes.riskWords?.length ? `；风险词 ${squareNotes.riskWords.join(" / ")}` : "";
  const countText = squareNotes.postCount !== undefined ? `；今日匹配 ${squareNotes.postCount} 条` : "";
  elements.squareResult.textContent = `广场情绪：${squareNotes.sentiment}${countText}；${keywords}${riskWords}`;
  renderOrderAnalysisNote();
}

function renderOrderAnalysisNote() {
  const orderSymbol = elements.symbol.value.trim().toUpperCase();
  const analysis = state.analysis;
  const squareNotes = state.squareNotes;
  const parts = [];

  if (analysis && (!orderSymbol || orderSymbol === analysis.symbol)) {
    const reasons = (analysis.reasons ?? []).slice(0, 2).join("；");
    parts.push(`参考分析：${analysis.symbol} ${analysis.signal}${reasons ? `，${reasons}` : ""}`);
  } else if (analysis) {
    parts.push(`参考分析当前为 ${analysis.symbol}，与下单交易对不一致`);
  } else {
    parts.push("暂无参考分析");
  }

  if (squareNotes && squareNotes.sentiment !== "中性") {
    parts.push(`广场参考：${squareNotes.sentiment}`);
  }

  elements.orderAnalysisNote.textContent = parts.join("。");
}

function renderNotes(notes) {
  if (!notes.length) {
    elements.accountNotes.innerHTML = `<span class="quiet-pill">账户状态正常</span>`;
    return;
  }

  elements.accountNotes.innerHTML = notes
    .map((note) => `<span class="quiet-pill">${escapeHtml(note)}</span>`)
    .join("");
}

function metricCardsHtml(summary = {}) {
  const metrics = [
    { label: "持仓模式", value: summary.positionMode },
    { label: "总钱包余额", value: summary.totalWalletBalance },
    { label: "可用余额", value: summary.availableBalance },
    { label: "未实现盈亏", value: summary.totalUnrealizedProfit },
    { label: "最大可转出", value: summary.maxWithdrawAmount },
  ];

  return metrics
    .map(
      (item) => `
        <article class="metric-card">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value ?? "-")}</strong>
        </article>
      `,
    )
    .join("");
}

function renderAccountSnapshots(accounts = []) {
  if (!accounts.length) {
    state.snapshot = null;
    elements.metrics.innerHTML = `<article class="metric-card"><span>账户</span><strong>未配置多账户 API</strong></article>`;
    renderAssets([]);
    renderPositions([]);
    renderNotes(["请先在多账户 API 区域添加账户并保存。"]);
    elements.accountUpdatedAt.textContent = `最近刷新 ${new Date().toLocaleString()}`;
    return null;
  }

  const okAccounts = accounts.filter((account) => account.ok && account.snapshot);
  const firstOk = okAccounts[0] ?? null;
  state.snapshot = firstOk?.snapshot ?? null;

  elements.metrics.innerHTML = accounts
    .map((account) => {
      const title = `${account.label || account.id || "account"}${account.ok ? "" : " · 连接失败"}`;
      if (!account.ok) {
        return `
          <article class="account-snapshot-card account-error-card">
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(account.error || "账户读取失败")}</p>
          </article>
        `;
      }

      return `
        <article class="account-snapshot-card">
          <strong>${escapeHtml(title)}</strong>
          <div class="account-metric-grid">${metricCardsHtml(account.snapshot.summary)}</div>
        </article>
      `;
    })
    .join("");

  renderAssets(
    okAccounts.flatMap((account) =>
      (account.snapshot.assets ?? []).map((asset) => ({
        ...asset,
        asset: `${account.label || account.id} / ${asset.asset}`,
      })),
    ),
  );
  renderPositions(
    okAccounts.flatMap((account) =>
      (account.snapshot.positions ?? []).map((position) => ({
        ...position,
        symbol: `${account.label || account.id} / ${position.symbol}`,
      })),
    ),
  );

  const notes = [
    ...accounts
      .filter((account) => !account.ok)
      .map((account) => `${account.label || account.id}：${account.error || "账户读取失败"}`),
    ...okAccounts.flatMap((account) =>
      (account.snapshot.notes ?? []).map((note) => `${account.label || account.id}：${note}`),
    ),
  ];
  renderNotes(notes);
  elements.accountUpdatedAt.textContent = `最近刷新 ${new Date().toLocaleString()} · ${okAccounts.length}/${accounts.length} 个账户`;
  renderOrderAnalysisNote();

  if (firstOk) {
    const analysisSymbolChanged = syncDefaultAnalysisSymbol(firstOk.snapshot.positions ?? []);
    if (analysisSymbolChanged) {
      void refreshAnalysis({ silent: true });
    }
  }

  return firstOk?.snapshot ?? null;
}

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  renderMetrics(snapshot);
  renderAssets(snapshot.assets);
  renderPositions(snapshot.positions);
  const analysisSymbolChanged = syncDefaultAnalysisSymbol(snapshot.positions);
  renderNotes(snapshot.notes ?? []);
  elements.accountUpdatedAt.textContent = `最近刷新 ${new Date().toLocaleString()}`;
  renderOrderAnalysisNote();
  if (analysisSymbolChanged) {
    void refreshAnalysis({ silent: true });
  }
}

function renderSymbolList(symbols) {
  state.symbols = symbols;
  elements.symbolList.innerHTML = symbols
    .slice(0, 2000)
    .map((symbol) => `<option value="${escapeHtml(symbol)}"></option>`)
    .join("");
}

function buildPreviewCards(preview) {
  const cards = [
    { label: "订单意图", value: preview.intentLabel },
    { label: "持仓模式", value: preview.positionMode },
    { label: "交易对", value: preview.symbol },
    { label: "价格", value: preview.price },
    { label: "杠杆", value: preview.leverage || "-" },
    { label: "实际数量", value: preview.quantity },
    { label: "名义价值", value: preview.notional },
  ];

  if (preview.margin) {
    cards.splice(3, 0, {
      label: `输入保证金${preview.rules.marginAsset ? ` (${preview.rules.marginAsset})` : ""}`,
      value: preview.margin,
    });
    cards.push({
      label: `预计占用保证金${preview.rules.marginAsset ? ` (${preview.rules.marginAsset})` : ""}`,
      value: preview.estimatedMargin || preview.margin,
    });
  }

  if (preview.closeableQuantity !== null && preview.closeableQuantity !== undefined) {
    cards.push({ label: "最多可平", value: preview.closeableQuantity });
  }

  return cards;
}

function renderPreview(preview) {
  state.preview = preview;
  const instruction = JSON.stringify(preview.orderInstruction, null, 2);
  const cards = buildPreviewCards(preview);

  elements.previewBox.innerHTML = `
    <div class="preview-grid">
      ${cards
        .map(
          (item) => `
            <p>
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(item.value)}</strong>
            </p>
          `,
        )
        .join("")}
    </div>
    <div class="rules-bar">
      <span>价格步进 ${escapeHtml(preview.rules.tickSize)}</span>
      <span>数量步进 ${escapeHtml(preview.rules.stepSize)}</span>
      <span>最小数量 ${escapeHtml(preview.rules.minQty)}</span>
      <span>最小名义价值 ${escapeHtml(preview.rules.minNotional)}</span>
    </div>
    <pre>${escapeHtml(instruction)}</pre>
  `;
}

function getOrderPayload() {
  const payload = {
    intent: elements.intent.value,
    symbol: elements.symbol.value.trim().toUpperCase(),
    price: elements.price.value.trim(),
    leverage: elements.leverage.disabled ? undefined : elements.leverage.value.trim(),
  };

  if (isOpenIntent()) {
    payload.margin = elements.sizeInput.value.trim();
  } else {
    payload.quantity = elements.sizeInput.value.trim();
  }

  return payload;
}

function updateAutoRefreshUi() {
  if (!state.autoRefreshEnabled) {
    updateLiveStatus({ text: "自动刷新已暂停", tone: "paused" });
    elements.autoRefreshToggle.textContent = "继续";
    return;
  }

  if (!hasAccountCredentials()) {
    updateLiveStatus({ text: "等待 API 配置", tone: "warning" });
    elements.autoRefreshToggle.textContent = "暂停";
    return;
  }

  if (document.hidden) {
    updateLiveStatus({ text: "页面隐藏，自动暂停", tone: "paused" });
    elements.autoRefreshToggle.textContent = "暂停";
    return;
  }

  if (state.refreshInFlight) {
    updateLiveStatus({ text: "正在实时同步...", tone: "syncing" });
    elements.autoRefreshToggle.textContent = "暂停";
    return;
  }

  updateLiveStatus({ text: `实时刷新 ${AUTO_REFRESH_INTERVAL_MS / 1000}s`, tone: "live" });
  elements.autoRefreshToggle.textContent = "暂停";
}

function scheduleNextAutoRefresh(delay = AUTO_REFRESH_INTERVAL_MS) {
  clearAutoRefreshTimer();

  if (!state.autoRefreshEnabled || !hasAccountCredentials() || document.hidden) {
    updateAutoRefreshUi();
    return;
  }

  state.autoRefreshTimer = window.setTimeout(() => {
    void refreshAccount({ silent: true, source: "auto" });
  }, delay);
  updateAutoRefreshUi();
}

function scheduleNextAnalysisRefresh(delay = ANALYSIS_REFRESH_INTERVAL_MS) {
  clearAnalysisRefreshTimer();

  if (!getAnalysisSymbol() || document.hidden) {
    return;
  }

  state.analysisRefreshTimer = window.setTimeout(() => {
    void refreshAnalysis({ silent: true, source: "auto" });
  }, delay);
}

function scheduleNextAutoScan(delay = AUTO_SCAN_REFRESH_INTERVAL_MS) {
  clearAutoScanTimer();

  if (document.hidden) {
    return;
  }

  state.autoScanTimer = window.setTimeout(() => {
    void refreshAutoScan({ silent: true, source: "auto" });
  }, delay);
}

function startAutoRefresh({ immediate = false } = {}) {
  state.autoRefreshEnabled = true;
  if (immediate) {
    void refreshAccount({ silent: true, source: "auto" });
    return;
  }

  scheduleNextAutoRefresh();
}

function stopAutoRefresh() {
  state.autoRefreshEnabled = false;
  clearAutoRefreshTimer();
  updateAutoRefreshUi();
}

function toggleAutoRefresh() {
  if (state.autoRefreshEnabled) {
    stopAutoRefresh();
    renderLog("已暂停自动刷新。", "info");
    return;
  }

  state.autoRefreshEnabled = true;
  scheduleNextAutoRefresh(0);
  renderLog("已恢复自动刷新。", "success");
}

async function loadConfig() {
  const payload = await api("/api/config");
  renderConfig(payload.config);
  await loadAccountsConfig();
  updateAutoRefreshUi();
}

async function loadAccountsConfig() {
  const payload = await api("/api/accounts/config");
  renderAccountsConfig(payload.accounts ?? []);
}

async function loadSymbols() {
  const payload = await api("/api/symbols");
  renderSymbolList(payload.symbols);
}

async function testConnection() {
  setBusy(elements.testConnection, true, "测试中...");

  try {
    const payload = await api("/api/config/test", {
      method: "POST",
      body: JSON.stringify(getConfigPayload({ save: false })),
    });
    const result = payload.result;
    const publicText = result.public?.ok
      ? `公共接口正常，合约数 ${result.public.symbolCount}`
      : `公共接口失败：${result.public?.error || "未知错误"}`;
    const accountText = result.account?.ok
      ? "账户接口正常"
      : result.account?.skipped
        ? result.account.error
        : `账户接口失败：${result.account?.error || "未知错误"}`;
    const hint =
      result.environment === "testnet" && result.account && !result.account.ok && !result.account.skipped
        ? "测试网请使用 Futures Testnet / Demo 单独生成的 API Key。"
        : "";

    elements.configHint.textContent = `${result.environmentLabel} ${result.baseUrl}：${publicText}；${accountText}${hint ? ` ${hint}` : ""}`;
    renderLog(`连接测试完成：${publicText}；${accountText}`, result.public?.ok ? "success" : "error");
  } catch (error) {
    renderLog(error.error || error.message, "error");
  } finally {
    setBusy(elements.testConnection, false);
  }
}

async function refreshAutoScan({ silent = false, force = false, source = "manual" } = {}) {
  if (state.autoScanInFlight) {
    return state.autoScanPromise;
  }

  clearAutoScanTimer();
  state.autoScanInFlight = true;

  if (!silent) {
    setBusy(elements.refreshAutoScan, true, "扫描中...");
  }

  const query = new URLSearchParams();
  if (force) {
    query.set("force", "1");
  }
  if (silent && !force) {
    query.set("background", "1");
  }

  const promise = api(`/api/auto/scan${query.toString() ? `?${query.toString()}` : ""}`)
    .then((payload) => {
      renderAutoScan(payload.scan);
      if (!silent) {
        renderLog("自动拉取分析已刷新。", "success");
      }
      void refreshSquareToday({ silent: true });
      if (payload.scan.status === "scanning" || payload.scan.status === "refreshing") {
        scheduleNextAutoScan(10000);
      }
      return payload.scan;
    })
    .catch((error) => {
      if (!silent) {
        renderLog(error.error || error.message, "error");
      }
      return null;
    })
    .finally(() => {
      state.autoScanInFlight = false;
      state.autoScanPromise = null;
      if (!silent) {
        setBusy(elements.refreshAutoScan, false);
      }
      if (source !== "manual") {
        scheduleNextAutoScan();
      }
    });

  state.autoScanPromise = promise;
  return promise;
}

async function refreshSquareToday({ silent = false, force = false } = {}) {
  const symbols = getReferenceSymbols();
  const query = new URLSearchParams();
  if (symbols.length) {
    query.set("symbols", symbols.join(","));
  }
  if (force) {
    query.set("force", "1");
  }

  if (!silent) {
    setBusy(elements.refreshSquareToday, true, "刷新中...");
  }

  try {
    const payload = await api(`/api/square/today?${query.toString()}`);
    renderSquareNotes(payload.squareNotes);
    if (!silent) {
      renderLog("今日币安广场信息已刷新。", "success");
    }
    return payload.squareNotes;
  } catch (error) {
    if (!silent) {
      renderLog(error.error || error.message, "error");
    }
    return null;
  } finally {
    if (!silent) {
      setBusy(elements.refreshSquareToday, false);
    }
  }
}

async function refreshAnalysis({ silent = false, force = false, source = "manual" } = {}) {
  if (state.analysisInFlight) {
    return state.analysisPromise;
  }

  const symbol = getAnalysisSymbol() || elements.symbol.value.trim().toUpperCase();
  if (!symbol) {
    elements.analysisSignal.className = "analysis-signal neutral";
    elements.analysisSignal.textContent = "请输入合约";
    return null;
  }

  clearAnalysisRefreshTimer();
  state.analysisInFlight = true;

  if (!silent) {
    setBusy(elements.refreshAnalysis, true, "分析中...");
  }

  const query = new URLSearchParams({ symbol });
  if (force) {
    query.set("force", "1");
  }

  const promise = api(`/api/analysis?${query.toString()}`)
    .then((payload) => {
      renderAnalysis(payload.analysis);
      state.analysisErrorShown = false;
      if (!silent) {
        renderLog(`分析已刷新: ${payload.analysis.symbol}`, "success");
      }
      return payload.analysis;
    })
    .catch((error) => {
      if (!silent || !state.analysisErrorShown) {
        renderLog(error.error || error.message, "error");
        state.analysisErrorShown = true;
      }
      throw error;
    })
    .finally(() => {
      state.analysisInFlight = false;
      state.analysisPromise = null;
      if (!silent) {
        setBusy(elements.refreshAnalysis, false);
      }
      scheduleNextAnalysisRefresh();
    });

  state.analysisPromise = promise;
  return promise;
}

async function refreshAccount({ silent = false, source = "manual" } = {}) {
  if (state.refreshInFlight) {
    return state.refreshPromise;
  }

  clearAutoRefreshTimer();
  state.refreshInFlight = true;
  updateAutoRefreshUi();

  if (!silent) {
    setBusy(elements.refreshAccount, true, "刷新中...");
  }

  const promise = api("/api/accounts/snapshots")
    .then((payload) => {
      const snapshot = renderAccountSnapshots(payload.accounts ?? []);
      state.autoRefreshErrorShown = false;
      if (!silent) {
        renderLog("账户信息已刷新。", "success");
      }
      return snapshot;
    })
    .catch((error) => {
      if (!silent || !state.autoRefreshErrorShown) {
        renderLog(error.error || error.message, "error");
        state.autoRefreshErrorShown = true;
      }

      if ((error.error || error.message || "").includes("API Key")) {
        clearAutoRefreshTimer();
      }

      throw error;
    })
    .finally(() => {
      state.refreshInFlight = false;
      state.refreshPromise = null;
      if (!silent) {
        setBusy(elements.refreshAccount, false);
      }
      if (state.autoRefreshEnabled && source !== "manual") {
        scheduleNextAutoRefresh();
      } else {
        updateAutoRefreshUi();
      }
    });

  state.refreshPromise = promise;
  return promise;
}

async function saveConfig(event) {
  event.preventDefault();
  const submitButton = elements.configForm.querySelector('button[type="submit"]');
  setBusy(submitButton, true, "保存中...");

  const payload = getConfigPayload();

  try {
    const response = await api("/api/config", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderConfig(response.config);
    renderLog("配置已更新。", "success");
    try {
      await loadSymbols();
    } catch (error) {
      renderLog(`交易对加载失败：${error.error || error.message}`, "error");
    }

    if (hasAccountCredentials()) {
      await refreshAccount({ silent: false, source: "manual" });
      scheduleNextAutoRefresh();
      scheduleNextAnalysisRefresh(0);
    } else {
      clearAutoRefreshTimer();
      updateAutoRefreshUi();
    }
  } catch (error) {
    renderLog(error.error || error.message, "error");
  } finally {
    setBusy(submitButton, false);
  }
}

async function saveAccountsConfig() {
  setBusy(elements.saveAccounts, true, "保存中...");
  try {
    const response = await api("/api/accounts/config", {
      method: "POST",
      body: JSON.stringify({ accounts: collectAccountsConfig() }),
    });
    renderAccountsConfig(response.accounts ?? []);
    updateModeUi();
    await refreshAccount({ silent: false, source: "manual" });
    scheduleNextAutoRefresh();
    const restartText = response.restartRequired ? "，重启服务后生效" : "";
    renderLog(`多账户配置已保存${restartText}。`, "success");
    elements.accountsHint.textContent = `多账户配置已保存${restartText}；Secret 留空的账户已沿用旧值。`;
  } catch (error) {
    renderLog(error.error || error.message, "error");
    elements.accountsHint.textContent = error.error || error.message;
  } finally {
    setBusy(elements.saveAccounts, false);
  }
}

async function analyzeSquareNotes() {
  setBusy(elements.analyzeSquare, true, "分析中...");
  try {
    const payload = await api("/api/analysis/square", {
      method: "POST",
      body: JSON.stringify({
        text: elements.squareText.value,
      }),
    });
    renderSquareNotes(payload.squareNotes);
    renderLog("币安广场内容已分析。", "success");
  } catch (error) {
    renderLog(error.error || error.message, "error");
  } finally {
    setBusy(elements.analyzeSquare, false);
  }
}

async function previewOrder() {
  setBusy(elements.previewOrder, true, "预览中...");
  try {
    const payload = await api("/api/order/preview", {
      method: "POST",
      body: JSON.stringify(getOrderPayload()),
    });
    renderPreview(payload.preview);
    renderLog(`订单预览完成: ${payload.preview.intentLabel} ${payload.preview.symbol}`, "success");
  } catch (error) {
    renderLog(error.error || error.message, "error");
  } finally {
    setBusy(elements.previewOrder, false);
  }
}

async function submitOrder(event) {
  event.preventDefault();

  const payload = getOrderPayload();
  const sizeLine = isOpenIntent(payload.intent)
    ? `保证金 ${payload.margin}\n杠杆 ${payload.leverage}`
    : `数量 ${payload.quantity}`;
  const confirmed = window.confirm(
    `确认提交订单？\n${payload.intent} ${payload.symbol}\n${sizeLine}\n价格 ${payload.price}`,
  );
  if (!confirmed) {
    return;
  }

  clearAutoRefreshTimer();
  setBusy(elements.submitOrder, true, "提交中...");

  try {
    const response = await api("/api/order", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderPreview(response.preview);
    renderSnapshot(response.snapshot);

    if (response.leverageResponse?.dryRun) {
      renderLog("杠杆请求已生成（dry-run）。", "success");
    } else if (response.leverageResponse?.leverage) {
      renderLog(`杠杆已更新到 ${response.leverageResponse.leverage}x。`, "success");
    }

    if (response.orderResponse?.dryRun) {
      renderLog("下单请求已生成（dry-run），未真实提交。", "success");
    } else {
      renderLog(`订单已提交，orderId=${response.orderResponse.orderId}`, "success");
    }
  } catch (error) {
    if (error.leveragePossiblyChanged) {
      renderLog(
        `下单失败，但 ${error.symbol} 的杠杆可能已被修改为 ${error.updatedLeverage}x。`,
        "error",
      );
    }
    renderLog(error.error || error.message, "error");
  } finally {
    setBusy(elements.submitOrder, false);
    scheduleNextAutoRefresh();
    scheduleNextAnalysisRefresh(0);
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    clearAutoRefreshTimer();
    clearAnalysisRefreshTimer();
    clearAutoScanTimer();
    updateAutoRefreshUi();
    return;
  }

  if (state.autoRefreshEnabled && hasAccountCredentials()) {
    scheduleNextAutoRefresh(0);
  } else {
    updateAutoRefreshUi();
  }
  scheduleNextAnalysisRefresh(0);
  scheduleNextAutoScan(0);
}

async function bootstrap() {
  elements.configForm.addEventListener("submit", saveConfig);
  elements.environmentSelect.addEventListener("change", applyEnvironmentSelection);
  elements.baseUrl.addEventListener("input", () => {
    syncEnvironmentSelect(elements.baseUrl.value);
  });
  elements.addAccount.addEventListener("click", addAccountCard);
  elements.saveAccounts.addEventListener("click", saveAccountsConfig);
  elements.accountConfigList.addEventListener("click", (event) => {
    if (!event.target.closest(".remove-account")) {
      return;
    }

    event.target.closest(".account-config-card")?.remove();
    if (!elements.accountConfigList.querySelector(".account-config-card")) {
      renderAccountsConfig([]);
    }
  });
  elements.testConnection.addEventListener("click", testConnection);
  elements.refreshAccount.addEventListener("click", async () => {
    try {
      await refreshAccount({ silent: false, source: "manual" });
      scheduleNextAutoRefresh();
      scheduleNextAnalysisRefresh(0);
    } catch {}
  });
  elements.reloadConfig.addEventListener("click", async () => {
    try {
      await loadConfig();
      renderLog("配置已重新读取。", "success");
      if (hasAccountCredentials()) {
        scheduleNextAutoRefresh();
        scheduleNextAnalysisRefresh();
      }
    } catch (error) {
      renderLog(error.error || error.message, "error");
    }
  });
  elements.previewOrder.addEventListener("click", previewOrder);
  elements.refreshAutoScan.addEventListener("click", () => {
    void refreshAutoScan({ silent: false, force: true });
  });
  elements.refreshAutoTrade.addEventListener("click", () => {
    void refreshAutoTradeStatus({ silent: false });
  });
  elements.refreshStrategy.addEventListener("click", () => {
    void refreshStrategyDiagnostics({ silent: false });
  });
  elements.runAutoTrade.addEventListener("click", runAutoTradeOnce);
  elements.refreshAnalysis.addEventListener("click", () => {
    void refreshAnalysis({ silent: false, force: true });
  });
  elements.analysisSymbol.addEventListener("change", () => {
    elements.analysisSymbol.value = getAnalysisSymbol();
    renderPositionChips();
    void refreshAnalysis({ silent: false, force: true });
  });
  elements.refreshSquareToday.addEventListener("click", () => {
    void refreshSquareToday({ silent: false, force: true });
  });
  elements.analyzeSquare.addEventListener("click", analyzeSquareNotes);
  elements.orderForm.addEventListener("submit", submitOrder);
  elements.intent.addEventListener("change", updateSizeField);
  elements.symbol.addEventListener("input", renderOrderAnalysisNote);
  elements.clearLog.addEventListener("click", () => {
    elements.logList.innerHTML = "";
  });
  elements.autoRefreshToggle.addEventListener("click", toggleAutoRefresh);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  updateSizeField();
  updateAutoRefreshUi();

  try {
    await loadConfig();
    try {
      await loadSymbols();
    } catch (error) {
      renderLog(`交易对加载失败：${error.error || error.message}`, "error");
    }
    renderLog("面板已加载。", "success");
    void refreshAutoScan({ silent: true, source: "auto" });
    void refreshAutoTradeStatus({ silent: true });
    void refreshStrategyDiagnostics({ silent: true });
    scheduleNextAutoScan();
    if (hasAccountCredentials()) {
      await refreshAccount({ silent: true, source: "auto" });
      scheduleNextAutoRefresh();
      scheduleNextAnalysisRefresh();
    }
  } catch (error) {
    renderLog(error.error || error.message, "error");
  }
}

bootstrap();
