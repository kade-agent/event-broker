"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { verifySignature } = require("../src/verify");

const secret = "s3cret";
const body = Buffer.from('{"zen":"Keep it logically awesome."}');
const sign = (b, s = secret) => "sha256=" + crypto.createHmac("sha256", s).update(b).digest("hex");

test("a delivery signed with the secret is accepted", () => {
  assert.strictEqual(verifySignature(secret, body, sign(body)), true);
});

test("a wrong, missing or malformed signature is refused", () => {
  assert.strictEqual(verifySignature(secret, body, sign(body, "other")), false);
  assert.strictEqual(verifySignature(secret, body, undefined), false);
  assert.strictEqual(verifySignature(secret, body, "sha1=abc"), false);
  assert.strictEqual(verifySignature(secret, body, "sha256=zz"), false);
  assert.strictEqual(verifySignature(secret, Buffer.concat([body, Buffer.from(" ")]), sign(body)), false);
});

test("an empty secret refuses everything", () => {
  assert.strictEqual(verifySignature("", body, sign(body, "")), false);
});
