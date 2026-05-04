import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/utils/stateStore.mjs";

test("StateStore loads and truncates seen ids", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "binance-monitor-"));
  const filePath = path.join(tempDir, "state.json");
  const store = new StateStore(filePath, 2);

  await store.load();
  await store.add("a");
  await store.add("b");
  await store.add("c");

  assert.equal(store.has("a"), false);
  assert.equal(store.has("b"), true);
  assert.equal(store.has("c"), true);
});
