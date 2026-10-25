"use strict";
// One signal per kept event, and its v2 subject and message (agent-config
// docs/event-broker-design.md, section 9). Nothing publishes v2 yet.
const { token } = require("./normalize");
const { stateKey, createStateStore } = require("./stream");

const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const MERGE_STATES = ["behind", "dirty", "clean", "blocked", "unstable", "draft"];
const REVIEW_STATES = { changes_requested: "review_changes", commented: "review_comment",
  approved: "review_approved", dismissed: "review_dismissed" };

const SIGNALS = Object.freeze([
  "pr_merged", "pr_closed", "pr_ready", "pr_draft", "automerge_on", "automerge_off",
  ...MERGE_STATES.map((s) => `merge_${s}`), "merge_other",
  "ci_failed", "ci_passed", "ci_other",
  "main_failed", "main_passed", "main_still_passed", "main_other",
  "branch_failed", "branch_passed", "branch_other",
  "check_failed", "check_passed", "check_other",
  "review_changes", "review_comment", "review_approved", "review_dismissed", "review_other",
  "issue_closed", "issue_reopened", "issue_labeled",
  "pr_comment", "issue_comment",
  "push_main", "push_branch",
]);

const outcome = (conclusion) => (FAILED.has(conclusion) ? "failed" : conclusion === "success" ? "passed" : "other");

function signalOf(e, defaultBranch) {
  switch (e.event) {
    case "pull_request":
      if (e.action === "closed") return e.merged ? "pr_merged" : "pr_closed";
      return { ready_for_review: "pr_ready", converted_to_draft: "pr_draft",
        auto_merge_enabled: "automerge_on", auto_merge_disabled: "automerge_off" }[e.action];
    case "mergeable":
      return MERGE_STATES.includes(e.mergeable_state) ? `merge_${e.mergeable_state}` : "merge_other";
    case "workflow_run": {
      const kind = e.pr != null ? "ci" : e.branch === defaultBranch ? "main" : "branch";
      return `${kind}_${outcome(e.conclusion)}`;
    }
    case "check_run":
    case "check_suite":
      return `check_${outcome(e.conclusion)}`;
    case "pull_request_review":
      return REVIEW_STATES[String(e.conclusion).toLowerCase()] ?? "review_other";
    case "issues":
      return `issue_${e.action}`;
    case "issue_comment":
      return e.pr != null ? "pr_comment" : "issue_comment";
    case "push":
      return e.branch === defaultBranch ? "push_main" : "push_branch";
    default:
      return undefined;
  }
}

function v2Of(e, defaultBranch) {
  const signal = signalOf(e, defaultBranch);
  const [owner, name] = e.repo.split("/");
  const scope = e.pr != null ? ["pr", e.pr] : e.issue != null ? ["issue", e.issue] : ["branch", token(e.branch)];
  return {
    subject: ["ev", token(owner.toLowerCase()), token(name), ...scope, signal].join("."),
    event: { ...e, v: 2, signal },
  };
}

// Decision 16: a pass on main is main_passed only when that workflow (repository and name) last
// failed there, or has no state; otherwise main_still_passed. await apply(v2) -> { v2, commit }: the
// caller awaits commit() after both publishes succeed, so a delivery answered 503 gets the same
// signal when it is redelivered. Decision 19: the state is the store's key
// state.<owner>.<repo>.main.<workflow> ({passed}), kept in STATE, so a restart repeats nothing.
function createMainRuns({ store = createStateStore() } = {}) {
  return {
    async apply(v2) {
      const { signal } = v2.event;
      if (signal !== "main_passed" && signal !== "main_failed") return { v2, commit: async () => {} };
      const key = stateKey(v2.event.repo, "main", (v2.event.check && v2.event.check.name) || "_");
      const commit = () => store.put(key, { passed: signal === "main_passed" });
      if (signal === "main_failed") return { v2, commit };
      const last = await store.get(key);
      if (!last || last.passed !== true) return { v2, commit };
      const still = "main_still_passed";
      return { v2: { subject: v2.subject.replace(/\.main_passed$/, `.${still}`), event: { ...v2.event, signal: still } }, commit };
    },
  };
}

module.exports = { signalOf, v2Of, SIGNALS, createMainRuns };
