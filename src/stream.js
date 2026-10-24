"use strict";
// Stream GITHUB and the dispatcher's durable consumer in one owner's account (design section 6),
// created or updated when the receiver starts. Every account has the same names; the owner is in
// the subjects.
const { AckPolicy, DeliverPolicy, DiscardPolicy, StorageType } = require("@nats-io/jetstream");
const { token } = require("./normalize");

const SECOND = 1e9; // JetStream durations are nanoseconds

const streamFor = (owner) => ({
  name: "GITHUB",
  subjects: [`github.${owner}.>`],
  storage: StorageType.File,
  max_age: 7 * 24 * 3600 * SECOND,
  max_bytes: 512 * 1024 * 1024,
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

const notFound = (e) => /not found/i.test(e && e.message);
const exists = (p) => p.then(() => true, (e) => { if (notFound(e)) return false; throw e; });

async function ensureStream(jsm, owner) {
  const o = token(String(owner).toLowerCase());
  const stream = streamFor(o);
  const consumer = consumerFor(o);
  if (await exists(jsm.streams.info(stream.name))) await jsm.streams.update(stream.name, stream);
  else await jsm.streams.add(stream);
  // An update (not just an add), so a changed filter list reaches a consumer that already exists.
  if (await exists(jsm.consumers.info(stream.name, consumer.durable_name))) await jsm.consumers.update(stream.name, consumer.durable_name, consumer);
  else await jsm.consumers.add(stream.name, consumer);
}

module.exports = { ensureStream, streamFor, consumerFor };
