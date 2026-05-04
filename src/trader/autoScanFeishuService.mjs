import { FeishuNotifier } from "../notifiers/feishuNotifier.mjs";
import { createAutoScanFeishuMessage } from "./autoFeishuMessage.mjs";

function noop() {}

export class AutoScanFeishuService {
  constructor({
    runtime,
    config,
    notifier,
    logger = console,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    strategy = null,
  }) {
    this.runtime = runtime;
    this.config = config;
    this.strategy = strategy;
    this.notifier =
      notifier ??
      (config?.enabled && config?.webhookUrl
        ? new FeishuNotifier({
            webhookUrl: config.webhookUrl,
            messageStyle: config.messageStyle,
          })
        : null);
    this.logger = logger;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.lastResult = null;
  }

  isEnabled() {
    return Boolean(this.config?.enabled && this.notifier);
  }

  start({ immediate = true } = {}) {
    if (!this.isEnabled() || !this.runtime) {
      this.logger?.log?.("Auto scan Feishu push disabled.");
      return false;
    }

    this.stopped = false;
    this.schedule(immediate ? 0 : this.config.intervalMs);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  schedule(delayMs) {
    if (this.stopped) {
      return;
    }

    const fallbackDelay = Number(this.config.intervalMs) || 900000;
    const requestedDelay = delayMs === undefined || delayMs === null ? fallbackDelay : Number(delayMs);
    const delay = Math.max(1000, Number.isFinite(requestedDelay) ? requestedDelay : fallbackDelay);
    this.timer = this.setTimeoutImpl(() => {
      void this.runOnce();
    }, delay);
    this.timer?.unref?.();
  }

  async runOnce() {
    if (!this.isEnabled() || this.running) {
      return this.lastResult;
    }

    this.running = true;
    try {
      const scan = await this.runtime.getAutoScan({ forceRefresh: false });
      await this.strategy?.recordScan?.(scan);
      const diagnostics = await this.strategy?.getDiagnostics?.();
      const message = createAutoScanFeishuMessage(scan, diagnostics);
      await this.notifier.send(message);
      await this.strategy?.audit?.("feishu_push_sent", {
        candidateCount: scan?.candidates?.length ?? 0,
        regimeState: diagnostics?.regimeGate?.state,
      });
      this.lastResult = {
        ok: true,
        sentAt: new Date().toISOString(),
        candidateCount: scan?.candidates?.length ?? 0,
      };
      this.logger?.log?.(
        `Auto scan Feishu push sent: ${this.lastResult.candidateCount} candidates.`,
      );
      return this.lastResult;
    } catch (error) {
      await this.strategy?.audit?.("feishu_push_failed", {
        error: error?.message || String(error),
      });
      this.lastResult = {
        ok: false,
        sentAt: new Date().toISOString(),
        error: error?.message || String(error),
      };
      (this.logger?.error ?? noop).call(this.logger, "Auto scan Feishu push failed", error);
      return this.lastResult;
    } finally {
      this.running = false;
      this.schedule(this.config.intervalMs);
    }
  }
}
