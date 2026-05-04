import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE_KEY_PATTERN = /api|secret|password|passphrase|webhook|token/i;

function sanitize(value, depth = 0) {
  if (depth > 6) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitize(item, depth + 1),
      ]),
    );
  }

  return value;
}

function normalizeLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export class StrategyAuditLogger {
  constructor({ filePath, enabled = true, maxReadLines = 500 } = {}) {
    this.filePath = filePath;
    this.enabled = enabled;
    this.maxReadLines = maxReadLines;
  }

  async append(type, payload = {}) {
    if (!this.enabled || !this.filePath) {
      return false;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const event = {
      at: new Date().toISOString(),
      type,
      payload: sanitize(payload),
    };
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  }

  async readRecent(limit = 100) {
    if (!this.filePath) {
      return [];
    }

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-Math.max(limit, this.maxReadLines))
        .map(normalizeLine)
        .filter(Boolean)
        .slice(-limit);
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async getSummary({ limit = 200 } = {}) {
    const events = await this.readRecent(limit);
    const byType = {};
    const skipReasons = {};

    for (const event of events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      const reason = event.payload?.reason || event.payload?.skipReason;
      if (reason) {
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      }
    }

    return {
      enabled: this.enabled,
      eventCount: events.length,
      byType,
      skipReasons,
      recent: events.slice(-20).reverse(),
      updatedAt: new Date().toISOString(),
    };
  }
}

export function sanitizeAuditPayload(value) {
  return sanitize(value);
}
