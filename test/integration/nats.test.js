"use strict";
// Runs against a real nats-server started with nats/nats-server.conf (CI's integration job).
// Needs NATS_URL, NATS_WS_URL, RECEIVER_SEED and CLOUD_SEED; skipped without them.
const test = require("node:test");
const assert = require("node:assert");
const { connect, nkeyAuthenticator } = require("@nats-io/transport-node");
const { wsconnect } = require("@nats-io/nats-core");
const { jetstream, jetstreamManager } = require("@nats-io/jetstream");
const { ensureStream } = require("../../src/stream");

const env = process.env;
const skip = !(env.NATS_URL && env.NATS_WS_URL && env.RECEIVER_SEED && env.CLOUD_SEED) && "needs a nats-server (CI integration job)";
const seed = (s) => nkeyAuthenticator(new TextEncoder().encode(s));
const opts = { timeout: 3000, reconnect: false };

async function closes(promise) {
  let nc;
  try { nc = await promise; } catch { return true; }
  // Some refusals arrive after the connection opened: a request must still fail.
  try { await nc.request("$JS.API.INFO", "", { timeout: 1000 }); return false; } catch { return true; } finally { await nc.close().catch(() => {}); }
}

async function nextFrom(nc) {
  const js = jetstream(nc);
  const c = await js.consumers.get("GITHUB", "dispatcher");
  const m = await c.next({ expires: 3000 });
  assert.ok(m, "a message arrived");
  m.ack();
  return { subject: m.subject, data: m.json() };
}

test("the receiver creates the stream and publishes; a repeated delivery is dropped", { skip }, async () => {
  const nc = await connect({ servers: env.NATS_URL, authenticator: seed(env.RECEIVER_SEED), ...opts });
  try {
    await ensureStream(await jetstreamManager(nc));
    await ensureStream(await jetstreamManager(nc)); // a restart updates in place
    const js = jetstream(nc);
    const a = await js.publish("github.o.r.pr.1.pull_request", JSON.stringify({ pr: 1 }), { msgID: "guid-1" });
    const b = await js.publish("github.o.r.pr.1.pull_request", JSON.stringify({ pr: 1 }), { msgID: "guid-1" });
    assert.strictEqual(a.duplicate, false);
    assert.strictEqual(b.duplicate, true);
    await js.publish("github.o.r.pr.2.pull_request", JSON.stringify({ pr: 2 }), { msgID: "guid-2" });
  } finally { await nc.close(); }
});

test("a LAN connection with no key reads the dispatcher consumer", { skip }, async () => {
  const nc = await connect({ servers: env.NATS_URL, ...opts });
  try {
    const got = await nextFrom(nc);
    assert.strictEqual(got.subject, "github.o.r.pr.1.pull_request");
    assert.deepStrictEqual(got.data, { pr: 1 });
  } finally { await nc.close(); }
});

test("a LAN connection cannot publish events", { skip }, async () => {
  const nc = await connect({ servers: env.NATS_URL, ...opts });
  try {
    await assert.rejects(jetstream(nc).publish("github.o.r.pr.9.pull_request", "{}", { timeout: 1500 }));
  } finally { await nc.close(); }
});

test("a websocket connection with no key is refused", { skip }, async () => {
  assert.ok(await closes(wsconnect({ servers: env.NATS_WS_URL, ...opts })));
});

test("a websocket connection with the cloud key reads the dispatcher consumer", { skip }, async () => {
  const nc = await wsconnect({ servers: env.NATS_WS_URL, authenticator: seed(env.CLOUD_SEED), ...opts });
  try {
    const got = await nextFrom(nc);
    assert.strictEqual(got.subject, "github.o.r.pr.2.pull_request");
  } finally { await nc.close(); }
});

test("the cloud key is refused on a plain connection, and the receiver key on websocket", { skip }, async () => {
  assert.ok(await closes(connect({ servers: env.NATS_URL, authenticator: seed(env.CLOUD_SEED), ...opts })));
  assert.ok(await closes(wsconnect({ servers: env.NATS_WS_URL, authenticator: seed(env.RECEIVER_SEED), ...opts })));
});
