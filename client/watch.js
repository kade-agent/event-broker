#!/usr/bin/env node
"use strict";
// The dispatcher's PR watch (agent-config docs/event-broker-design.md, section 9; pr-watch.md there):
//   node client/watch.js --owner <org> [--profile dispatcher] [--json]
// Run it as a Claude Code Monitor command. Each stdout line is one event, WATCH-ARMED, WATCH-ALIVE or
// BROKER-DOWN. The logic is in watch-core.js; this file only wires the real NATS connection.
const fs = require("node:fs");
const os = require("node:os");
const { connect, nkeyAuthenticator } = require("@nats-io/transport-node");
const { wsconnect } = require("@nats-io/nats-core");
const { jetstream, jetstreamManager } = require("@nats-io/jetstream");
const { Fatal, resolveSettings, run } = require("./watch-core");

const PULL_MS = 60000;

function adapter(nc, owner, profile) {
  let consumer;
  const getConsumer = async () => (consumer ??= await jetstream(nc).consumers.get("EVENTS", profile));
  return {
    async streamSubjects() {
      return (await (await jetstreamManager(nc)).streams.info("EVENTS")).config.subjects;
    },
    async pending() {
      return (await (await getConsumer()).info(true)).num_pending;
    },
    async next() {
      const m = await (await getConsumer()).next({ expires: PULL_MS });
      if (!m) return null;
      let data = null;
      try { data = m.json(); } catch { /* the loop drops it */ }
      return { seq: m.seq, data, ack: () => m.ackAck() };
    },
    close: () => nc.close(),
  };
}

async function main() {
  let settings;
  try {
    settings = resolveSettings({ argv: process.argv.slice(2), env: process.env, home: os.homedir(), fs, platform: process.platform });
  } catch (e) {
    console.log(`BROKER-DOWN ${e instanceof Fatal ? e.message : `settings: ${e.message}`}`);
    return e instanceof Fatal ? e.exitCode : 2;
  }

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => ac.abort());
  // A closed stdout reports through the write callback; the stream's own 'error' must not crash us.
  process.stdout.on("error", () => {});

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
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
    checkParent: () => process.kill(process.ppid, 0),
  });
}

main().then((code) => process.exit(code), (e) => {
  console.log(`BROKER-DOWN ${e.message}`);
  process.exit(1);
});
