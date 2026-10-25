"use strict";
// Streams GITHUB (v1) and EVENTS (v2) with their durable consumers in one owner's account (design
// sections 6 and 9),
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
  if (jsm.consumers.list) {
    for await (const c of jsm.consumers.list(events.name)) {
      if (!(c.name in PROFILES)) log(`${events.name}: consumer ${c.name} is not in the profile table, left alone`);
    }
  }
}

module.exports = { ensureStream, streamFor, consumerFor, eventsStreamFor, profileConsumerFor };
