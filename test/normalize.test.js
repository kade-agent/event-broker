"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { normalize, mergeTrigger, token } = require("../src/normalize");

const repository = { full_name: "stella-rain/app", default_branch: "main" };
const pr = { number: 341, merged: true, draft: false, auto_merge: { merge_method: "squash" }, head: { ref: "claude/z3-orbs", sha: "9f2c1e0" } };
const D = "1f2e-guid";

const blank = {
  delivery: D, repo: "stella-rain/app", pr: null, branch: null, event: null, action: null, merged: null,
  draft: null, auto_merge: null, conclusion: null, check: null, mergeable_state: null, sha: null,
};

test("a merged PR becomes one event on its PR subject", () => {
  assert.deepStrictEqual(normalize("pull_request", { action: "closed", pull_request: pr, repository }, D), {
    subject: "github.stella-rain.app.pr.341.pull_request",
    event: { ...blank, pr: 341, branch: "claude/z3-orbs", event: "pull_request", action: "closed",
      merged: true, draft: false, auto_merge: true, sha: "9f2c1e0" },
  });
});

test("draft, ready and auto-merge changes are kept; opened and synchronize are not published", () => {
  for (const action of ["ready_for_review", "converted_to_draft", "auto_merge_enabled", "auto_merge_disabled"]) {
    assert.strictEqual(normalize("pull_request", { action, pull_request: pr, repository }, D).event.action, action);
  }
  const off = normalize("pull_request", { action: "auto_merge_disabled", pull_request: { ...pr, auto_merge: null }, repository }, D);
  assert.strictEqual(off.event.auto_merge, false);
  for (const action of ["opened", "synchronize", "edited", "labeled"]) {
    assert.strictEqual(normalize("pull_request", { action, pull_request: pr, repository }, D), null);
  }
});

test("a completed check run carries its name and URL", () => {
  const check_run = { name: "test", conclusion: "failure", head_sha: "abc", html_url: "https://github.com/x/runs/1",
    pull_requests: [{ number: 341 }], check_suite: { head_branch: "claude/z3-orbs" } };
  const r = normalize("check_run", { action: "completed", check_run, repository }, D);
  assert.strictEqual(r.subject, "github.stella-rain.app.pr.341.check_run");
  assert.deepStrictEqual(r.event.check, { name: "test", url: "https://github.com/x/runs/1" });
  assert.strictEqual(r.event.conclusion, "failure");
  assert.strictEqual(normalize("check_run", { action: "created", check_run, repository }, D), null);
});

test("a check suite and a workflow run carry their conclusion", () => {
  const check_suite = { conclusion: "success", head_branch: "claude/x", head_sha: "s", pull_requests: [{ number: 7 }], app: { name: "GitHub Actions" } };
  const s = normalize("check_suite", { action: "completed", check_suite, repository }, D);
  assert.deepStrictEqual(s.event.check, { name: "GitHub Actions", url: null });
  const workflow_run = { name: "test", conclusion: "failure", head_branch: "claude/x", head_sha: "s",
    html_url: "https://github.com/x/actions/runs/9", pull_requests: [{ number: 7 }] };
  const w = normalize("workflow_run", { action: "completed", workflow_run, repository }, D);
  assert.strictEqual(w.subject, "github.stella-rain.app.pr.7.workflow_run");
  assert.deepStrictEqual(w.event.check, { name: "test", url: "https://github.com/x/actions/runs/9" });
  assert.strictEqual(normalize("workflow_run", { action: "requested", workflow_run, repository }, D), null);
});

test("a check with no PR goes on its branch's subject", () => {
  const check_run = { name: "test", conclusion: "failure", head_sha: "s", html_url: "u", pull_requests: [], check_suite: { head_branch: "main" } };
  assert.strictEqual(normalize("check_run", { action: "completed", check_run, repository }, D).subject,
    "github.stella-rain.app.branch.main.check_run");
});

test("a submitted review carries its state as the conclusion", () => {
  const r = normalize("pull_request_review", { action: "submitted", review: { state: "changes_requested" }, pull_request: pr, repository }, D);
  assert.strictEqual(r.subject, "github.stella-rain.app.pr.341.pull_request_review");
  assert.strictEqual(r.event.conclusion, "changes_requested");
});

test("a push counts only on the default branch", () => {
  assert.deepStrictEqual(normalize("push", { ref: "refs/heads/main", after: "def", repository }, D), {
    subject: "github.stella-rain.app.push.main",
    event: { ...blank, branch: "main", event: "push", sha: "def" },
  });
  assert.strictEqual(normalize("push", { ref: "refs/heads/claude/x", after: "def", repository }, D), null);
  assert.strictEqual(normalize("push", { ref: "refs/tags/v1", after: "def", repository }, D), null);
});

test("subject tokens never hold a dot, a wildcard or a space", () => {
  assert.strictEqual(token(".github"), "_github");
  assert.strictEqual(token("claude/a.b *>c"), "claude/a_b___c");
  const r = normalize("push", { ref: "refs/heads/main", after: "d", repository: { full_name: "kade-agent/.github", default_branch: "main" } }, D);
  assert.strictEqual(r.subject, "github.kade-agent._github.push.main");
});

test("other events and payloads without a repository are dropped", () => {
  assert.strictEqual(normalize("issues", { action: "opened", repository }, D), null);
  assert.strictEqual(normalize("ping", { zen: "z" }, D), null);
  assert.strictEqual(normalize("pull_request", { action: "closed", pull_request: pr }, D), null);
  assert.strictEqual(normalize("hasOwnProperty", { repository }, D), null);
});

test("a push to the default branch or a PR synchronize starts a mergeability check", () => {
  assert.deepStrictEqual(mergeTrigger("push", { ref: "refs/heads/main", repository }), { repo: "stella-rain/app", base: "main" });
  assert.deepStrictEqual(mergeTrigger("pull_request", { action: "synchronize", pull_request: pr, repository }), { repo: "stella-rain/app", pr: 341 });
  assert.deepStrictEqual(mergeTrigger("pull_request", { action: "opened", pull_request: pr, repository }), { repo: "stella-rain/app", pr: 341 });
  assert.strictEqual(mergeTrigger("push", { ref: "refs/heads/claude/x", repository }), null);
  assert.strictEqual(mergeTrigger("pull_request", { action: "closed", pull_request: pr, repository }), null);
  assert.strictEqual(mergeTrigger("check_run", { action: "completed", repository }), null);
});
