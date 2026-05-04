import { randomUUID } from "node:crypto";
import { signQuery } from "../binance/signature.mjs";
import { createLogger } from "../utils/logger.mjs";

export class BinanceSpotUserStreamSource {
  constructor({ apiKey, apiSecret, wsUrl }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.wsUrl = wsUrl;
    this.logger = createLogger("BinanceSpotUserStreamSource");
    this.stopped = false;
    this.websocket = null;
    this.reconnectAttempt = 0;
    this.statusHandler = null;
  }

  async start({ onEvent, onStatus }) {
    this.onEvent = onEvent;
    this.statusHandler = onStatus;
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    this.websocket?.close();
  }

  async connect() {
    if (this.stopped) {
      return;
    }

    this.logger.info("Connecting to Binance WebSocket API");
    this.websocket = new WebSocket(this.wsUrl);

    this.websocket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.logger.info("Connected");
      void this.emitStatus("已连接到 Binance WebSocket API");
      this.subscribe();
    });

    this.websocket.addEventListener("message", async (rawEvent) => {
      try {
        const payload = JSON.parse(rawEvent.data.toString());
        await this.handleMessage(payload);
      } catch (error) {
        this.logger.error("Failed to parse or process WebSocket message", error);
      }
    });

    this.websocket.addEventListener("close", () => {
      this.logger.warn("WebSocket closed");
      if (this.stopped) {
        return;
      }

      void this.emitStatus("与 Binance 的连接已断开，正在重连");
      this.scheduleReconnect();
    });

    this.websocket.addEventListener("error", (error) => {
      this.logger.error("WebSocket error", error);
    });
  }

  subscribe() {
    const params = {
      apiKey: this.apiKey,
      timestamp: Date.now(),
    };
    const { signature } = signQuery(params, this.apiSecret);

    const request = {
      id: randomUUID(),
      method: "userDataStream.subscribe.signature",
      params: {
        ...params,
        signature,
      },
    };

    this.websocket.send(JSON.stringify(request));
  }

  async handleMessage(payload) {
    if (payload.status && payload.status >= 400) {
      throw new Error(`Binance returned an error: ${JSON.stringify(payload)}`);
    }

    if (payload.result?.subscriptionId !== undefined) {
      this.logger.info("Subscribed to user data stream", payload.result);
      await this.emitStatus(
        `已订阅用户数据流，subscriptionId=${payload.result.subscriptionId}`,
      );
      return;
    }

    if (payload.event) {
      await this.onEvent(payload.event);
    }
  }

  scheduleReconnect() {
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.logger.info(`Reconnecting in ${delay}ms`);
    setTimeout(() => {
      void this.connect();
    }, delay);
  }

  async emitStatus(message) {
    if (!this.statusHandler) {
      return;
    }

    try {
      await this.statusHandler(message);
    } catch (error) {
      this.logger.error("Failed to emit status update", error);
    }
  }
}
