import {
  createLeadPositionsSnapshotHash,
  diffLeadPositions,
  normalizeLeadPositions,
  resolveCopyTradeRows,
} from "../binance/copyTradeLeadPositions.mjs";
import { JsonFileStore } from "../utils/jsonFileStore.mjs";
import { createLogger } from "../utils/logger.mjs";

function buildUrl(apiUrl, queryParams) {
  const url = new URL(apiUrl);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function buildHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export class BinanceCopyTradeLeadPositionsSource {
  constructor({
    apiUrl,
    queryParams,
    headers,
    pollIntervalMs,
    stateFile,
    activeOnly,
    includeInitialSnapshot,
    symbolAllowlist,
    entityLabel,
    entityValue,
    responseItemsPath,
    expectedCode,
    sendStartupSnapshot,
  }) {
    this.apiUrl = apiUrl;
    this.queryParams = queryParams;
    this.headers = headers;
    this.pollIntervalMs = pollIntervalMs;
    this.activeOnly = activeOnly;
    this.includeInitialSnapshot = includeInitialSnapshot;
    this.symbolAllowlist = symbolAllowlist;
    this.entityLabel = entityLabel;
    this.entityValue = entityValue;
    this.responseItemsPath = responseItemsPath;
    this.expectedCode = expectedCode;
    this.sendStartupSnapshot = sendStartupSnapshot;
    this.logger = createLogger("BinanceCopyTradeLeadPositionsSource");
    this.stateStore = new JsonFileStore(stateFile, {
      snapshotHash: null,
      positions: [],
    });
    this.timer = null;
    this.stopped = false;
    this.healthState = "unknown";
    this.hasSentSnapshotThisRun = false;
  }

  async start({ onEvent, onStatus }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.stopped = false;
    await this.stateStore.load();
    await this.emitStatus(
      `已开始监控${this.entityLabel}${this.entityValue}，轮询间隔 ${this.pollIntervalMs}ms`,
    );
    void this.pollLoop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async pollLoop() {
    if (this.stopped) {
      return;
    }

    try {
      await this.pollOnce();
    } catch (error) {
      this.logger.error("Failed to poll copy-trade positions", error);
      await this.emitHealthStatus("error", `仓位接口请求失败: ${error.message}`);
    }

    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.pollLoop();
    }, this.pollIntervalMs);
  }

  async pollOnce() {
    const url = buildUrl(this.apiUrl, this.queryParams);
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(this.headers),
    });
    const payloadText = await response.text();

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      throw new Error(`返回内容不是 JSON，HTTP ${response.status}`);
    }

    if (!response.ok) {
      const code = payload?.code ? ` ${payload.code}` : "";
      const message = payload?.message ? ` ${payload.message}` : "";
      throw new Error(`HTTP ${response.status}${code}${message}`.trim());
    }

    if (this.expectedCode && payload?.code !== this.expectedCode) {
      throw new Error(`接口返回异常 code=${payload?.code} message=${payload?.message ?? ""}`.trim());
    }

    const rows = resolveCopyTradeRows(payload, this.responseItemsPath);
    if (!Array.isArray(rows)) {
      throw new Error(`无法在响应中找到仓位数组，path=${this.responseItemsPath}`);
    }

    await this.emitHealthStatus("healthy", "仓位接口已恢复");

    const positions = normalizeLeadPositions(rows, {
      activeOnly: this.activeOnly,
      symbolAllowlist: this.symbolAllowlist,
    });
    const snapshotHash = createLeadPositionsSnapshotHash(positions);
    const previousSnapshot = this.stateStore.get();
    const changes = diffLeadPositions(previousSnapshot.positions ?? [], positions);
    const isFirstSnapshot = !previousSnapshot.snapshotHash;
    const hasChanged = previousSnapshot.snapshotHash !== snapshotHash;
    const shouldSendStartupSnapshot = this.sendStartupSnapshot && !this.hasSentSnapshotThisRun;

    await this.stateStore.set({
      fetchedAt: Date.now(),
      snapshotHash,
      positions,
    });

    if (isFirstSnapshot && !this.includeInitialSnapshot) {
      return;
    }

    if (!isFirstSnapshot && !hasChanged && !shouldSendStartupSnapshot) {
      return;
    }

    this.hasSentSnapshotThisRun = true;
    await this.onEvent({
      e: "copyTradeLeadPositionsSnapshot",
      E: Date.now(),
      entityLabel: this.entityLabel,
      entityValue: this.entityValue,
      positions,
      changes,
      changeType: isFirstSnapshot ? "initial" : shouldSendStartupSnapshot ? "startup" : "update",
    });
  }

  async emitHealthStatus(nextState, message) {
    if (this.healthState === nextState) {
      return;
    }

    this.healthState = nextState;
    if (nextState === "healthy" && (this.stateStore.get()?.snapshotHash ?? null) === null) {
      return;
    }

    await this.emitStatus(message);
  }

  async emitStatus(message) {
    if (!this.onStatus) {
      return;
    }

    try {
      await this.onStatus(message);
    } catch (error) {
      this.logger.error("Failed to emit status update", error);
    }
  }
}
