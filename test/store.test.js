"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openStore } = require("../src/store");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-"));
const ev = (n) => ({ repo: "o/r", pr: n, branch: "b", event: "push", action: null, merged: null, conclusion: null, sha: "s" });

test("ids increase from 1 and replay returns what came after an id", () => {
  const s = openStore(tmp());
  assert.strictEqual(s.append(ev(1)).id, 1);
  assert.strictEqual(s.append(ev(2)).id, 2);
  s.append(ev(3));
  assert.deepStrictEqual(s.since(1).map((e) => e.id), [2, 3]);
  assert.deepStrictEqual(s.since(3), []);
  assert.strictEqual(s.lastId(), 3);
});

test("events and ids survive a restart", () => {
  const dir = tmp();
  const a = openStore(dir);
  a.append(ev(1));
  a.append(ev(2));
  const b = openStore(dir);
  assert.deepStrictEqual(b.since(0).map((e) => e.pr), [1, 2]);
  assert.strictEqual(b.append(ev(3)).id, 3);
});

test("only the newest maxEvents are kept, and ids never go back", () => {
  const dir = tmp();
  const s = openStore(dir, { maxEvents: 3 });
  for (let i = 1; i <= 5; i++) s.append(ev(i));
  assert.deepStrictEqual(s.since(0).map((e) => e.id), [3, 4, 5]);
  assert.deepStrictEqual(openStore(dir, { maxEvents: 3 }).since(0).map((e) => e.id), [3, 4, 5]);
});

test("events older than maxAgeMs go, but the newest stays so ids continue", () => {
  const dir = tmp();
  let t = 1000;
  const s = openStore(dir, { maxAgeMs: 100, now: () => t });
  s.append(ev(1));
  s.append(ev(2));
  t = 5000;
  const r = openStore(dir, { maxAgeMs: 100, now: () => t });
  assert.deepStrictEqual(r.since(0).map((e) => e.id), [2]);
  assert.strictEqual(r.append(ev(3)).id, 3);
});

test("a torn last line from a crash is skipped", () => {
  const dir = tmp();
  const s = openStore(dir);
  s.append(ev(1));
  fs.appendFileSync(path.join(dir, "events.jsonl"), '{"id":2,"re');
  const r = openStore(dir);
  assert.deepStrictEqual(r.since(0).map((e) => e.id), [1]);
  assert.strictEqual(r.append(ev(2)).id, 2);
  assert.deepStrictEqual(openStore(dir).since(0).map((e) => e.id), [1, 2]);
});
