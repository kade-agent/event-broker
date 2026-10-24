"use strict";
// One GitHub delivery -> the one JSON line the dispatcher reads (agent-config,
// agent-skills/dispatcher/references/pr-watch.md), or null when the dispatcher has no use for it.
// Webhooks carry no reliable mergeable state: a push to the default branch stands in for it,
// and the dispatcher sweeps the open PRs with gh.

function line(repository, fields) {
  return {
    repo: repository.full_name,
    pr: null, branch: null, event: null, action: null, merged: null, conclusion: null, sha: null,
    ...fields,
  };
}

const firstPr = (prs) => (Array.isArray(prs) && prs.length > 0 ? prs[0].number : null);

const HANDLERS = {
  pull_request(p) {
    if (p.action !== "closed") return null;
    const pr = p.pull_request;
    return { pr: pr.number, branch: pr.head.ref, action: p.action, merged: pr.merged === true, sha: pr.head.sha };
  },
  check_suite(p) {
    if (p.action !== "completed") return null;
    const s = p.check_suite;
    return { pr: firstPr(s.pull_requests), branch: s.head_branch, action: p.action, conclusion: s.conclusion, sha: s.head_sha };
  },
  check_run(p) {
    if (p.action !== "completed") return null;
    const r = p.check_run;
    return {
      pr: firstPr(r.pull_requests), branch: r.check_suite ? r.check_suite.head_branch : null,
      action: p.action, conclusion: r.conclusion, sha: r.head_sha,
    };
  },
  pull_request_review(p) {
    if (p.action !== "submitted") return null;
    const pr = p.pull_request;
    return { pr: pr.number, branch: pr.head.ref, action: p.action, conclusion: p.review.state, sha: pr.head.sha };
  },
  push(p) {
    const branch = p.repository.default_branch;
    if (p.ref !== `refs/heads/${branch}`) return null;
    return { branch, sha: p.after };
  },
};

function normalize(event, payload) {
  const handler = Object.hasOwn(HANDLERS, event) ? HANDLERS[event] : null;
  if (!handler || !payload || !payload.repository) return null;
  const fields = handler(payload);
  return fields ? line(payload.repository, { ...fields, event }) : null;
}

module.exports = { normalize };
