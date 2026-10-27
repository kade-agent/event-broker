#!/usr/bin/env node
"use strict";
// The dispatcher's PR watch (agent-config docs/event-broker-design.md, section 9; pr-watch.md there):
//   node client/watch.js --owner <org> [--profile dispatcher] [--json] [--window 30] [--alive]
//   node client/watch.js --owner <org> --state <org>/<repo> [--json] [--all]   (prints STATE and exits; decisions 21, 27)
// Run it as a Claude Code Monitor command. Its output is a SUMMARY of a 30 s window (a header line,
// then one entry per line; one line per event with --window 0), WATCH-ARMED (on stderr when nothing
// waits: decision 31), WATCH-ALIVE (with --alive) or BROKER-DOWN. The logic is in watch-core.js;
// this file only wires the real NATS connection.
const fs = require("node:fs");
const os = require("node:os");
const { connect, nkeyAuthenticator } = require("@nats-io/transport-node");
const { wsconnect } = require("@nats-io/nats-core");
const { jetstream, jetstreamManager } = require("@nats-io/jetstream");
const { Fatal, resolveSettings, run, formatState } = require("./watch-core");
const { token } = require("../src/normalize");

const PULL_MS = 60000;

function adapter(nc, owner, profile) {
  let consumer;
  const getConsumer = async () => (consumer ??= await jetstream(nc).consumers.get("EVENTS", profile));
  return {
    async streamSubjects() {
      return (await (await jetstreamManager(nc)).streams.info("EVENTS")).config.subjects;
    },
    async pending() {
      return (await (await getConsumer()).info(false)).num_pending;
    },
    async next() {
      const m = await (await getConsumer()).next({ expires: PULL_MS });
      if (!m) return null;
      let data = null;
      try { data = m.json(); } catch { /* the loop drops it */ }
      // at: the stream's timestamp of the message, which the ignore file matches (event-broker#32).
      return { seq: m.seq, data, at: m.time.getTime(), ack: () => m.ackAck() };
    },
    close: () => nc.close(),
  };
}

// Decision 21 (S3): the repository's red list and PR snapshots from STATE, read with the reader key.
async function readState(nc, owner, repo) {
  const prefix = `state.${owner}.${token(repo.split("/")[1])}`;
  const jsm = await jetstreamManager(nc);
  const get = async (subject) => {
    const m = await jsm.streams.getMessage("STATE", { last_by_subj: subject });
    return m ? m.json() : null;
  };
  const red = ((await get(`${prefix}.red`)) || { red: [] }).red;
  const info = await jsm.streams.info("STATE", { subjects_filter: `${prefix}.pr.*` });
  const prs = (await Promise.all(Object.keys((info.state && info.state.subjects) || {}).map(get))).filter(Boolean);
  return { repo, red, prs };
}

async function main() {
  let settings;
  try {
    settings = resolveSettings({ argv: process.argv.slice(2), env: process.env, home: os.homedir(), fs, platform: process.platform });
  } catch (e) {
    console.log(`BROKER-DOWN ${e instanceof Fatal ? e.message : `settings: ${e.message}`}`);
    return e instanceof Fatal ? e.exitCode : 2;
  }

  const seedText = () => new TextEncoder().encode(fs.readFileSync(settings.keyFile, "utf8").trim());
  if (settings.state) {
    let nc;
    try {
      const opts = { servers: settings.url, authenticator: nkeyAuthenticator(seedText()), timeout: 5000 };
      nc = /^wss?:/.test(settings.url) ? await wsconnect(opts) : await connect(opts);
      for (const line of formatState(await readState(nc, settings.owner, settings.state), settings.json, settings.all)) console.log(line);
      return 0;
    } catch (e) {
      console.log(`BROKER-DOWN ${e.message}`);
      return 1;
    } finally { if (nc) await nc.close().catch(() => {}); }
  }

  const parent = process.ppid;
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => ac.abort());
  // A closed stdout reports through the write callback; the stream's own 'error' must not crash us.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {}); // the log is best effort (decision 31)

  const seed = new TextEncoder().encode(fs.readFileSync(settings.keyFile, "utf8").trim());
  const open = async (hooks) => {
    const opts = { servers: settings.url, authenticator: nkeyAuthenticator(seed), timeout: 5000, maxReconnectAttempts: -1 };
    const nc = /^wss?:/.test(settings.url) ? await wsconnect(opts) : await connect(opts);
    (async () => {
      for await (const s of nc.status()) {
        if (s.type === "disconnect") hooks.disconnected();
        else if (s.type === "reconnect") hooks.reconnected();
      }
    })().catch(() => {});
    return adapter(nc, settings.owner, settings.profile);
  };

  return run({
    settings, fs, pid: process.pid, signal: ac.signal,
    connect: open,
    write: (line) => new Promise((resolve, reject) => process.stdout.write(`${line}\n`, (e) => (e ? reject(e) : resolve()))),
    log: (line) => process.stderr.write(`${line}\n`),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
    // A parent that died hands us to init or a subreaper, so its pid is kept and the ppid compared too.
    checkParent: () => { if (process.ppid !== parent) throw new Error("parent changed"); process.kill(parent, 0); },
  });
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    console.log(`BROKER-DOWN ${e.message}`);
    process.exit(1);
  });
}

module.exports = { adapter };
