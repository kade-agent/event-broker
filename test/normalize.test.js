"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { normalize } = require("../src/normalize");

const repository = { full_name: "stella-rain/app", default_branch: "main" };
const pr = { number: 341, merged: true, head: { ref: "claude/z3-orbs", sha: "9f2c1e0" } };

test("a merged PR becomes one closed event with merged true", () => {
  assert.deepStrictEqual(normalize("pull_request", { action: "closed", pull_request: pr, repository }), {
    repo: "stella-rain/app", pr: 341, branch: "claude/z3-orbs", event: "pull_request",
    action: "closed", merged: true, conclusion: null, sha: "9f2c1e0",
  });
});

test("a PR closed unmerged has merged false; opened or synchronize is dropped", () => {
  const closed = normalize("pull_request", { action: "closed", pull_request: { ...pr, merged: false }, repository });
  assert.strictEqual(closed.merged, false);
  assert.strictEqual(normalize("pull_request", { action: "synchronize", pull_request: pr, repository }), null);
  assert.strictEqual(normalize("pull_request", { action: "opened", pull_request: pr, repository }), null);
});

test("a completed check suite carries its conclusion and first PR", () => {
  const check_suite = { conclusion: "failure", head_branch: "claude/z3-orbs", head_sha: "9f2c1e0", pull_requests: [{ number: 341 }] };
  assert.deepStrictEqual(normalize("check_suite", { action: "completed", check_suite, repository }), {
    repo: "stella-rain/app", pr: 341, branch: "claude/z3-orbs", event: "check_suite",
    action: "completed", merged: null, conclusion: "failure", sha: "9f2c1e0",
  });
  assert.strictEqual(normalize("check_suite", { action: "requested", check_suite, repository }), null);
});

test("a completed check run carries its conclusion; no PR gives pr null", () => {
  const check_run = { conclusion: "success", head_sha: "abc", pull_requests: [], check_suite: { head_branch: "claude/x" } };
  const e = normalize("check_run", { action: "completed", check_run, repository });
  assert.strictEqual(e.pr, null);
  assert.strictEqual(e.branch, "claude/x");
  assert.strictEqual(e.conclusion, "success");
  assert.strictEqual(normalize("check_run", { action: "created", check_run, repository }), null);
});

test("a submitted review carries the review state as its conclusion", () => {
  const e = normalize("pull_request_review", { action: "submitted", review: { state: "changes_requested" }, pull_request: pr, repository });
  assert.strictEqual(e.event, "pull_request_review");
  assert.strictEqual(e.conclusion, "changes_requested");
  assert.strictEqual(e.pr, 341);
  assert.strictEqual(e.merged, null);
});

test("a push counts only on the default branch", () => {
  assert.deepStrictEqual(normalize("push", { ref: "refs/heads/main", after: "def", repository }), {
    repo: "stella-rain/app", pr: null, branch: "main", event: "push",
    action: null, merged: null, conclusion: null, sha: "def",
  });
  assert.strictEqual(normalize("push", { ref: "refs/heads/claude/x", after: "def", repository }), null);
  assert.strictEqual(normalize("push", { ref: "refs/tags/v1", after: "def", repository }), null);
});

test("other events and payloads without a repository are dropped", () => {
  assert.strictEqual(normalize("issues", { action: "opened", repository }), null);
  assert.strictEqual(normalize("ping", { zen: "z" }), null);
  assert.strictEqual(normalize("pull_request", { action: "closed", pull_request: pr }), null);
});
