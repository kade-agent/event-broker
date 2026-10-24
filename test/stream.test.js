"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { ensureStream } = require("../src/stream");

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

test("the owner is lower-cased in the subjects", async () => {
  const jsm = fakeJsm();
  await ensureStream(jsm, "Kade-Agent");
  assert.deepStrictEqual(jsm.calls.find((c) => c[0] === "streams.add")[1].subjects, ["github.kade-agent.>"]);
});
