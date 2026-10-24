"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { createReceiver } = require("../src/receiver");

const secret = "hook-secret";
const repository = { full_name: "stella-rain/app", default_branch: "main" };
const pr = { number: 7, merged: true, draft: false, auto_merge: null, head: { ref: "claude/t", sha: "s" } };

async function start({ publish, onTrigger = () => {} } = {}) {
  const published = [];
  const triggers = [];
  const server = createReceiver({
    secret,
    publish: publish || (async (subject, event, msgId) => { published.push({ subject, event, msgId }); }),
    onTrigger: (t) => { triggers.push(t); onTrigger(t); },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, published, triggers, close: () => new Promise((r) => server.close(r)) };
}

function deliver(base, event, payload, { sig, delivery = "guid-1" } = {}) {
  const body = JSON.stringify(payload);
  const signature = sig ?? "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return fetch(`${base}/github`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature },
  });
}

test("a badly signed delivery gets 401 and publishes nothing", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository }, { sig: "sha256=" + "0".repeat(64) });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(s.published.length, 0);
  } finally { await s.close(); }
});

test("a ping gets 200; an event that is neither kept nor a trigger gets 204", async () => {
  const s = await start();
  try {
    assert.strictEqual((await deliver(s.base, "ping", { zen: "z" })).status, 200);
    assert.strictEqual((await deliver(s.base, "issues", { action: "opened", repository })).status, 204);
    assert.strictEqual(s.published.length, 0);
  } finally { await s.close(); }
});

test("a signed merge is published with the delivery GUID as its message id", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository }, { delivery: "abc-123" });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(s.published.length, 1);
    assert.strictEqual(s.published[0].subject, "github.stella-rain.app.pr.7.pull_request");
    assert.strictEqual(s.published[0].msgId, "abc-123");
    assert.strictEqual(s.published[0].event.delivery, "abc-123");
  } finally { await s.close(); }
});

test("a push to main is published and starts a mergeability check", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "push", { ref: "refs/heads/main", after: "d", repository });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(s.published.length, 1);
    assert.deepStrictEqual(s.triggers, [{ repo: "stella-rain/app", base: "main" }]);
  } finally { await s.close(); }
});

test("a synchronize is not published but starts a check, answered 202", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "pull_request", { action: "synchronize", pull_request: pr, repository });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(s.published.length, 0);
    assert.deepStrictEqual(s.triggers, [{ repo: "stella-rain/app", pr: 7 }]);
  } finally { await s.close(); }
});

test("a broker that refuses the publish gets GitHub a 503, so the delivery shows as failed", async () => {
  const s = await start({ publish: async () => { throw new Error("no responders"); } });
  try {
    const res = await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository });
    assert.strictEqual(res.status, 503);
  } finally { await s.close(); }
});

test("bad JSON with a good signature gets 400; healthz answers 200; anything else 404", async () => {
  const s = await start();
  try {
    const body = "{not json";
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    const res = await fetch(`${s.base}/github`, { method: "POST", body, headers: { "x-github-event": "push", "x-hub-signature-256": sig } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await fetch(`${s.base}/healthz`)).status, 200);
    assert.strictEqual((await fetch(`${s.base}/events`)).status, 404);
  } finally { await s.close(); }
});
