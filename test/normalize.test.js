"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { normalize, mergeTrigger, token } = require("../src/normalize");

const repository = { full_name: "stella-rain/app", default_branch: "main" };
const pr = { number: 341, merged: true, draft: false, auto_merge: { merge_method: "squash" }, head: { ref: "claude/z3-orbs", sha: "9f2c1e0" } };
const D = "1f2e-guid";
const v1 = ({ subject, event }) => ({ subject, event });

const blank = {
  delivery: D, repo: "stella-rain/app", pr: null, branch: null, event: null, action: null, merged: null,
  draft: null, auto_merge: null, conclusion: null, check: null, mergeable_state: null, sha: null,
  issue: null, label: null, state_reason: null, comment: null,
};

test("a merged PR becomes one event on its PR subject", () => {
  assert.deepStrictEqual(v1(normalize("pull_request", { action: "closed", pull_request: pr, repository }, D)), {
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

test("a push counts on the default branch and on task branches (decision 18)", () => {
  assert.deepStrictEqual(v1(normalize("push", { ref: "refs/heads/main", after: "def", repository }, D)), {
    subject: "github.stella-rain.app.push.main",
    event: { ...blank, branch: "main", event: "push", sha: "def" },
  });
  assert.strictEqual(normalize("push", { ref: "refs/heads/feature/x", after: "def", repository }, D), null);
  assert.strictEqual(normalize("push", { ref: "refs/heads/dependabot/npm/x", after: "def", repository }, D), null);
  assert.strictEqual(normalize("push", { ref: "refs/tags/v1", after: "def", repository }, D), null);
});

test("a push to a task branch is v2 only: no v1 subject, push_branch with the pushed head", () => {
  for (const branch of ["claude/z3-orbs", "agent/x"]) {
    const r = normalize("push", { ref: `refs/heads/${branch}`, after: "abc1234", repository }, D);
    assert.strictEqual(r.subject, null);
    assert.strictEqual(r.v2.subject, `ev.stella-rain.app.branch.${branch}.push_branch`);
    assert.deepStrictEqual(r.v2.event, { ...blank, branch, event: "push", sha: "abc1234", v: 2, signal: "push_branch" });
  }
});

test("a task branch deletion (after a merge) is dropped", () => {
  assert.strictEqual(normalize("push", { ref: "refs/heads/claude/x", after: "0".repeat(40), deleted: true, repository }, D), null);
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

const tasks = { full_name: "kade-agent/tasks", default_branch: "main" };
const issue = (extra = {}) => ({ number: 4, title: "SECRET TITLE", body: "SECRET BODY", ...extra });

test("a labeled issue is kept with its label name", () => {
  const r = normalize("issues", { action: "labeled", issue: issue(), label: { name: "status:running" }, repository: tasks }, D);
  assert.deepStrictEqual(v1(r), {
    subject: "github.kade-agent.tasks.issue.4.issues",
    event: { ...blank, repo: "kade-agent/tasks", issue: 4, event: "issues", action: "labeled", label: "status:running" },
  });
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});

test("a closed or reopened issue carries its state reason", () => {
  const c = normalize("issues", { action: "closed", issue: issue({ state_reason: "completed" }), repository: tasks }, D);
  assert.strictEqual(c.event.state_reason, "completed");
  assert.strictEqual(c.event.label, null);
  const r = normalize("issues", { action: "reopened", issue: issue({ state_reason: "reopened" }), repository: tasks }, D);
  assert.strictEqual(r.event.action, "reopened");
  assert.strictEqual(r.event.state_reason, "reopened");
  assert.strictEqual(normalize("issues", { action: "closed", issue: issue(), repository: tasks }, D).event.state_reason, null);
});

test("other issue actions are not published", () => {
  for (const action of ["opened", "edited", "unlabeled", "assigned"]) {
    assert.strictEqual(normalize("issues", { action, issue: issue(), label: { name: "x" }, repository: tasks }, D), null);
  }
});

test("a created issue comment carries id, author, URL and only a strict DONE/BLOCKED first line, never the rest", () => {
  const url = "https://github.com/kade-agent/tasks/issues/4#issuecomment-9";
  // Decision 23: the first line rides along only when it is a strict DONE or BLOCKED line.
  const comment = { id: 9, user: { login: "enjay27" }, html_url: url, body: "  DONE EB6 kade-agent/x#3: 2 files  \r\nSECRET second line" };
  const r = normalize("issue_comment", { action: "created", issue: issue(), comment, repository: tasks }, D);
  assert.strictEqual(r.subject, "github.kade-agent.tasks.issue.4.issue_comment");
  assert.deepStrictEqual(r.event.comment, { id: 9, author: "enjay27", url, line: "DONE EB6 kade-agent/x#3: 2 files" });
  assert.strictEqual(r.event.pr, null);
  assert.strictEqual(r.event.issue, 4);
  assert.ok(!JSON.stringify(r.event).includes("SECRET"));
  for (const body of ["looks DONE EB6 to me", "DONE", "done EB6", "", null, "BLOCKEDX EB6"]) {
    const o = normalize("issue_comment", { action: "created", issue: issue(), comment: { ...comment, body }, repository: tasks }, D);
    assert.strictEqual(o.event.comment.line, null, String(body));
  }
  const blocked = normalize("issue_comment", { action: "created", issue: issue(), comment: { ...comment, body: `BLOCKED EB6: ${"x".repeat(400)}` }, repository: tasks }, D);
  assert.strictEqual(blocked.event.comment.line.length, 300);
  assert.ok(blocked.event.comment.line.startsWith("BLOCKED EB6: x"));
  const gone = normalize("issue_comment", { action: "created", issue: issue(), comment: { ...comment, user: null }, repository: tasks }, D);
  assert.strictEqual(gone.event.comment.author, null);
});

test("a comment on a PR goes on the PR subject", () => {
  const comment = { id: 1, user: { login: "a" }, html_url: "u", body: "b" };
  const r = normalize("issue_comment", { action: "created", issue: issue({ number: 341, pull_request: {} }), comment, repository }, D);
  assert.strictEqual(r.subject, "github.stella-rain.app.pr.341.issue_comment");
  assert.strictEqual(r.event.pr, 341);
  assert.strictEqual(r.event.issue, null);
});

test("edited and deleted issue comments are not published", () => {
  const comment = { id: 1, user: { login: "a" }, html_url: "u", body: "b" };
  for (const action of ["edited", "deleted"]) {
    assert.strictEqual(normalize("issue_comment", { action, issue: issue(), comment, repository: tasks }, D), null);
  }
});

test("a dotted repository name is tokenised in issue subjects", () => {
  const r = normalize("issues", { action: "labeled", issue: issue(), label: { name: "x" }, repository: { full_name: "kade-agent/.github" } }, D);
  assert.ok(r.subject.startsWith("github.kade-agent._github.issue."));
});

test("the owner is lower-cased in the subject; the repo name and the event's repo keep GitHub's case", () => {
  const caps = { full_name: "Stella-Rain/App", default_branch: "main" };
  const r = normalize("pull_request", { action: "closed", pull_request: pr, repository: caps }, D);
  assert.strictEqual(r.subject, "github.stella-rain.App.pr.341.pull_request");
  assert.strictEqual(r.event.repo, "Stella-Rain/App");
  const i = normalize("issues", { action: "labeled", issue: { number: 4 }, label: { name: "x" },
    repository: { full_name: "Kade-Agent/tasks", default_branch: "main" } }, D);
  assert.ok(i.subject.startsWith("github.kade-agent.tasks.issue."), i.subject);
});

test("normalize returns the v2 subject and message next to v1, which is unchanged", () => {
  const r = normalize("pull_request", { action: "closed", pull_request: pr, repository }, D);
  assert.strictEqual(r.subject, "github.stella-rain.app.pr.341.pull_request");
  assert.deepStrictEqual(r.event, { ...blank, pr: 341, branch: "claude/z3-orbs", event: "pull_request", action: "closed",
    merged: true, draft: false, auto_merge: true, sha: "9f2c1e0" });
  assert.deepStrictEqual(r.v2, { subject: "ev.stella-rain.app.pr.341.pr_merged", event: { ...r.event, v: 2, signal: "pr_merged" } });
  const push = normalize("push", { ref: "refs/heads/main", after: "abc", repository }, D);
  assert.strictEqual(push.v2.subject, "ev.stella-rain.app.branch.main.push_main");
  const run = { name: "ci", conclusion: "failure", head_branch: "trunk", head_sha: "a", pull_requests: [] };
  const other = normalize("workflow_run", { action: "completed", workflow_run: run, repository: { ...repository, default_branch: "trunk" } }, D);
  assert.strictEqual(other.v2.event.signal, "main_failed");
});
