"use strict";
// Runs against a real nats-server started with nats/nats-server.conf (CI's integration job).
// Needs NATS_URL, NATS_WS_URL and the throwaway seeds RECEIVER_SEED_A, READER_SEED_A,
// RECEIVER_SEED_B, READER_SEED_B; skipped without them. Accounts A and B are the conf's first two
// real owners below; their keys are made by CI, so nothing here is a real key.
const test = require("node:test");
const assert = require("node:assert");
const { connect, nkeyAuthenticator } = require("@nats-io/transport-node");
const { wsconnect } = require("@nats-io/nats-core");
const { jetstream, jetstreamManager } = require("@nats-io/jetstream");
const { ensureStream } = require("../../src/stream");

const env = process.env;
const A = "kade-agent";
const B = "stella-rain";
const skip = !(env.NATS_URL && env.NATS_WS_URL && env.RECEIVER_SEED_A && env.READER_SEED_A && env.RECEIVER_SEED_B && env.READER_SEED_B)
  && "needs a nats-server (CI integration job)";
const seed = (s) => nkeyAuthenticator(new TextEncoder().encode(s));
const opts = { timeout: 3000, reconnect: false };
const lan = (s) => connect({ servers: env.NATS_URL, authenticator: seed(s), ...opts });
const ws = (s) => wsconnect({ servers: env.NATS_WS_URL, authenticator: seed(s), ...opts });

async function closes(promise) {
  let nc;
  try { nc = await promise; } catch { return true; }
  // Some refusals arrive after the connection opened: a request must still fail.
  try { await nc.request("$JS.API.INFO", "", { timeout: 1000 }); return false; } catch { return true; } finally { await nc.close().catch(() => {}); }
}

// The next message of consumer dispatcher, acked; null when none comes in 2 s.
async function nextFrom(nc) {
  const c = await jetstream(nc).consumers.get("GITHUB", "dispatcher");
  const m = await c.next({ expires: 2000 });
  if (!m) return null;
  m.ack();
  return { subject: m.subject, data: m.json() };
}

test("each receiver makes its own account's stream and consumer, and a repeated delivery is dropped", { skip }, async () => {
  for (const [owner, s] of [[A, env.RECEIVER_SEED_A], [B, env.RECEIVER_SEED_B]]) {
    const nc = await lan(s);
    try {
      await ensureStream(await jetstreamManager(nc), owner);
      await ensureStream(await jetstreamManager(nc), owner); // a restart updates in place
      const info = await (await jetstreamManager(nc)).consumers.info("GITHUB", "dispatcher");
      assert.strictEqual(info.config.filter_subjects.length, 8);
    } finally { await nc.close(); }
  }
  const nc = await lan(env.RECEIVER_SEED_A);
  try {
    const js = jetstream(nc);
    const a = await js.publish(`github.${A}.r.pr.1.check_run`, JSON.stringify({ n: "check" }), { msgID: "guid-1" });
    const b = await js.publish(`github.${A}.r.pr.1.check_run`, JSON.stringify({ n: "check" }), { msgID: "guid-1" });
    assert.strictEqual(a.duplicate, false);
    assert.strictEqual(b.duplicate, true);
    await js.publish(`github.${A}.r.pr.1.workflow_run`, JSON.stringify({ n: "run" }), { msgID: "guid-2" });
  } finally { await nc.close(); }
});

test("reader A, on the LAN port, gets only the workflow_run: the consumer filters out the check_run", { skip }, async () => {
  const nc = await lan(env.READER_SEED_A);
  try {
    const got = await nextFrom(nc);
    assert.strictEqual(got.subject, `github.${A}.r.pr.1.workflow_run`);
    assert.deepStrictEqual(got.data, { n: "run" });
    assert.strictEqual(await nextFrom(nc), null);
  } finally { await nc.close(); }
});

test("reader B sees nothing of account A", { skip }, async () => {
  const nc = await lan(env.READER_SEED_B);
  try {
    assert.strictEqual(await nextFrom(nc), null);
    const info = await (await jetstreamManager(nc)).streams.info("GITHUB");
    assert.strictEqual(info.state.messages, 0);
  } finally { await nc.close(); }
});

test("receiver A cannot publish into account B's subjects", { skip }, async () => {
  const nc = await lan(env.RECEIVER_SEED_A);
  try {
    await assert.rejects(jetstream(nc).publish(`github.${B}.r.pr.1.workflow_run`, "{}", { timeout: 1500 }));
  } finally { await nc.close(); }
});

test("a reader cannot publish events", { skip }, async () => {
  const nc = await lan(env.READER_SEED_A);
  try {
    await assert.rejects(jetstream(nc).publish(`github.${A}.r.pr.9.workflow_run`, "{}", { timeout: 1500 }));
  } finally { await nc.close(); }
});

test("reader A reads over websocket", { skip }, async () => {
  const pub = await lan(env.RECEIVER_SEED_A);
  try { await jetstream(pub).publish(`github.${A}.r.pr.2.workflow_run`, JSON.stringify({ n: "ws" }), { msgID: "guid-3" }); } finally { await pub.close(); }
  const nc = await ws(env.READER_SEED_A);
  try {
    const got = await nextFrom(nc);
    assert.strictEqual(got.subject, `github.${A}.r.pr.2.workflow_run`);
  } finally { await nc.close(); }
});

test("a connection with no key is refused on both ports", { skip }, async () => {
  assert.ok(await closes(connect({ servers: env.NATS_URL, ...opts })));
  assert.ok(await closes(wsconnect({ servers: env.NATS_WS_URL, ...opts })));
});

test("a receiver key is refused on websocket", { skip }, async () => {
  assert.ok(await closes(ws(env.RECEIVER_SEED_A)));
});

// Decision 19 (S1): the receiver keeps its state in STATE, one message per subject; the reader gets nothing of it.
test("receiver A writes and reads back its state through STATE; a second write replaces the first; reader A reads it but cannot write", { skip }, async () => {
  const { stateKey } = require("../../src/stream");
  const key = stateKey(`${A}/r`, "main", "Rust");
  const nc = await lan(env.RECEIVER_SEED_A);
  try {
    const jsm = await jetstreamManager(nc);
    await ensureStream(jsm, A);
    const js = jetstream(nc);
    await js.publish(key, JSON.stringify({ passed: false }));
    await js.publish(key, JSON.stringify({ passed: true }));
    assert.deepStrictEqual((await jsm.streams.getMessage("STATE", { last_by_subj: key })).json(), { passed: true });
    assert.strictEqual((await jsm.streams.info("STATE")).state.messages, 1);
  } finally { await nc.close(); }
  const reader = await lan(env.READER_SEED_A);
  try {
    // Decision 21 (S3): the reader reads STATE for watch.js --state, and cannot write it.
    assert.deepStrictEqual((await (await jetstreamManager(reader)).streams.getMessage("STATE", { last_by_subj: key })).json(), { passed: true });
    await assert.rejects(jetstream(reader).publish(key, JSON.stringify({ passed: false }), { timeout: 1500 }));
  } finally { await reader.close(); }
});
