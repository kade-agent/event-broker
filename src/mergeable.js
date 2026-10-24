"use strict";
// After a trigger (normalize.mergeTrigger), read each PR's mergeable_state until GitHub has computed
// it, and publish a "mergeable" event when it differs from the last one published for that PR
// (design section 5). The last states live in memory: after a restart the first check republishes,
// and JetStream's duplicate window drops a repeat within two minutes.
const { prefix, blank, prFields } = require("./normalize");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createMergeWatch({ gh, publish, sleep = wait, maxTries = 6, baseDelayMs = 2000, onError = (e) => console.error(e.message), log = console.error }) {
  const last = new Map(); // "owner/repo#n" -> state

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
    if (last.get(key) === pr.mergeable_state) return;
    const event = { ...blank(null, repo), ...prFields(pr), event: "mergeable", mergeable_state: pr.mergeable_state };
    const subject = `${prefix(repo)}.pr.${n}.mergeable`;
    const msgID = `mergeable:${key}:${pr.head.sha}:${pr.mergeable_state}`;
    const ack = await publish(subject, event, msgID);
    last.set(key, pr.mergeable_state);
    log(`${msgID} mergeable.${pr.mergeable_state} -> ${ack && ack.duplicate ? "duplicate" : "published"} ${subject}`);
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
