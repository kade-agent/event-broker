"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { PROFILES } = require("../src/profiles");
const { SIGNALS } = require("../src/signals");

// Decision 24: workers get CI, reviews and comments from their own PR subscription, so the
// dispatcher reads 13 signals, a DONE/BLOCKED comment as pr_report.
test("PROFILES.dispatcher has the design's 13 signals, each a known signal", () => {
  assert.deepStrictEqual(PROFILES.dispatcher, [
    "pr_merged", "pr_closed", "pr_ready", "pr_draft", "automerge_off", "merge_behind", "merge_dirty",
    "main_failed", "main_passed", "issue_closed", "issue_reopened", "issue_labeled", "pr_report",
  ]);
  for (const s of PROFILES.dispatcher) assert.ok(SIGNALS.includes(s), s);
});

test("PROFILES.all is null: every signal", () => {
  assert.strictEqual(PROFILES.all, null);
});
