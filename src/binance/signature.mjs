import crypto from "node:crypto";

export function buildQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function signQuery(params, secret) {
  const query = buildQuery(params);
  const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");

  return { query, signature };
}
