"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { signalOf, v2Of, SIGNALS } = require("../src/signals");
const { blank } = require("../src/normalize");

const ev = (fields) => ({ ...blank("d1", "stella-rain/app"), ...fields });

// One row per line of the design's signal table (agent-config docs/event-broker-design.md, section 9).
const ROWS = [
  [{ event: "pull_request", action: "closed", merged: true, pr: 1 }, "pr_merged"],
  [{ event: "pull_request", action: "closed", merged: false, pr: 1 }, "pr_closed"],
  [{ event: "pull_request", action: "ready_for_review", pr: 1 }, "pr_ready"],
  [{ event: "pull_request", action: "converted_to_draft", pr: 1 }, "pr_draft"],
  [{ event: "pull_request", action: "auto_merge_enabled", pr: 1 }, "automerge_on"],
  [{ event: "pull_request", action: "auto_merge_disabled", pr: 1 }, "automerge_off"],
  ...["behind", "dirty", "clean", "blocked", "unstable", "draft"].map((s) =>
    [{ event: "mergeable", mergeable_state: s, pr: 1 }, `merge_${s}`]),
  [{ event: "mergeable", mergeable_state: "unknown", pr: 1 }, "merge_other"],
  [{ event: "mergeable", mergeable_state: null, pr: 1 }, "merge_other"],
  [{ event: "workflow_run", conclusion: "failure", pr: 341, branch: "claude/x" }, "ci_failed"],
  [{ event: "workflow_run", conclusion: "success", pr: 341, branch: "claude/x" }, "ci_passed"],
  [{ event: "workflow_run", conclusion: "cancelled", pr: 341, branch: "claude/x" }, "ci_other"],
  [{ event: "workflow_run", conclusion: "timed_out", pr: null, branch: "main" }, "main_failed"],
  [{ event: "workflow_run", conclusion: "success", pr: null, branch: "main" }, "main_passed"],
  [{ event: "workflow_run", conclusion: "skipped", pr: null, branch: "main" }, "main_other"],
  [{ event: "workflow_run", conclusion: "failure", pr: null, branch: "claude/x" }, "branch_failed"],
  [{ event: "workflow_run", conclusion: "success", pr: null, branch: "claude/x" }, "branch_passed"],
  [{ event: "workflow_run", conclusion: null, pr: null, branch: "claude/x" }, "branch_other"],
  [{ event: "check_run", conclusion: "failure", pr: 341, branch: "claude/x" }, "check_failed"],
  [{ event: "check_run", conclusion: "success", pr: null, branch: "main" }, "check_passed"],
  [{ event: "check_suite", conclusion: "neutral", pr: null, branch: "claude/x" }, "check_other"],
  [{ event: "check_suite", conclusion: "action_required", pr: 3, branch: "claude/x" }, "check_failed"],
  [{ event: "pull_request_review", conclusion: "CHANGES_REQUESTED", pr: 1 }, "review_changes"],
  [{ event: "pull_request_review", conclusion: "commented", pr: 1 }, "review_comment"],
  [{ event: "pull_request_review", conclusion: "APPROVED", pr: 1 }, "review_approved"],
  [{ event: "pull_request_review", conclusion: "dismissed", pr: 1 }, "review_dismissed"],
  [{ event: "pull_request_review", conclusion: "pending", pr: 1 }, "review_other"],
  [{ event: "issues", action: "closed", issue: 4 }, "issue_closed"],
  [{ event: "issues", action: "reopened", issue: 4 }, "issue_reopened"],
  [{ event: "issues", action: "labeled", issue: 4, label: "bug" }, "issue_labeled"],
  [{ event: "issue_comment", action: "created", pr: 7 }, "pr_comment"],
  [{ event: "issue_comment", action: "created", issue: 4 }, "issue_comment"],
  [{ event: "push", branch: "main" }, "push_main"],
];

test("every row of the design's signal table gets its signal", () => {
  for (const [fields, signal] of ROWS) {
    assert.strictEqual(signalOf(ev(fields), "main"), signal, JSON.stringify(fields));
  }
});

test("the table covers every signal", () => {
  assert.deepStrictEqual(new Set(ROWS.map(([, s]) => s)), new Set(SIGNALS));
});

test("SIGNALS is the frozen list of 36 unique [a-z_] names", () => {
  assert.strictEqual(SIGNALS.length, 36);
  assert.strictEqual(new Set(SIGNALS).size, 36);
  assert.ok(Object.isFrozen(SIGNALS));
  for (const s of SIGNALS) assert.match(s, /^[a-z_]+$/);
});

test("main is the default branch of the repository, not the name main", () => {
  const run = ev({ event: "workflow_run", conclusion: "failure", pr: null, branch: "trunk" });
  assert.strictEqual(signalOf(run, "trunk"), "main_failed");
  assert.strictEqual(signalOf(run, "main"), "branch_failed");
});

test("every table row gets a six-token subject and a signal from SIGNALS", () => {
  for (const [fields, signal] of ROWS) {
    const v2 = v2Of(ev(fields), "main");
    assert.strictEqual(v2.subject.split(".").length, 6, v2.subject);
    assert.ok(SIGNALS.includes(v2.event.signal));
    assert.strictEqual(v2.event.signal, signal);
    assert.ok(v2.subject.endsWith(`.${signal}`));
  }
});

test("a PR event goes to the pr scope with every v1 field kept", () => {
  const e = ev({ event: "workflow_run", action: "completed", conclusion: "failure", pr: 341, branch: "claude/z3-orbs",
    sha: "9f2c1e0", check: { name: "test", url: "https://github.com/x" } });
  assert.deepStrictEqual(v2Of(e, "main"), {
    subject: "ev.stella-rain.app.pr.341.ci_failed",
    event: { ...e, v: 2, signal: "ci_failed" },
  });
});

test("the owner is lower-cased, a repo's dots and underscores stay token-safe", () => {
  const e = { ...blank("d1", "Stella-Rain/_github"), event: "push", branch: "main", sha: "a" };
  assert.strictEqual(v2Of(e, "main").subject, "ev.stella-rain._github.branch.main.push_main");
});

test("a branch without a PR goes through token()", () => {
  const e = ev({ event: "workflow_run", conclusion: "failure", branch: "release/1.2" });
  assert.strictEqual(v2Of(e, "main").subject, "ev.stella-rain.app.branch.release/1_2.branch_failed");
});

test("an issue goes to the issue scope", () => {
  assert.strictEqual(v2Of(ev({ event: "issues", action: "labeled", issue: 4, label: "x" }), "main").subject,
    "ev.stella-rain.app.issue.4.issue_labeled");
});
