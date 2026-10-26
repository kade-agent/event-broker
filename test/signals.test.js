"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { signalOf, v2Of, SIGNALS, createMainRuns } = require("../src/signals");
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
  [{ event: "issue_comment", action: "created", pr: 7, comment: { id: 1, author: "a", url: "u", line: null } }, "pr_comment"],
  // Decision 24: a PR comment whose first line is a strict DONE or BLOCKED line is pr_report.
  [{ event: "issue_comment", action: "created", pr: 7, comment: { id: 1, author: "a", url: "u", line: "DONE T1 a/b#7: ok" } }, "pr_report"],
  [{ event: "issue_comment", action: "created", issue: 4 }, "issue_comment"],
  [{ event: "push", branch: "main" }, "push_main"],
  [{ event: "push", branch: "claude/x" }, "push_branch"],
];

test("every row of the design's signal table gets its signal", () => {
  for (const [fields, signal] of ROWS) {
    assert.strictEqual(signalOf(ev(fields), "main"), signal, JSON.stringify(fields));
  }
});

test("the table and createMainRuns cover every signal", () => {
  // main_still_passed comes only from createMainRuns (design section 9, decision 16).
  assert.deepStrictEqual(new Set([...ROWS.map(([, s]) => s), "main_still_passed"]), new Set(SIGNALS));
});

test("SIGNALS is the frozen list of 39 unique [a-z_] names", () => {
  assert.strictEqual(SIGNALS.length, 39);
  assert.strictEqual(new Set(SIGNALS).size, 39);
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

test("every delivery normalize keeps gets a signal from SIGNALS", () => {
  const { normalize } = require("../src/normalize");
  const repository = { full_name: "o/r", default_branch: "main" };
  const pr = { number: 1, merged: false, draft: false, auto_merge: null, head: { ref: "b", sha: "s" } };
  const issue = { number: 2, state_reason: null };
  const kept = [
    ...["closed", "ready_for_review", "converted_to_draft", "auto_merge_enabled", "auto_merge_disabled"]
      .map((action) => ["pull_request", { action, pull_request: pr }]),
    ...["closed", "reopened"].map((action) => ["issues", { action, issue }]),
    ["issues", { action: "labeled", issue, label: { name: "x" } }],
    ["check_run", { action: "completed", check_run: { name: "t", conclusion: "success", pull_requests: [] } }],
    ["check_suite", { action: "completed", check_suite: { conclusion: "success", head_branch: "b", pull_requests: [] } }],
    ["workflow_run", { action: "completed", workflow_run: { name: "w", conclusion: "success", head_branch: "b", pull_requests: [] } }],
    ["pull_request_review", { action: "submitted", pull_request: pr, review: { state: "approved" } }],
    ["issue_comment", { action: "created", issue, comment: { id: 1, user: null, html_url: "u" } }],
    ["push", { ref: "refs/heads/main", after: "a" }],
  ];
  for (const [name, payload] of kept) {
    const r = normalize(name, { ...payload, repository }, "d");
    assert.ok(SIGNALS.includes(r.v2.event.signal), `${name} ${payload.action}`);
  }
});

// Decision 16: main_passed only when a workflow on main turns green; decision 19 keeps the state in
// a store (STATE), so a restarted receiver remembers it.
const { createStateStore } = require("../src/stream");
const mainRun = (conclusion, name = "Rust", repo = "stella-rain/core") =>
  v2Of({ ...blank("d1", repo), event: "workflow_run", action: "completed", branch: "main", conclusion,
    check: { name, url: null } }, "main");
const signalsOf = async (runs, list) => {
  const out = [];
  for (const v2 of list) { const r = await runs.apply(v2); await r.commit(); out.push(r.v2.event.signal); }
  return out;
};

test("a workflow's first pass on main is main_passed, the next ones main_still_passed", async () => {
  const runs = createMainRuns();
  assert.deepStrictEqual(await signalsOf(runs, [mainRun("success"), mainRun("success"), mainRun("success")]),
    ["main_passed", "main_still_passed", "main_still_passed"]);
  const r = await runs.apply(mainRun("success"));
  assert.strictEqual(r.v2.subject, "ev.stella-rain.core.branch.main.main_still_passed");
});

test("a pass after a failure of the same workflow is main_passed again; main_other changes nothing", async () => {
  const runs = createMainRuns();
  assert.deepStrictEqual(await signalsOf(runs, [mainRun("success"), mainRun("failure"), mainRun("cancelled"),
    mainRun("success"), mainRun("cancelled"), mainRun("success")]),
  ["main_passed", "main_failed", "main_other", "main_passed", "main_other", "main_still_passed"]);
});

test("each workflow of each repository has its own state", async () => {
  const runs = createMainRuns();
  assert.deepStrictEqual(await signalsOf(runs, [mainRun("failure", "Rust"), mainRun("success", "Auto-merge"),
    mainRun("success", "Auto-merge"), mainRun("success", "Rust", "stella-rain/app"), mainRun("success", "Rust")]),
  ["main_failed", "main_passed", "main_still_passed", "main_passed", "main_passed"]);
});

test("without commit the state does not move, so a retried delivery gets the same signal", async () => {
  const runs = createMainRuns();
  assert.strictEqual((await runs.apply(mainRun("success"))).v2.event.signal, "main_passed");
  assert.strictEqual((await runs.apply(mainRun("success"))).v2.event.signal, "main_passed");
});

test("any other signal passes through unchanged", async () => {
  const runs = createMainRuns();
  const v2 = v2Of(ev({ event: "workflow_run", conclusion: "success", pr: 3, branch: "claude/x" }), "main");
  const r = await runs.apply(v2);
  await r.commit();
  assert.strictEqual(r.v2, v2);
  assert.strictEqual((await runs.apply(mainRun("success"))).v2.event.signal, "main_passed");
});

test("decision 19: the state is the store's key state.<owner>.<repo>.main.<workflow>, so a restart repeats nothing", async () => {
  const values = {};
  const backend = { read: async (k) => values[k] ?? null, write: async (k, v) => { values[k] = v; }, log: () => {} };
  const runs = createMainRuns({ store: createStateStore(backend) });
  assert.deepStrictEqual(await signalsOf(runs, [mainRun("success", "Rust check")]), ["main_passed"]);
  assert.deepStrictEqual(values, { "state.stella-rain.core.main.Rust_check": { passed: true },
    "state.stella-rain.core.red": { red: [] } }); // the red list since decision 20
  const restarted = createMainRuns({ store: createStateStore(backend) });
  assert.deepStrictEqual(await signalsOf(restarted, [mainRun("success", "Rust check")]), ["main_still_passed"]);
});

// Decision 20 (S2): main events carry red, the workflows failing on that repository's main.
const apply1 = async (runs, v2) => { const r = await runs.apply(v2); await r.commit(); return r.v2; };

test("red: the list as it stands once the event counts, sorted, on main_failed, main_passed and main_still_passed", async () => {
  const runs = createMainRuns();
  const seen = [];
  for (const [c, w] of [["failure", "Rust"], ["failure", "Lint"], ["success", "Rust"], ["success", "Lint"], ["success", "Lint"]]) {
    const v2 = await apply1(runs, mainRun(c, w));
    seen.push([v2.event.signal, v2.event.red]);
  }
  assert.deepStrictEqual(seen, [
    ["main_failed", ["Rust"]], ["main_failed", ["Lint", "Rust"]], ["main_passed", ["Lint"]],
    ["main_passed", []], ["main_still_passed", []],
  ]);
});

test("red: kept per repository in state.<owner>.<repo>.red; a restarted receiver carries it on", async () => {
  const values = {};
  const backend = { read: async (k) => values[k] ?? null, write: async (k, v) => { values[k] = v; }, log: () => {} };
  await apply1(createMainRuns({ store: createStateStore(backend) }), mainRun("failure", "Rust check"));
  await apply1(createMainRuns({ store: createStateStore(backend) }), mainRun("failure", "Rust", "stella-rain/app"));
  assert.deepStrictEqual(values["state.stella-rain.core.red"], { red: ["Rust check"] });
  assert.deepStrictEqual(values["state.stella-rain.app.red"], { red: ["Rust"] });
  const v2 = await apply1(createMainRuns({ store: createStateStore(backend) }), mainRun("failure", "Lint"));
  assert.deepStrictEqual(v2.event.red, ["Lint", "Rust check"]);
});

test("red: without commit the stored list does not move", async () => {
  const runs = createMainRuns();
  assert.deepStrictEqual((await runs.apply(mainRun("failure", "Rust"))).v2.event.red, ["Rust"]);
  assert.deepStrictEqual((await runs.apply(mainRun("failure", "Lint"))).v2.event.red, ["Lint"]);
});

test("red: two runs that finish together both end up in the stored list", async () => {
  const store = createStateStore();
  const runs = createMainRuns({ store });
  const [a, b] = await Promise.all([runs.apply(mainRun("failure", "Rust")), runs.apply(mainRun("failure", "Lint"))]);
  await Promise.all([a.commit(), b.commit()]);
  assert.deepStrictEqual(await store.get("state.stella-rain.core.red"), { red: ["Lint", "Rust"] });
});

test("red: other signals, main_other included, carry no red", async () => {
  const runs = createMainRuns();
  assert.strictEqual((await apply1(runs, mainRun("cancelled"))).event.red, undefined);
  const pr = v2Of(ev({ event: "workflow_run", conclusion: "failure", pr: 3, branch: "claude/x" }), "main");
  assert.strictEqual((await apply1(runs, pr)).event.red, undefined);
});
