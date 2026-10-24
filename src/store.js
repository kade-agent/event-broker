"use strict";
// Append-only JSONL in DATA_DIR/events.jsonl, one stored event per line with its id and time.
// Opening the store drops a torn last line, prunes and rewrites the file. Pruning always keeps the
// newest event, so ids continue after a restart and a subscriber's Last-Event-ID stays meaningful.
const fs = require("node:fs");
const path = require("node:path");

const DAY = 24 * 60 * 60 * 1000;

function openStore(dir, { maxEvents = 5000, maxAgeMs = 7 * DAY, now = Date.now } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  let events = [];
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { events.push(JSON.parse(l)); } catch { /* a torn line from a crash */ }
    }
  }
  let last = events.length ? events[events.length - 1].id : 0;

  function prune() {
    const cutoff = now() - maxAgeMs;
    const keep = events.filter((e, i) => i === events.length - 1 || e.at >= cutoff);
    events = keep.slice(-maxEvents);
  }

  function rewrite() {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e) + "\n").join(""));
    fs.renameSync(tmp, file);
  }

  prune();
  rewrite();

  const strip = ({ at, ...e }) => e;

  return {
    append(event) {
      const stored = { ...event, id: ++last, at: now() };
      fs.appendFileSync(file, JSON.stringify(stored) + "\n");
      events.push(stored);
      if (events.length > maxEvents) {
        prune();
        rewrite();
      }
      return strip(stored);
    },
    since(id) {
      return events.filter((e) => e.id > id).map(strip);
    },
    lastId() {
      return last;
    },
  };
}

module.exports = { openStore };
