"use strict";
// After a trigger (normalize.mergeTrigger), read each PR's mergeable_state until GitHub has computed
// it, and publish a "mergeable" event when it differs from the last one published for that PR
// (design section 5). Decision 19: the last state is the store's key
// state.<owner>.<repo>.pr.<n>.mergeable ({mergeable_state, sha}), kept in STATE, so a restart does
// not republish it.
const { prefix, blank, prFields } = require("./normalize");
const { v2Of } = require("./signals");
const { stateKey, createStateStore } = require("./stream");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createMergeWatch({ gh, publish, store = createStateStore(), sleep = wait, maxTries = 6, baseDelayMs = 2000, onError = (e) => console.error(e.message), log = console.error }) {
  async function read(repo, n) {
    for (let i = 0; i < maxTries; i++) {
      const pr = await gh.get(repo, `/pulls/${n}`);
      if (pr.mergeable_state && pr.mergeable_state !== "unknown") return pr;
      if (i < maxTries - 1) await sleep(baseDelayMs * 2 ** i);
    }
    return null;
  }

  async function check(repo, n) {
    const pr = await read(repo, n);
    if (!pr) return;
    const key = `${repo}#${n}`;
    const stateAt = stateKey(repo, "pr", n, "mergeable");
    const last = await store.get(stateAt);
    if (last && last.mergeable_state === pr.mergeable_state) return;
    const event = { ...blank(null, repo), ...prFields(pr), event: "mergeable", mergeable_state: pr.mergeable_state };
    const subject = `${prefix(repo)}.pr.${n}.mergeable`;
    const msgID = `mergeable:${key}:${pr.head.sha}:${pr.mergeable_state}`;
    const v2 = v2Of({ ...event, delivery: msgID });
    const ack1 = await publish(subject, event, msgID);
    const ack2 = await publish(v2.subject, v2.event, msgID);
    await store.put(stateAt, { mergeable_state: pr.mergeable_state, sha: pr.head.sha });
    log(`${msgID} mergeable.${pr.mergeable_state} -> ${ack1 && ack1.duplicate && ack2 && ack2.duplicate ? "duplicate" : "published"} ${subject} ${v2.subject}`);
  }

  return {
    async handle(trigger) {
      const numbers = trigger.pr != null
        ? [trigger.pr]
        : (await gh.get(trigger.repo, `/pulls?state=open&base=${encodeURIComponent(trigger.base)}&per_page=100`)).map((p) => p.number);
      for (const n of numbers) {
        try { await check(trigger.repo, n); } catch (e) { onError(e); }
      }
    },
  };
}

module.exports = { createMergeWatch };
