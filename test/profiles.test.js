"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { PROFILES } = require("../src/profiles");
const { SIGNALS } = require("../src/signals");

// Decision 24: workers get CI, reviews and comments from their own PR subscription, so the
// dispatcher reads what it acts on. Decision 30: 9 signals, a BLOCKED comment as pr_report; pr_ready, pr_draft,
// automerge_off and issue_reopened (each a look-up of who did it) are dropped.
test("PROFILES.dispatcher has the design's 9 signals, each a known signal", () => {
  assert.deepStrictEqual(PROFILES.dispatcher, [
    "pr_merged", "pr_closed", "merge_behind", "merge_dirty",
    "main_failed", "main_passed", "issue_closed", "issue_labeled", "pr_report",
  ]);
  for (const s of PROFILES.dispatcher) assert.ok(SIGNALS.includes(s), s);
});

test("PROFILES.all is null: every signal", () => {
  assert.strictEqual(PROFILES.all, null);
});
