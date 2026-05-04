import crypto from "node:crypto";
import { stableStringify } from "../utils/stableStringify.mjs";

export function createEventId(event) {
  const base =
    event.e === "executionReport"
      ? [
          event.e,
          event.E,
          event.s,
          event.i,
          event.c,
          event.x,
          event.X,
          event.S,
          event.o,
          event.z,
          event.l,
          event.L,
        ].join("|")
      : [
          event.e,
          event.E,
          event.s ?? "",
          event.a ?? "",
          event.T ?? "",
          stableStringify(event),
        ].join("|");

  return crypto.createHash("sha256").update(base).digest("hex");
}

export function shouldForwardEvent(event, config) {
  if (!config.monitorEvents.has(event.e)) {
    return false;
  }

  if (config.symbolAllowlist.size > 0 && event.s && !config.symbolAllowlist.has(event.s)) {
    return false;
  }

  return true;
}
