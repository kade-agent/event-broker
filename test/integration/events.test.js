"use strict";
// Runs against a real nats-server started with nats/nats-server.conf (CI's integration job): stream
// EVENTS and its profile consumers, and what the accounts allow. Same environment as nats.test.js;
// skipped without it. Account A is kade-agent, B is stella-rain; their keys are made by CI.
const test = require("node:test");
const assert = require("node:assert");
const { connect, nkeyAuthenticator } = require("@nats-io/transport-node");
const { wsconnect } = require("@nats-io/nats-core");
const { jetstream, jetstreamManager } = require("@nats-io/jetstream");
const { ensureStream } = require("../../src/stream");
const { PROFILES } = require("../../src/profiles");

const env = process.env;
const A = "kade-agent";
const B = "stella-rain";
const skip = !(env.NATS_URL && env.NATS_WS_URL && env.RECEIVER_SEED_A && env.READER_SEED_A && env.RECEIVER_SEED_B && env.READER_SEED_B)
  && "needs a nats-server (CI integration job)";
const seed = (s) => nkeyAuthenticator(new TextEncoder().encode(s));
const opts = { timeout: 3000, reconnect: false };
const lan = (s) => connect({ servers: env.NATS_URL, authenticator: seed(s), ...opts });
const ws = (s) => wsconnect({ servers: env.NATS_WS_URL, authenticator: seed(s), ...opts });

// The next message of EVENTS/dispatcher, acked; null when none comes in 2 s.
async function nextFrom(nc) {
  const c = await jetstream(nc).consumers.get("EVENTS", "dispatcher");
  const m = await c.next({ expires: 2000 });
  if (!m) return null;
  m.ack();
  return { subject: m.subject, data: m.json() };
}

test("each receiver creates GITHUB and EVENTS with every profile consumer, and a restart updates in place", { skip }, async () => {
  for (const [owner, s] of [[A, env.RECEIVER_SEED_A], [B, env.RECEIVER_SEED_B]]) {
    const nc = await lan(s);
    try {
      const jsm = await jetstreamManager(nc);
      await ensureStream(jsm, owner);
      await ensureStream(jsm, owner);
      const info = await jsm.streams.info("EVENTS");
      assert.deepStrictEqual(info.config.subjects, [`ev.${owner}.>`]);
      assert.strictEqual(info.config.max_bytes, 25165824);
      assert.strictEqual((await jsm.consumers.info("GITHUB", "dispatcher")).config.filter_subjects.length, 8);
      assert.strictEqual((await jsm.consumers.info("EVENTS", "dispatcher")).config.filter_subjects.length, PROFILES.dispatcher.length);
      assert.strictEqual((await jsm.consumers.info("EVENTS", "all")).config.filter_subject, `ev.${owner}.>`);
    } finally { await nc.close(); }
  }
});

test("receiver A publishes v2 events; the dispatcher reader (LAN) gets only the pr_merged", { skip }, async () => {
  const pub = await lan(env.RECEIVER_SEED_A);
  try {
    const js = jetstream(pub);
    await js.publish(`ev.${A}.r.pr.1.pr_merged`, JSON.stringify({ n: "merged" }), { msgID: "ev-1" });
    await js.publish(`ev.${A}.r.pr.1.ci_passed`, JSON.stringify({ n: "passed" }), { msgID: "ev-2" });
  } finally { await pub.close(); }
  const nc = await lan(env.READER_SEED_A);
  try {
    const got = await nextFrom(nc);
    assert.strictEqual(got.subject, `ev.${A}.r.pr.1.pr_merged`);
    assert.deepStrictEqual(got.data, { n: "merged" });
    assert.strictEqual(await nextFrom(nc), null);
  } finally { await nc.close(); }
});

test("reader A reads EVENTS over websocket", { skip }, async () => {
  const pub = await lan(env.RECEIVER_SEED_A);
  try { await jetstream(pub).publish(`ev.${A}.r.pr.2.pr_merged`, JSON.stringify({ n: "ws" }), { msgID: "ev-3" }); } finally { await pub.close(); }
  const nc = await ws(env.READER_SEED_A);
  try {
    assert.strictEqual((await nextFrom(nc)).subject, `ev.${A}.r.pr.2.pr_merged`);
  } finally { await nc.close(); }
});

test("a reader cannot publish to ev.<owner>.>", { skip }, async () => {
  const nc = await lan(env.READER_SEED_A);
  try {
    await assert.rejects(jetstream(nc).publish(`ev.${A}.r.pr.9.pr_merged`, "{}", { timeout: 1500 }));
  } finally { await nc.close(); }
});

test("receiver A cannot publish into account B's ev subjects, and reader B sees nothing of A's EVENTS", { skip }, async () => {
  const pub = await lan(env.RECEIVER_SEED_A);
  try {
    await assert.rejects(jetstream(pub).publish(`ev.${B}.r.pr.1.pr_merged`, "{}", { timeout: 1500 }));
  } finally { await pub.close(); }
  const nc = await lan(env.READER_SEED_B);
  try {
    assert.strictEqual(await nextFrom(nc), null);
    assert.strictEqual((await (await jetstreamManager(nc)).streams.info("EVENTS")).state.messages, 0);
  } finally { await nc.close(); }
});
