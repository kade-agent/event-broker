"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ensureStream, streamFor, eventsStreamFor, profileConsumerFor, stateStreamFor, stateKey, createStateStore } = require("../src/stream");

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
      list: () => ({ [Symbol.asyncIterator]: async function* () {} }),
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

test("ensureStream adds GITHUB, its dispatcher, EVENTS, the dispatcher and all profiles, and STATE", async () => {
  const jsm = fakeJsm();
  await ensureStream(jsm, "stella-rain");
  assert.deepStrictEqual(jsm.calls.map((c) => c.slice(0, c[0] === "streams.add" ? 1 : 2).map((x) => x)).map((c) => c.join(" ")).sort(), [
    "consumers.add EVENTS", "consumers.add EVENTS", "consumers.add GITHUB", "streams.add", "streams.add", "streams.add",
  ].sort());
  const added = jsm.calls.filter((c) => c[0] === "streams.add").map((c) => c[1].name);
  assert.deepStrictEqual(added, ["GITHUB", "EVENTS", "STATE"]);
  const ev = jsm.calls.filter((c) => c[0] === "consumers.add" && c[1] === "EVENTS").map((c) => c[2].durable_name);
  assert.deepStrictEqual(ev, ["dispatcher", "all"]);
});

test("a second run updates all six", async () => {
  const jsm = fakeJsm({ stream: true, consumer: true });
  await ensureStream(jsm, "stella-rain");
  assert.strictEqual(jsm.calls.filter((c) => c[0] === "streams.update").length, 3);
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

test("a failing consumer listing only logs: it cannot stop the receiver from starting", async () => {
  const jsm = fakeJsm();
  jsm.consumers.list = () => { throw new Error("permissions violation"); };
  const logs = [];
  await ensureStream(jsm, "stella-rain", (m) => logs.push(m));
  assert.strictEqual(jsm.calls.filter((c) => c[0] === "consumers.add").length, 3);
  assert.ok(logs.some((m) => /permissions violation/.test(m)));
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

test("profile consumers: dispatcher filters 18 signals, all filters ev.<owner>.>", () => {
  const d = profileConsumerFor("kade-agent", "dispatcher");
  assert.strictEqual(d.durable_name, "dispatcher");
  assert.strictEqual(d.filter_subjects.length, 18);
  assert.strictEqual(d.filter_subjects.at(-1), "ev.kade-agent.*.*.*.push_branch");
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

// ---- decision 19 (S1): stream STATE ----

const MiB = 1024 * 1024;

test("STATE: state.<owner>.> on file storage, one message per subject, 30 days, 4 MiB, discard old", () => {
  const s = stateStreamFor("kade-agent");
  assert.strictEqual(s.name, "STATE");
  assert.deepStrictEqual(s.subjects, ["state.kade-agent.>"]);
  assert.strictEqual(s.storage, "file");
  assert.strictEqual(s.max_msgs_per_subject, 1);
  assert.strictEqual(s.max_age, 30 * 24 * 3600 * 1e9);
  assert.strictEqual(s.max_bytes, 4 * MiB);
  assert.strictEqual(s.discard, "old");
});

test("six accounts of GITHUB + EVENTS + STATE fit max_file_store", () => {
  const conf = fs.readFileSync(path.join(__dirname, "..", "nats", "nats-server.conf"), "utf8");
  const m = /^\s*max_file_store:\s*(\d+)\s*(KB|MB|GB|TB)?\s*$/im.exec(conf);
  const unit = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[(m[2] || "").toUpperCase()] || 1;
  const six = 6 * (streamFor("x").max_bytes + eventsStreamFor("x").max_bytes + stateStreamFor("x").max_bytes);
  assert.strictEqual(six, 981467136);
  assert.ok(six <= Number(m[1]) * unit);
});

test("stateKey: state.<owner>.<repo>.<topic...>, owner lower-cased, every part token-safe", () => {
  assert.strictEqual(stateKey("Stella-Rain/app", "pr", 5, "mergeable"), "state.stella-rain.app.pr.5.mergeable");
  assert.strictEqual(stateKey("kade-agent/.github", "main", "Rust check"), "state.kade-agent._github.main.Rust_check");
});

test("nats-server.conf: each receiver may write state.<owner>.> and use the STATE stream API; no reader may", () => {
  const conf = fs.readFileSync(path.join(__dirname, "..", "nats", "nats-server.conf"), "utf8");
  const owners = [...conf.matchAll(/^  "([a-z0-9-]+)": \{$/gm)].map((x) => x[1]);
  assert.deepStrictEqual(owners, ["kade-k8s-platform", "kade-agent", "stella-rain", "star-resonance"]);
  for (const o of owners) assert.ok(conf.includes(`"state.${o}.>"`), `receiver ${o} writes state.${o}.>`);
  for (const api of ["INFO", "CREATE", "UPDATE", "MSG.GET"]) {
    assert.strictEqual(conf.split(`"$JS.API.STREAM.${api}.STATE"`).length - 1, 4, `four receivers have STREAM.${api}.STATE`);
  }
  for (const block of conf.split("nkey: $READER_NKEY_").slice(1)) {
    assert.ok(!block.split("nkey: $RECEIVER_NKEY_")[0].includes("STATE"), "a reader has no STATE permission");
  }
});

// A store over a fake stream: read(key) -> value | null (throws for a failure), write(key, value).
function fakeBackend(values = {}) {
  const b = { values: { ...values }, reads: [], writes: [], failRead: false, failWrite: false };
  b.read = async (k) => { b.reads.push(k); if (b.failRead) throw new Error("timeout"); return k in b.values ? b.values[k] : null; };
  b.write = async (k, v) => { b.writes.push(k); if (b.failWrite) throw new Error("no responders"); b.values[k] = v; };
  return b;
}

test("state store: memory first, else the stream; a missing key is null and is asked again", async () => {
  const b = fakeBackend({ "state.a.r.main.w": { passed: true } });
  const logs = [];
  const st = createStateStore({ read: b.read, write: b.write, log: (l) => logs.push(l) });
  assert.deepStrictEqual(await st.get("state.a.r.main.w"), { passed: true });
  assert.deepStrictEqual(await st.get("state.a.r.main.w"), { passed: true });
  assert.strictEqual(await st.get("state.a.r.main.x"), null);
  assert.strictEqual(await st.get("state.a.r.main.x"), null);
  assert.deepStrictEqual(b.reads, ["state.a.r.main.w", "state.a.r.main.x", "state.a.r.main.x"]);
  assert.deepStrictEqual(logs, []);
});

test("state store: put writes through and is read back from memory; a new store reads it from the stream", async () => {
  const b = fakeBackend();
  const st = createStateStore({ read: b.read, write: b.write, log: () => {} });
  await st.put("state.a.r.pr.1.mergeable", { mergeable_state: "dirty", sha: "s" });
  assert.deepStrictEqual(await st.get("state.a.r.pr.1.mergeable"), { mergeable_state: "dirty", sha: "s" });
  assert.deepStrictEqual(b.reads, []);
  const restarted = createStateStore({ read: b.read, write: b.write, log: () => {} });
  assert.deepStrictEqual(await restarted.get("state.a.r.pr.1.mergeable"), { mergeable_state: "dirty", sha: "s" });
});

test("state store: a failed read is null and logged; a failed write is logged and memory keeps the value", async () => {
  const b = fakeBackend();
  const logs = [];
  const st = createStateStore({ read: b.read, write: b.write, log: (l) => logs.push(l) });
  b.failRead = true;
  assert.strictEqual(await st.get("state.a.r.main.w"), null);
  b.failWrite = true;
  await st.put("state.a.r.main.w", { passed: false });
  assert.deepStrictEqual(await st.get("state.a.r.main.w"), { passed: false });
  assert.deepStrictEqual(logs, ["state read state.a.r.main.w: timeout", "state write state.a.r.main.w: no responders"]);
});

test("state store: with no backend it is memory only", async () => {
  const st = createStateStore();
  assert.strictEqual(await st.get("k"), null);
  await st.put("k", { passed: true });
  assert.deepStrictEqual(await st.get("k"), { passed: true });
});
