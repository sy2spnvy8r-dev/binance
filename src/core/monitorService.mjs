import { createEventId, shouldForwardEvent } from "../binance/eventHelpers.mjs";
import { formatEventMessage, formatSystemMessage } from "./eventFormatter.mjs";

export class MonitorService {
  constructor({ config, source, notifiers, stateStore, logger }) {
    this.config = config;
    this.source = source;
    this.notifiers = notifiers;
    this.stateStore = stateStore;
    this.logger = logger;
  }

  async start() {
    await this.stateStore.load();

    await this.broadcast(
      formatSystemMessage(
        `监控器已启动，事件类型: ${Array.from(this.config.monitorEvents).join(", ")}`,
        this.config.messagePrefix,
      ),
    );

    await this.source.start({
      onEvent: async (event) => {
        await this.processEvent(event);
      },
      onStatus: async (statusMessage) => {
        await this.broadcast(formatSystemMessage(statusMessage, this.config.messagePrefix));
      },
    });
  }

  async processEvent(event) {
    if (!shouldForwardEvent(event, this.config)) {
      this.logger.info(`Skipping event ${event.e}`);
      return;
    }

    const eventId = createEventId(event);
    if (this.stateStore.has(eventId)) {
      this.logger.info(`Skipping duplicate event ${event.e}`);
      return;
    }

    const message = formatEventMessage(event, this.config.messagePrefix);

    await this.broadcast(message);
    await this.stateStore.add(eventId);
  }

  async broadcast(message) {
    this.logger.info("Broadcasting notification");

    if (this.config.dryRun) {
      console.log(message);
      return;
    }

    await Promise.all(this.notifiers.map((notifier) => notifier.send(message)));
  }
}
