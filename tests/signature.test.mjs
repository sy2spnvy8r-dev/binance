import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signQuery } from "../src/binance/signature.mjs";

test("signQuery sorts params and signs the query", () => {
  const params = {
    timestamp: 1710000000000,
    apiKey: "demo-key",
  };
  const secret = "demo-secret";

  const expectedQuery = "apiKey=demo-key&timestamp=1710000000000";
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(expectedQuery)
    .digest("hex");

  const result = signQuery(params, secret);

  assert.equal(result.query, expectedQuery);
  assert.equal(result.signature, expectedSignature);
});
