"use strict";
// Stream GITHUB and the dispatcher's durable consumer (design section 6), created or updated when
// the receiver starts.
const { AckPolicy, DeliverPolicy, DiscardPolicy, StorageType } = require("@nats-io/jetstream");

const SECOND = 1e9; // JetStream durations are nanoseconds

const STREAM = {
  name: "GITHUB",
  subjects: ["github.>"],
  storage: StorageType.File,
  max_age: 7 * 24 * 3600 * SECOND,
  max_bytes: 512 * 1024 * 1024,
  discard: DiscardPolicy.Old,
  duplicate_window: 120 * SECOND,
};

const CONSUMER = {
  durable_name: "dispatcher",
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.New,
  ack_wait: 60 * SECOND,
  max_ack_pending: 1000,
};

const notFound = (e) => /not found/i.test(e && e.message);

async function ensureStream(jsm) {
  const exists = await jsm.streams.info(STREAM.name).then(() => true, (e) => { if (notFound(e)) return false; throw e; });
  if (exists) await jsm.streams.update(STREAM.name, STREAM);
  else await jsm.streams.add(STREAM);
  const hasConsumer = await jsm.consumers.info(STREAM.name, CONSUMER.durable_name).then(() => true, (e) => { if (notFound(e)) return false; throw e; });
  if (!hasConsumer) await jsm.consumers.add(STREAM.name, CONSUMER);
}

module.exports = { ensureStream, STREAM, CONSUMER };
