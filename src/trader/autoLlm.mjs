const DECISION_KEYS = new Set([
  "symbol",
  "action",
  "confidence",
  "entryPrice",
  "stopLoss",
  "takeProfit",
  "leverage",
  "reason",
]);
const ACTIONS = new Set(["open_long", "open_short", "hold"]);

function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not contain a JSON object");
  }

  return candidate.slice(start, end + 1);
}

function normalizePositiveNumber(value, label, { required = true } = {}) {
  if ((value === undefined || value === null || value === "") && !required) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return String(value);
}

export function parseLlmDecisions(text, { allowedSymbols, maxLeverage }) {
  const parsed = JSON.parse(extractJsonObject(text));
  const topKeys = Object.keys(parsed);
  if (topKeys.length !== 1 || topKeys[0] !== "decisions") {
    throw new Error("LLM response must contain only decisions");
  }

  if (!Array.isArray(parsed.decisions)) {
    throw new Error("LLM decisions must be an array");
  }

  return parsed.decisions.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`LLM decision ${index} must be an object`);
    }

    for (const key of Object.keys(item)) {
      if (!DECISION_KEYS.has(key)) {
        throw new Error(`LLM decision ${index} contains unsupported field: ${key}`);
      }
    }

    const symbol = String(item.symbol ?? "").trim().toUpperCase();
    if (!allowedSymbols.has(symbol)) {
      throw new Error(`LLM decision ${index} uses unsupported symbol: ${symbol}`);
    }

    const action = String(item.action ?? "");
    if (!ACTIONS.has(action)) {
      throw new Error(`LLM decision ${index} has invalid action`);
    }

    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new Error(`LLM decision ${index} has invalid confidence`);
    }

    const leverage = Number(item.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > maxLeverage) {
      throw new Error(`LLM decision ${index} has invalid leverage`);
    }

    const entryPrice = action === "hold"
      ? normalizePositiveNumber(item.entryPrice, "entryPrice", { required: false })
      : normalizePositiveNumber(item.entryPrice, "entryPrice");
    const stopLoss = normalizePositiveNumber(item.stopLoss, "stopLoss", { required: false });
    const takeProfit = normalizePositiveNumber(item.takeProfit, "takeProfit", { required: false });

    if (action === "open_long" && stopLoss && Number(stopLoss) >= Number(entryPrice)) {
      throw new Error(`LLM decision ${index} long stopLoss must be below entryPrice`);
    }

    if (action === "open_long" && takeProfit && Number(takeProfit) <= Number(entryPrice)) {
      throw new Error(`LLM decision ${index} long takeProfit must be above entryPrice`);
    }

    if (action === "open_short" && stopLoss && Number(stopLoss) <= Number(entryPrice)) {
      throw new Error(`LLM decision ${index} short stopLoss must be above entryPrice`);
    }

    if (action === "open_short" && takeProfit && Number(takeProfit) >= Number(entryPrice)) {
      throw new Error(`LLM decision ${index} short takeProfit must be below entryPrice`);
    }

    return {
      symbol,
      action,
      confidence,
      entryPrice,
      stopLoss,
      takeProfit,
      leverage,
      reason: String(item.reason ?? "").slice(0, 500),
    };
  });
}

function normalizeChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("LLM_BASE_URL is required");
  }

  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export class OpenAICompatibleClient {
  constructor({
    baseUrl,
    apiKey,
    model,
    temperature = 0.1,
    timeoutMs = 30000,
    fetchImpl = globalThis.fetch,
  }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey && this.model);
  }

  async createChatCompletion({ messages }) {
    if (!this.isConfigured()) {
      throw new Error("LLM config is incomplete");
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(normalizeChatCompletionsUrl(this.baseUrl), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          messages,
        }),
        signal: ctrl.signal,
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }

      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.message || `LLM HTTP ${response.status}`);
      }

      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM response is missing message content");
      }

      return content;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`LLM request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildLlmMessages({ candidates, maxLeverage }) {
  return [
    {
      role: "system",
      content:
        "You are a cautious crypto futures analysis engine. Return only strict JSON. " +
        "Never include extra fields. Do not recommend a trade unless the setup is clear. " +
        "The reason field must be written in Simplified Chinese.",
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Analyze Binance USD-M futures candidates and return limit-order ideas. Write every reason in Simplified Chinese.",
        schema: {
          decisions: [
            {
              symbol: "BTCUSDT",
              action: "open_long | open_short | hold",
              confidence: "number 0-100",
              entryPrice: "positive number string",
              stopLoss: "positive number string or empty",
              takeProfit: "positive number string or empty",
              leverage: `integer 1-${maxLeverage}`,
              reason: "简体中文短理由",
            },
          ],
        },
        rules: {
          maxLeverage,
          useOnlyProvidedSymbols: true,
          firstVersionOnlyPreviewsOrders: true,
          reasonLanguage: "Simplified Chinese only",
        },
        candidates,
      }),
    },
  ];
}
