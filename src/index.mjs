import { loadConfig } from "./config.mjs";
import { MonitorService } from "./core/monitorService.mjs";
import { createNotifiers } from "./core/notifierFactory.mjs";
import { createSource } from "./sources/sourceFactory.mjs";
import { createLogger } from "./utils/logger.mjs";
import { StateStore } from "./utils/stateStore.mjs";

const logger = createLogger("main");

async function main() {
  const config = loadConfig();
  const source = createSource(config);
  const notifiers = createNotifiers(config);
  const stateStore = new StateStore(config.stateFile, config.stateMaxEntries);

  const service = new MonitorService({
    config,
    source,
    notifiers,
    stateStore,
    logger,
  });

  await service.start();
}

process.on("uncaughtException", (error) => {
  logger.error("Unhandled exception", error);
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled rejection", error);
  process.exitCode = 1;
});

void main().catch((error) => {
  logger.error("Fatal startup error", error);
  process.exitCode = 1;
});
