"use strict";
// One GitHub delivery -> {subject, event, v2} for JetStream (agent-config docs/event-broker-design.md,
// section 4), or null when the dispatcher has no use for it. mergeTrigger says whether the
// delivery should start a mergeability check (section 5): webhooks carry no reliable
// mergeable_state, so the receiver asks GitHub after a push to a base branch or a PR update.

// A NATS subject token may not hold ".", "*", ">" or whitespace.
const token = (s) => String(s).replace(/[.*>\s]/g, "_");

// Only the owner is lower-cased: it picks the NATS account and its stream; repo names stay as sent.
const prefix = (fullName) => {
  const [owner, name] = fullName.split("/");
  return `github.${token(owner.toLowerCase())}.${token(name)}`;
};

const blank = (delivery, repo) => ({
  delivery, repo, pr: null, branch: null, event: null, action: null, merged: null,
  draft: null, auto_merge: null, conclusion: null, check: null, mergeable_state: null, sha: null,
  issue: null, label: null, state_reason: null, comment: null,
});

const firstPr = (prs) => (Array.isArray(prs) && prs.length > 0 ? prs[0].number : null);

const prFields = (pr) => ({
  pr: pr.number, branch: pr.head.ref, sha: pr.head.sha, draft: pr.draft === true, auto_merge: pr.auto_merge != null,
});

// Agents' branches (global rules: claude/<task>, agent/<task>): their pushes are a task's progress.
const TASK_BRANCH = /^(claude|agent)\//;

// Decisions 23 and 30: the one piece of comment text the stream carries, a strict BLOCKED first line
// (a merge is the DONE, so a DONE comment is not carried).
const STRICT_LINE = /^BLOCKED \S+/;
const strictLine = (body) => {
  const first = String(body ?? "").split(/\r?\n/, 1)[0].trim();
  return STRICT_LINE.test(first) ? first.slice(0, 300) : null;
};

const PR_ACTIONS = new Set(["closed", "ready_for_review", "converted_to_draft", "auto_merge_enabled", "auto_merge_disabled"]);

const HANDLERS = {
  pull_request(p) {
    if (!PR_ACTIONS.has(p.action)) return null;
    return { ...prFields(p.pull_request), action: p.action, merged: p.pull_request.merged === true };
  },
  check_suite(p) {
    if (p.action !== "completed") return null;
    const s = p.check_suite;
    return { pr: firstPr(s.pull_requests), branch: s.head_branch, sha: s.head_sha, action: p.action,
      conclusion: s.conclusion, check: { name: s.app ? s.app.name : null, url: null } };
  },
  check_run(p) {
    if (p.action !== "completed") return null;
    const r = p.check_run;
    return { pr: firstPr(r.pull_requests), branch: r.check_suite ? r.check_suite.head_branch : null, sha: r.head_sha,
      action: p.action, conclusion: r.conclusion, check: { name: r.name, url: r.html_url || r.details_url || null } };
  },
  workflow_run(p) {
    if (p.action !== "completed") return null;
    const w = p.workflow_run;
    return { pr: firstPr(w.pull_requests), branch: w.head_branch, sha: w.head_sha, action: p.action,
      conclusion: w.conclusion, check: { name: w.name, url: w.html_url || null } };
  },
  pull_request_review(p) {
    if (p.action !== "submitted") return null;
    return { ...prFields(p.pull_request), action: p.action, conclusion: p.review.state };
  },
  issues(p) {
    if (p.action === "closed" || p.action === "reopened") {
      return { issue: p.issue.number, action: p.action, state_reason: p.issue.state_reason ?? null };
    }
    if (p.action === "labeled") return { issue: p.issue.number, action: p.action, label: p.label.name };
    return null;
  },
  issue_comment(p) {
    if (p.action !== "created") return null;
    const c = p.comment;
    const number = p.issue.number;
    const ids = p.issue.pull_request ? { pr: number } : { issue: number };
    return { ...ids, action: p.action, comment: { id: c.id, author: c.user ? c.user.login : null, url: c.html_url, line: strictLine(c.body) } };
  },
  push(p) {
    if (typeof p.ref !== "string" || !p.ref.startsWith("refs/heads/")) return null;
    const branch = p.ref.slice("refs/heads/".length);
    if (branch !== p.repository.default_branch && (!TASK_BRANCH.test(branch) || p.deleted)) return null;
    return { branch, sha: p.after };
  },
};

function subjectOf(e) {
  const base = prefix(e.repo);
  if (e.event === "push") return `${base}.push.${token(e.branch)}`;
  if (e.pr != null) return `${base}.pr.${e.pr}.${e.event}`;
  if (e.issue != null) return `${base}.issue.${e.issue}.${e.event}`;
  return `${base}.branch.${token(e.branch)}.${e.event}`;
}

function normalize(event, payload, delivery) {
  const handler = Object.hasOwn(HANDLERS, event) ? HANDLERS[event] : null;
  if (!handler || !payload || !payload.repository) return null;
  const fields = handler(payload);
  if (!fields) return null;
  const e = { ...blank(delivery, payload.repository.full_name), ...fields, event };
  // signals.js needs token() from here, so it is loaded on first use.
  const { v2Of } = require("./signals");
  // A task branch push is v2 only (design decision 18): v1 has no subject for it.
  const v1Subject = e.event === "push" && e.branch !== payload.repository.default_branch ? null : subjectOf(e);
  return { subject: v1Subject, event: e, v2: v2Of(e, payload.repository.default_branch) };
}

function mergeTrigger(event, payload) {
  if (!payload || !payload.repository) return null;
  const repo = payload.repository.full_name;
  if (event === "push" && payload.ref === `refs/heads/${payload.repository.default_branch}`) {
    return { repo, base: payload.repository.default_branch };
  }
  if (event === "pull_request" && ["opened", "reopened", "synchronize"].includes(payload.action)) {
    return { repo, pr: payload.pull_request.number };
  }
  return null;
}

module.exports = { normalize, mergeTrigger, token, prefix, blank, prFields };
