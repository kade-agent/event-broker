"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { PROFILES } = require("../src/profiles");
const { SIGNALS } = require("../src/signals");

test("PROFILES.dispatcher has the design's 17 signals, each a known signal", () => {
  assert.deepStrictEqual(PROFILES.dispatcher, [
    "pr_merged", "pr_closed", "pr_ready", "pr_draft", "automerge_off", "merge_behind", "merge_dirty",
    "ci_failed", "main_failed", "main_passed", "review_changes", "review_comment", "issue_closed",
    "issue_reopened", "issue_labeled", "pr_comment", "issue_comment",
  ]);
  for (const s of PROFILES.dispatcher) assert.ok(SIGNALS.includes(s), s);
});

test("PROFILES.all is null: every signal", () => {
  assert.strictEqual(PROFILES.all, null);
});
