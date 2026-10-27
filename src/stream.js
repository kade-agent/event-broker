"use strict";
// Streams GITHUB (v1) and EVENTS (v2) with their durable consumers, STATE (decision 19) and LEASE (decision 33), in one
// owner's account (design sections 6 and 9),
// created or updated when the receiver starts. Every account has the same names; the owner is in
// the subjects.
const { AckPolicy, DeliverPolicy, DiscardPolicy, StorageType } = require("@nats-io/jetstream");
const { token } = require("./normalize");
const { PROFILES } = require("./profiles");

const SECOND = 1e9; // JetStream durations are nanoseconds

const streamFor = (owner) => ({
  name: "GITHUB",
  subjects: [`github.${owner}.>`],
  storage: StorageType.File,
  max_age: 7 * 24 * 3600 * SECOND,
  max_bytes: 128 * 1024 * 1024,
  discard: DiscardPolicy.Old,
  duplicate_window: 120 * SECOND,
});

// The five PR events, the org's issue events, workflow runs on branches, and pushes.
const filtersFor = (owner) => [
  ...["pull_request", "workflow_run", "mergeable", "pull_request_review", "issue_comment"].map((e) => `github.${owner}.*.pr.*.${e}`),
  `github.${owner}.*.issue.>`,
  `github.${owner}.*.branch.*.workflow_run`,
  `github.${owner}.*.push.*`,
];

const consumerFor = (owner) => ({
  durable_name: "dispatcher",
  filter_subjects: filtersFor(owner),
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.New,
  ack_wait: 60 * SECOND,
  max_ack_pending: 1000,
});

const eventsStreamFor = (owner) => ({
  name: "EVENTS",
  subjects: [`ev.${owner}.>`],
  storage: StorageType.File,
  max_age: 7 * 24 * 3600 * SECOND,
  max_bytes: 24 * 1024 * 1024,
  discard: DiscardPolicy.Old,
  duplicate_window: 120 * SECOND,
});

// One filter per signal: ev.<owner>.<repo>.<scope>.<id>.<signal>; "all" reads the whole stream.
const profileConsumerFor = (owner, name) => {
  const signals = PROFILES[name];
  return {
    durable_name: name,
    ...(signals
      ? { filter_subjects: signals.map((s) => `ev.${owner}.*.*.*.${s}`) }
      : { filter_subject: `ev.${owner}.>` }),
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    ack_wait: 60 * SECOND,
    max_ack_pending: 1000,
  };
};

// Decision 19 (S1): the receiver's state, one message per subject, keyed by stateKey().
const stateStreamFor = (owner) => ({
  name: "STATE",
  subjects: [`state.${owner}.>`],
  storage: StorageType.File,
  max_msgs_per_subject: 1,
  max_age: 30 * 24 * 3600 * SECOND,
  max_bytes: 4 * 1024 * 1024,
  discard: DiscardPolicy.Old,
});

// Decision 33: one reader per org. lease.<owner>.<profile> holds the watching session's id; the client
// writes it by expected subject sequence, so two arms cannot both win, and 35 min (the 30-minute watch
// deadline and a margin) ends a lease nobody renewed.
const leaseStreamFor = (owner) => ({
  name: "LEASE",
  subjects: [`lease.${owner}.>`],
  storage: StorageType.File,
  max_msgs_per_subject: 1,
  max_age: 35 * 60 * SECOND,
  max_bytes: 1024 * 1024,
  discard: DiscardPolicy.Old,
});

// state.<owner>.<repo>.<topic...>: the owner lower-cased (it picks the account), every part token-safe.
const stateKey = (repo, ...topic) => {
  const [owner, name] = String(repo).split("/");
  return ["state", token(owner.toLowerCase()), token(name), ...topic.map((t) => token(t))].join(".");
};

// get(key) -> value | null and put(key, value) over read/write of the STATE stream, with memory in
// front. A failed read is null (unknown: at worst one repeated event) and a failed write keeps the
// value in memory; both are logged. With no read/write it is memory only (tests, and the default).
function createStateStore({ read = async () => null, write = async () => {}, log = console.error } = {}) {
  const mem = new Map();
  return {
    async get(key) {
      if (mem.has(key)) return mem.get(key);
      let value = null;
      try { value = await read(key); } catch (e) { log(`state read ${key}: ${e.message}`); return null; }
      if (value != null) mem.set(key, value);
      return value ?? null;
    },
    async put(key, value) {
      mem.set(key, value);
      try { await write(key, value); } catch (e) { log(`state write ${key}: ${e.message}`); }
    },
  };
}

// Decision 21 (S3): one snapshot per PR, state.<owner>.<repo>.pr.<n>, updated by every v2 event on
// that PR. Each event sets what it knows; a new sha empties checks, so they are the head's.
const EMPTY_SNAPSHOT = { branch: null, sha: null, state: "open", draft: null, auto_merge: null,
  mergeable_state: null, checks: {}, review: null, last_comment: null, updated_at: null };

const CHECK_EVENTS = new Set(["workflow_run", "check_run", "check_suite"]);

// Decision 22: only a PR-level event moves sha; a check sets it only while it is null, and a check
// for another sha is a late result from an older head, so it is ignored.
function nextSnapshot(prev, e, at) {
  const s = prev ? { ...prev, checks: { ...(prev.checks || {}) } } : { repo: e.repo, pr: e.pr, ...EMPTY_SNAPSHOT, checks: {} };
  const isCheck = CHECK_EVENTS.has(e.event);
  const stale = isCheck && e.sha && s.sha && e.sha !== s.sha;
  if (e.branch) s.branch = e.branch;
  if (e.sha && e.sha !== s.sha && !stale) { s.sha = e.sha; s.checks = {}; }
  if (e.event === "pull_request") s.state = e.signal === "pr_merged" ? "merged" : e.signal === "pr_closed" ? "closed" : "open";
  if (e.event === "pull_request" || e.event === "mergeable") {
    if (e.draft != null) s.draft = e.draft;
    if (e.auto_merge != null) s.auto_merge = e.auto_merge;
  }
  if (e.mergeable_state) s.mergeable_state = e.mergeable_state;
  if (isCheck && !stale && e.check && e.check.name) s.checks[e.check.name] = e.conclusion;
  if (e.event === "pull_request_review" && e.conclusion) s.review = String(e.conclusion).toLowerCase();
  if (e.event === "issue_comment" && e.comment) s.last_comment = { author: e.comment.author, url: e.comment.url };
  s.updated_at = at;
  return s;
}

// update(v2 event) and repair(repo, GitHub PR) run one change per PR at a time, so two on one PR
// both land. A snapshot that learns its branch writes state.<owner>.<repo>.branch.<branch> ({pr}),
// which a push_branch follows to its PR (decision 22).
function createPrSnapshots({ store = createStateStore(), now = () => new Date().toISOString() } = {}) {
  const queues = new Map();
  const serial = (key, fn) => {
    const next = (queues.get(key) || Promise.resolve()).then(fn);
    queues.set(key, next.catch(() => {}));
    return next;
  };
  const save = async (key, prev, s) => {
    await store.put(key, s);
    if (s.branch && (!prev || prev.branch !== s.branch)) await store.put(stateKey(s.repo, "branch", s.branch), { pr: s.pr });
  };
  return {
    async update(e) {
      if (e.signal === "push_branch") {
        const at = await store.get(stateKey(e.repo, "branch", e.branch));
        if (!at) return;
        const key = stateKey(e.repo, "pr", at.pr);
        await serial(key, async () => {
          const prev = await store.get(key);
          if (prev && e.sha && prev.sha !== e.sha) await store.put(key, { ...prev, sha: e.sha, checks: {}, updated_at: now() });
        });
        return;
      }
      if (e.pr == null) return;
      const key = stateKey(e.repo, "pr", e.pr);
      await serial(key, async () => {
        const prev = await store.get(key);
        await save(key, prev, nextSnapshot(prev, e, now()));
      });
    },
    // Decision 22: what the mergeable check read from GitHub is the PR's truth.
    async repair(repo, pr) {
      const key = stateKey(repo, "pr", pr.number);
      await serial(key, async () => {
        const prev = await store.get(key);
        const s = prev ? { ...prev, checks: { ...(prev.checks || {}) } } : { repo, pr: pr.number, ...EMPTY_SNAPSHOT, checks: {} };
        if (pr.head.sha !== s.sha) { s.sha = pr.head.sha; s.checks = {}; }
        s.branch = pr.head.ref;
        s.draft = pr.draft === true;
        s.auto_merge = pr.auto_merge != null;
        s.state = pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : "open";
        if (pr.mergeable_state && pr.mergeable_state !== "unknown") s.mergeable_state = pr.mergeable_state;
        s.updated_at = now();
        await save(key, prev, s);
      });
    },
  };
}

// A publish that, after a v2 (ev.*) event on a PR is published, updates that PR's snapshot. A failed
// publish updates nothing and still rejects; a failed snapshot is logged and the publish stands.
function withSnapshots(publish, snapshots, log = console.error) {
  return async (subject, event, msgID) => {
    const ack = await publish(subject, event, msgID);
    if (subject.startsWith("ev.") && event && (event.pr != null || event.signal === "push_branch")) {
      try { await snapshots.update(event); } catch (e) { log(`snapshot ${subject}: ${e.message}`); }
    }
    return ack;
  };
}

const notFound = (e) => /not found/i.test(e && e.message);
const exists = (p) => p.then(() => true, (e) => { if (notFound(e)) return false; throw e; });

async function ensureStream(jsm, owner, log = console.error) {
  const o = token(String(owner).toLowerCase());
  const stream = streamFor(o);
  const events = eventsStreamFor(o);
  // An update (not just an add), so a changed filter list reaches a consumer that already exists.
  const upsertStream = async (cfg) => {
    if (await exists(jsm.streams.info(cfg.name))) await jsm.streams.update(cfg.name, cfg);
    else await jsm.streams.add(cfg);
  };
  const upsertConsumer = async (streamName, cfg) => {
    if (await exists(jsm.consumers.info(streamName, cfg.durable_name))) await jsm.consumers.update(streamName, cfg.durable_name, cfg);
    else await jsm.consumers.add(streamName, cfg);
  };
  await upsertStream(stream);
  await upsertConsumer(stream.name, consumerFor(o));
  await upsertStream(events);
  for (const name of Object.keys(PROFILES)) await upsertConsumer(events.name, profileConsumerFor(o, name));
  await upsertStream(stateStreamFor(o));
  await upsertStream(leaseStreamFor(o));
  // Informational only: a failed listing must not stop the receiver from starting.
  try {
    for await (const c of jsm.consumers.list(events.name)) {
      if (!(c.name in PROFILES)) log(`${events.name}: consumer ${c.name} is not in the profile table, left alone`);
    }
  } catch (e) { log(`${events.name}: consumer list failed: ${e.message}`); }
}

module.exports = { ensureStream, streamFor, consumerFor, eventsStreamFor, profileConsumerFor, stateStreamFor, leaseStreamFor, stateKey, createStateStore,
  createPrSnapshots, withSnapshots };
