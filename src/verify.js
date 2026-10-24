"use strict";
// GitHub signs each delivery with HMAC-SHA256 of the raw body under the webhook's secret and sends
// it as `X-Hub-Signature-256: sha256=<hex>`. Compare in constant time.
const crypto = require("node:crypto");

function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

module.exports = { verifySignature };
