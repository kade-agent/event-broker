"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ensureStream, streamFor, eventsStreamFor, profileConsumerFor } = require("../src/stream");

// A jsm that records what it was asked, and knows only what was added.
function fakeJsm({ stream = false, consumer = false } = {}) {
  const calls = [];
  const missing = () => Object.assign(new Error("not found"), { code: "404" });
  return {
    calls,
    streams: {
      info: async () => { if (!stream) throw missing(); return {}; },
      add: async (cfg) => { calls.push(["streams.add", cfg]); },
      update: async (name, cfg) => { calls.push(["streams.update", name, cfg]); },
    },
    consumers: {
      info: async () => { if (!consumer) throw missing(); return {}; },
      add: async (stream, cfg) => { calls.push(["consumers.add", stream, cfg]); },
      update: async (stream, durable, cfg) => { calls.push(["consumers.update", stream, durable, cfg]); },
    },
  };
}

const FILTERS = (o) => [
  `github.${o}.*.pr.*.pull_request`,
  `github.${o}.*.pr.*.workflow_run`,
  `github.${o}.*.pr.*.mergeable`,
  `github.${o}.*.pr.*.pull_request_review`,
  `github.${o}.*.pr.*.issue_comment`,
  `github.${o}.*.issue.>`,
  `github.${o}.*.branch.*.workflow_run`,
  `github.${o}.*.push.*`,
];

test("a new account gets stream GITHUB on its owner's subjects", async () => {
  const jsm = fakeJsm();
  await ensureStream(jsm, "stella-rain");
  const add = jsm.calls.find((c) => c[0] === "streams.add");
  assert.strictEqual(add[1].name, "GITHUB");
  assert.deepStrictEqual(add[1].subjects, ["github.stella-rain.>"]);
});

test("an existing stream is updated in place", async () => {
  const jsm = fakeJsm({ stream: true, consumer: true });
  await ensureStream(jsm, "stella-rain");
  assert.ok(jsm.calls.some((c) => c[0] === "streams.update" && c[1] === "GITHUB"));
  assert.ok(!jsm.calls.some((c) => c[0] === "streams.add"));
});

test("the consumer dispatcher has the design's 8 filter_subjects for the owner", async () => {
  const jsm = fakeJsm();
  await ensureStream(jsm, "stella-rain");
  const add = jsm.calls.find((c) => c[0] === "consumers.add");
  assert.strictEqual(add[1], "GITHUB");
  assert.strictEqual(add[2].durable_name, "dispatcher");
  assert.deepStrictEqual(add[2].filter_subjects, FILTERS("stella-rain"));
  assert.strictEqual(add[2].filter_subjects.length, 8);
  assert.strictEqual(add[2].ack_policy, "explicit");
  assert.strictEqual(add[2].deliver_policy, "new");
  assert.strictEqual(add[2].ack_wait, 60e9);
});

test("an existing consumer is updated, not added", async () => {
  const jsm = fakeJsm({ stream: true, consumer: true });
  await ensureStream(jsm, "stella-rain");
  const upd = jsm.calls.find((c) => c[0] === "consumers.update");
  assert.deepStrictEqual([upd[1], upd[2]], ["GITHUB", "dispatcher"]);
  assert.deepStrictEqual(upd[3].filter_subjects, FILTERS("stella-rain"));
  assert.ok(!jsm.calls.some((c) => c[0] === "consumers.add"));
});

test("ensureStream adds GITHUB, its dispatcher, EVENTS, and the dispatcher and all profiles", async () => {
  const jsm = fakeJsm();
  await ensureStream(jsm, "stella-rain");
  assert.deepStrictEqual(jsm.calls.map((c) => c.slice(0, c[0] === "streams.add" ? 1 : 2).map((x) => x)).map((c) => c.join(" ")).sort(), [
    "consumers.add EVENTS", "consumers.add EVENTS", "consumers.add GITHUB", "streams.add", "streams.add",
  ].sort());
  const added = jsm.calls.filter((c) => c[0] === "streams.add").map((c) => c[1].name);
  assert.deepStrictEqual(added, ["GITHUB", "EVENTS"]);
  const ev = jsm.calls.filter((c) => c[0] === "consumers.add" && c[1] === "EVENTS").map((c) => c[2].durable_name);
  assert.deepStrictEqual(ev, ["dispatcher", "all"]);
});

test("a second run updates all five", async () => {
  const jsm = fakeJsm({ stream: true, consumer: true });
  await ensureStream(jsm, "stella-rain");
  assert.strictEqual(jsm.calls.filter((c) => c[0] === "streams.update").length, 2);
  assert.strictEqual(jsm.calls.filter((c) => c[0] === "consumers.update").length, 3);
  assert.ok(!jsm.calls.some((c) => c[0].endsWith(".add")));
});

test("a consumer on EVENTS that is not in the table is left alone and logged", async () => {
  const jsm = fakeJsm({ stream: true, consumer: true });
  jsm.consumers.list = (stream) => ({ [Symbol.asyncIterator]: async function* () {
    if (stream === "EVENTS") yield { name: "stray" };
    yield { name: "dispatcher" };
  } });
  const logs = [];
  await ensureStream(jsm, "stella-rain", (m) => logs.push(m));
  assert.ok(logs.some((m) => /stray/.test(m)));
  assert.ok(!jsm.calls.some((c) => c.includes("stray")));
});

test("EVENTS: ev.<owner>.> on file storage, 7 days, 24 MiB, discard old, 120 s duplicate window", () => {
  const s = eventsStreamFor("stella-rain");
  assert.strictEqual(s.name, "EVENTS");
  assert.deepStrictEqual(s.subjects, ["ev.stella-rain.>"]);
  assert.strictEqual(s.max_bytes, 25165824);
  assert.strictEqual(s.max_age, 7 * 24 * 3600 * 1e9);
  assert.strictEqual(s.discard, "old");
  assert.strictEqual(s.duplicate_window, 120e9);
});

test("profile consumers: dispatcher filters 17 signals, all filters ev.<owner>.>", () => {
  const d = profileConsumerFor("kade-agent", "dispatcher");
  assert.strictEqual(d.durable_name, "dispatcher");
  assert.strictEqual(d.filter_subjects.length, 17);
  assert.strictEqual(d.filter_subjects[0], "ev.kade-agent.*.*.*.pr_merged");
  assert.strictEqual(d.ack_policy, "explicit");
  assert.strictEqual(d.deliver_policy, "new");
  assert.strictEqual(d.ack_wait, 60e9);
  assert.strictEqual(d.max_ack_pending, 1000);
  const a = profileConsumerFor("kade-agent", "all");
  assert.strictEqual(a.filter_subject, "ev.kade-agent.>");
  assert.strictEqual(a.filter_subjects, undefined);
});

test("the owner is lower-cased in the subjects", async () => {
  const jsm = fakeJsm();
  await ensureStream(jsm, "Kade-Agent");
  assert.deepStrictEqual(jsm.calls.find((c) => c[0] === "streams.add")[1].subjects, ["github.kade-agent.>"]);
});

test("each stream reserves 128 MiB", () => {
  assert.strictEqual(streamFor("stella-rain").max_bytes, 134217728);
});

test("six orgs fit the server's max_file_store, so four leave room for two more", () => {
  const conf = fs.readFileSync(path.join(__dirname, "..", "nats", "nats-server.conf"), "utf8");
  const m = /^\s*max_file_store:\s*(\d+)\s*(KB|MB|GB|TB)?\s*$/im.exec(conf);
  assert.ok(m, "max_file_store is set in nats-server.conf");
  const unit = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[(m[2] || "").toUpperCase()] || 1; // the server's decimal units
  assert.ok(6 * streamFor("stella-rain").max_bytes <= Number(m[1]) * unit);
});

test("six accounts of GITHUB + EVENTS fit max_file_store", () => {
  const conf = fs.readFileSync(path.join(__dirname, "..", "nats", "nats-server.conf"), "utf8");
  const m = /^\s*max_file_store:\s*(\d+)\s*(KB|MB|GB|TB)?\s*$/im.exec(conf);
  const unit = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[(m[2] || "").toUpperCase()] || 1;
  assert.strictEqual(6 * (streamFor("x").max_bytes + eventsStreamFor("x").max_bytes), 956301312);
  assert.ok(6 * (streamFor("x").max_bytes + eventsStreamFor("x").max_bytes) <= Number(m[1]) * unit);
});
