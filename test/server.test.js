"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../src/server");
const { openStore } = require("../src/store");

const secret = "hook-secret";
const token = "read-token";
const repository = { full_name: "stella-rain/app", default_branch: "main" };

async function start(opts = {}) {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-")));
  const server = createServer({ secret, token, store, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return { base, store, close };
}

function deliver(base, event, payload, sig) {
  const body = JSON.stringify(payload);
  const signature = sig ?? "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return fetch(`${base}/github`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": signature },
  });
}

const merged = (n) => ({ action: "closed", repository, pull_request: { number: n, merged: true, head: { ref: "claude/t", sha: "s" } } });
const subscribe = (base, headers = {}) => fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}`, ...headers } });
const tick = () => new Promise((r) => setTimeout(r, 50));

// Reads SSE frames until `want` data frames have arrived, or until the first heartbeat comment.
async function readFrames(res, want, { heartbeat = false } = {}) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return frames;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (raw.startsWith(":")) {
        if (heartbeat) { await reader.cancel(); return frames; }
        continue;
      }
      frames.push({ id: Number(/^id: (\d+)$/m.exec(raw)[1]), data: JSON.parse(/^data: (.*)$/m.exec(raw)[1]) });
      if (!heartbeat && frames.length === want) { await reader.cancel(); return frames; }
    }
  }
}

test("a badly signed delivery gets 401 and is not stored", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "pull_request", merged(1), "sha256=" + "0".repeat(64));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(s.store.lastId(), 0);
  } finally { await s.close(); }
});

test("a ping gets 200; an event the broker drops gets 204", async () => {
  const s = await start();
  try {
    assert.strictEqual((await deliver(s.base, "ping", { zen: "z" })).status, 200);
    assert.strictEqual((await deliver(s.base, "issues", { action: "opened", repository })).status, 204);
    assert.strictEqual(s.store.lastId(), 0);
  } finally { await s.close(); }
});

test("a signed merge is stored and answered 202 with its id", async () => {
  const s = await start();
  try {
    const res = await deliver(s.base, "pull_request", merged(7));
    assert.strictEqual(res.status, 202);
    assert.deepStrictEqual(await res.json(), { id: 1 });
    assert.strictEqual(s.store.since(0)[0].pr, 7);
  } finally { await s.close(); }
});

test("the stream refuses a missing or wrong bearer token", async () => {
  const s = await start();
  try {
    assert.strictEqual((await fetch(`${s.base}/events`)).status, 401);
    assert.strictEqual((await fetch(`${s.base}/events`, { headers: { authorization: "Bearer nope" } })).status, 401);
  } finally { await s.close(); }
});

test("Last-Event-ID replays what came after it, then streams live events", async () => {
  const s = await start();
  try {
    for (const n of [1, 2, 3]) await deliver(s.base, "pull_request", merged(n));
    const res = await subscribe(s.base, { "last-event-id": "1" });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/event-stream/);
    const reading = readFrames(res, 3);
    await tick();
    await deliver(s.base, "pull_request", merged(4));
    const frames = await reading;
    assert.deepStrictEqual(frames.map((f) => f.id), [2, 3, 4]);
    assert.deepStrictEqual(frames.map((f) => f.data.pr), [2, 3, 4]);
    assert.strictEqual(frames[0].data.id, 2);
  } finally { await s.close(); }
});

test("with no Last-Event-ID the stream sends only new events", async () => {
  const s = await start();
  try {
    await deliver(s.base, "pull_request", merged(1));
    const res = await subscribe(s.base);
    const reading = readFrames(res, 1);
    await tick();
    await deliver(s.base, "pull_request", merged(2));
    assert.deepStrictEqual((await reading).map((f) => f.id), [2]);
  } finally { await s.close(); }
});

test("the stream sends a heartbeat comment", async () => {
  const s = await start({ heartbeatMs: 20 });
  try {
    assert.deepStrictEqual(await readFrames(await subscribe(s.base), 0, { heartbeat: true }), []);
  } finally { await s.close(); }
});

test("healthz answers ok without a token", async () => {
  const s = await start();
  try {
    assert.strictEqual((await fetch(`${s.base}/healthz`)).status, 200);
  } finally { await s.close(); }
});
