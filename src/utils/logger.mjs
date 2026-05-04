export function createLogger(scope) {
  return {
    info(message, details) {
      writeLog("INFO", scope, message, details);
    },
    warn(message, details) {
      writeLog("WARN", scope, message, details);
    },
    error(message, details) {
      writeLog("ERROR", scope, message, details);
    },
  };
}

function writeLog(level, scope, message, details) {
  const timestamp = new Date().toISOString();
  if (details === undefined) {
    console.log(`${timestamp} ${level} [${scope}] ${message}`);
    return;
  }

  console.log(`${timestamp} ${level} [${scope}] ${message}`, details);
}
