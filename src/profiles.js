"use strict";
// The durable consumers on stream EVENTS, one per profile (design section 9). A list is the
// signals the profile reads; null is every signal. All of them are in SIGNALS (src/signals.js).
const PROFILES = Object.freeze({
  dispatcher: Object.freeze([
    "pr_merged", "pr_closed", "pr_ready", "pr_draft", "automerge_off", "merge_behind", "merge_dirty",
    "ci_failed", "main_failed", "main_passed", "review_changes", "review_comment", "issue_closed",
    "issue_reopened", "issue_labeled", "pr_comment", "issue_comment", "push_branch",
  ]),
  all: null,
});

module.exports = { PROFILES };
