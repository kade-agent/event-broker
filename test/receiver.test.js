"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { createReceiver } = require("../src/receiver");

const secret = "hook-secret";
const repository = { full_name: "stella-rain/app", default_branch: "main", owner: { login: "stella-rain" } };
const pr = { number: 7, merged: true, draft: false, auto_merge: null, head: { ref: "claude/t", sha: "s" } };

async function start({ publish, onTrigger = () => {} } = {}) {
  const published = [];
  const triggers = [];
  const logs = [];
  const server = createReceiver({
    secret,
    publish: publish || (async (subject, event, msgId) => { published.push({ subject, event, msgId }); }),
    onTrigger: (t) => { triggers.push(t); onTrigger(t); },
    log: (line) => logs.push(line),
    allowedOwners: ["stella-rain"],
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, published, triggers, logs, close: () => new Promise((r) => server.close(r)) };
}

function deliver(base, event, payload, { sig, delivery = "guid-1", noGuid = false } = {}) {
  const body = JSON.stringify(payload);
  const signature = sig ?? "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return fetch(`${base}/github`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-github-event": event, ...(noGuid ? {} : { "x-github-delivery": delivery }), "x-hub-signature-256": signature },
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
    assert.strictEqual(s.published.length, 2);
    assert.strictEqual(s.published[0].subject, "github.stella-rain.app.pr.7.pull_request");
    assert.strictEqual(s.published[0].msgId, "abc-123");
    assert.strictEqual(s.published[0].event.delivery, "abc-123");
  } finally { await s.close(); }
});

test("each delivery publishes v1 then v2, both with the delivery GUID as message id", async () => {
  const s = await start();
  try {
    await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository }, { delivery: "abc-123" });
    assert.deepStrictEqual(s.published.map((p) => [p.subject, p.msgId]), [
      ["github.stella-rain.app.pr.7.pull_request", "abc-123"],
      ["ev.stella-rain.app.pr.7.pr_merged", "abc-123"],
    ]);
    assert.strictEqual(s.published[1].event.v, 2);
    assert.strictEqual(s.published[1].event.signal, "pr_merged");
  } finally { await s.close(); }
});

test("a failing v2 publish answers 503; a failing v1 publish publishes no v2", async () => {
  const seen = [];
  const s = await start({ publish: async (subject) => { seen.push(subject); if (subject.startsWith("ev.")) throw new Error("nats down"); } });
  try {
    const res = await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(s.logs, ["publish ev.stella-rain.app.pr.7.pr_merged: nats down"]);
  } finally { await s.close(); }
  const seen1 = [];
  const t = await start({ publish: async (subject) => { seen1.push(subject); throw new Error("nats down"); } });
  try {
    assert.strictEqual((await deliver(t.base, "pull_request", { action: "closed", pull_request: pr, repository })).status, 503);
    assert.deepStrictEqual(seen1, ["github.stella-rain.app.pr.7.pull_request"]);
  } finally { await t.close(); }
});

test("a push to main is published and starts a mergeability check", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "push", { ref: "refs/heads/main", after: "d", repository });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(s.published.length, 2);
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

test("a merge logs one published line; a duplicate PubAck logs a duplicate line", async () => {
  const s = await start();
  try {
    await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository }, { delivery: "abc-123" });
    assert.deepStrictEqual(s.logs, ["abc-123 pull_request.closed -> published github.stella-rain.app.pr.7.pull_request ev.stella-rain.app.pr.7.pr_merged"]);
  } finally { await s.close(); }
  const d = await start({ publish: async () => ({ duplicate: true }) });
  try {
    await deliver(d.base, "pull_request", { action: "closed", pull_request: pr, repository }, { delivery: "abc-123" });
    assert.deepStrictEqual(d.logs, ["abc-123 pull_request.closed -> duplicate github.stella-rain.app.pr.7.pull_request ev.stella-rain.app.pr.7.pr_merged"]);
  } finally { await d.close(); }
});

test("a dropped, a trigger-only and a push delivery each log one line", async () => {
  const s = await start();
  try {
    await deliver(s.base, "issues", { action: "opened", repository });
    await deliver(s.base, "pull_request", { action: "synchronize", pull_request: pr, repository });
    await deliver(s.base, "push", { ref: "refs/heads/main", after: "d", repository });
    assert.deepStrictEqual(s.logs, [
      "guid-1 issues.opened -> dropped",
      "guid-1 pull_request.synchronize -> trigger-only",
      `guid-1 push -> published ${s.published[0].subject} ${s.published[1].subject}`,
    ]);
  } finally { await s.close(); }
});

test("a ping, a bad signature and a missing GUID", async () => {
  const s = await start();
  try {
    await deliver(s.base, "ping", { zen: "z" });
    await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository }, { sig: "sha256=" + "0".repeat(64) });
    assert.deepStrictEqual(s.logs, []);
    await deliver(s.base, "issues", { action: "opened", repository }, { noGuid: true });
    assert.deepStrictEqual(s.logs, ["- issues.opened -> dropped"]);
  } finally { await s.close(); }
});

test("a publish that throws logs only the publish error line", async () => {
  const s = await start({ publish: async () => { throw new Error("nats down"); } });
  try {
    const res = await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository });
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(s.logs, ["publish github.stella-rain.app.pr.7.pull_request: nats down"]);
  } finally { await s.close(); }
});

test("a delivery from an owner that is not allowed gets 204, publishes nothing, starts no check, logs one line", async () => {
  const s = await start();
  const other = { ...repository, full_name: "someone-else/app", owner: { login: "someone-else" } };
  try {
    const res = await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository: other }, { delivery: "x-1" });
    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(s.published, []);
    assert.deepStrictEqual(s.triggers, []);
    assert.deepStrictEqual(s.logs, ["x-1 pull_request.closed -> dropped owner someone-else"]);
    assert.strictEqual((await deliver(s.base, "push", { ref: "refs/heads/main", after: "d", repository: other })).status, 204);
    assert.deepStrictEqual(s.triggers, []);
  } finally { await s.close(); }
});

test("the owner is compared case-insensitively", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "pull_request", { action: "closed", pull_request: pr, repository: { ...repository, owner: { login: "Stella-Rain" } } });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(s.published.length, 2);
  } finally { await s.close(); }
});
