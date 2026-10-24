"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createMergeWatch } = require("../src/mergeable");

const head = (n) => ({ ref: `claude/t${n}`, sha: `sha${n}` });

// states: { n: ["unknown", "dirty", ...] } -> each read of PR n returns the next state, the last one repeats.
function fakeGh(states, open = Object.keys(states).map(Number), base = "main") {
  const reads = [];
  return {
    reads,
    async get(repo, path) {
      reads.push(path);
      const list = /^\/pulls\?state=open&base=([^&]+)&per_page=100$/.exec(path);
      if (list) return list[1] === base ? open.map((n) => ({ number: n })) : [];
      const n = Number(/^\/pulls\/(\d+)$/.exec(path)[1]);
      const seq = states[n];
      const state = seq.length > 1 ? seq.shift() : seq[0];
      return { number: n, mergeable_state: state, draft: false, auto_merge: null, head: head(n) };
    },
  };
}

function watch(gh, opts = {}) {
  const published = [];
  const w = createMergeWatch({ gh, publish: async (subject, event, msgId) => published.push({ subject, event, msgId }),
    sleep: async () => {}, maxTries: 4, ...opts });
  return { w, published };
}

test("a PR's state is read past 'unknown' and published once", async () => {
  const { w, published } = watch(fakeGh({ 5: ["unknown", "unknown", "dirty"] }));
  await w.handle({ repo: "stella-rain/app", pr: 5 });
  assert.strictEqual(published.length, 1);
  const { subject, event, msgId } = published[0];
  assert.strictEqual(subject, "github.stella-rain.app.pr.5.mergeable");
  assert.strictEqual(event.event, "mergeable");
  assert.strictEqual(event.mergeable_state, "dirty");
  assert.strictEqual(event.branch, "claude/t5");
  assert.strictEqual(event.sha, "sha5");
  assert.strictEqual(msgId, "mergeable:stella-rain/app#5:sha5:dirty");
});

test("an unchanged state is not published again; a change is", async () => {
  const states = { 5: ["dirty"] };
  const { w, published } = watch(fakeGh(states));
  await w.handle({ repo: "stella-rain/app", pr: 5 });
  await w.handle({ repo: "stella-rain/app", pr: 5 });
  assert.strictEqual(published.length, 1);
  states[5] = ["clean"];
  await w.handle({ repo: "stella-rain/app", pr: 5 });
  assert.deepStrictEqual(published.map((p) => p.event.mergeable_state), ["dirty", "clean"]);
});

test("a state still 'unknown' after maxTries is not published", async () => {
  const gh = fakeGh({ 5: ["unknown"] });
  const { w, published } = watch(gh);
  await w.handle({ repo: "stella-rain/app", pr: 5 });
  assert.strictEqual(published.length, 0);
  assert.strictEqual(gh.reads.length, 4);
});

test("a push checks every open PR on that base, and only those", async () => {
  const { w, published } = watch(fakeGh({ 1: ["behind"], 2: ["clean"] }));
  await w.handle({ repo: "stella-rain/app", base: "main" });
  assert.deepStrictEqual(published.map((p) => [p.event.pr, p.event.mergeable_state]), [[1, "behind"], [2, "clean"]]);
  const other = watch(fakeGh({ 1: ["behind"] }));
  await other.w.handle({ repo: "stella-rain/app", base: "release" });
  assert.strictEqual(other.published.length, 0);
});

test("the backoff doubles between reads", async () => {
  const waits = [];
  const { w } = watch(fakeGh({ 5: ["unknown", "unknown", "unknown", "clean"] }), { sleep: async (ms) => waits.push(ms), baseDelayMs: 1000 });
  await w.handle({ repo: "o/r", pr: 5 });
  assert.deepStrictEqual(waits, [1000, 2000, 4000]);
});

test("a failed read of one PR does not stop the others", async () => {
  const gh = fakeGh({ 1: ["dirty"], 2: ["behind"] });
  const get = gh.get;
  gh.get = async (repo, path) => { if (path === "/pulls/1") throw new Error("GitHub 502"); return get(repo, path); };
  const errors = [];
  const { w, published } = watch(gh, { onError: (e) => errors.push(e.message) });
  await w.handle({ repo: "stella-rain/app", base: "main" });
  assert.deepStrictEqual(published.map((p) => p.event.pr), [2]);
  assert.deepStrictEqual(errors, ["GitHub 502"]);
});
