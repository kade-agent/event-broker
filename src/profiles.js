"use strict";
// The durable consumers on stream EVENTS, one per profile (design section 9). A list is the
// signals the profile reads; null is every signal. All of them are in SIGNALS (src/signals.js).
const PROFILES = Object.freeze({
  // Decision 24: workers get CI, reviews and comments from their own PR subscription.
  // Decision 30: only what the dispatcher acts on, 9 signals.
  dispatcher: Object.freeze([
    "pr_merged", "pr_closed", "merge_behind", "merge_dirty",
    "main_failed", "main_passed", "issue_closed", "issue_labeled", "pr_report",
  ]),
  all: null,
});

module.exports = { PROFILES };
