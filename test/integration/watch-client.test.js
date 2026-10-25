"use strict";
// client/watch.js against a real nats-server started with nats/nats-server.conf (CI's integration job),
// on the LAN port and over websocket. Same environment as events.test.js; skipped without it.
//
// The test files run in parallel against one server, and events.test.js pulls from account A's
// EVENTS/dispatcher consumer, which sees every pr_merged of the account. So each run here reads
// its own consumer on EVENTS (selected with --profile), and publishes only signals the dispatcher
// profile leaves out: ci_passed is printed, review_approved is dropped by the consumer's filter.
// The client takes any consumer name, so what is tested is the client, not the profile table.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect, nkeyAuthenticator } = require("@nats-io/transport-node");
const { jetstream, jetstreamManager, AckPolicy, DeliverPolicy } = require("@nats-io/jetstream");
const { adapter } = require("../../client/watch");
const { ensureStream } = require("../../src/stream");
const { blank } = require("../../src/normalize");

const env = process.env;
const A = "kade-agent";
const WATCH = path.join(__dirname, "..", "..", "client", "watch.js");
const skip = !(env.NATS_URL && env.NATS_WS_URL && env.RECEIVER_SEED_A && env.READER_SEED_A)
  && "needs a nats-server (CI integration job)";
const TIMEOUT = 15000;

const receiver = () => connect({ servers: env.NATS_URL, authenticator: nkeyAuthenticator(new TextEncoder().encode(env.RECEIVER_SEED_A)), timeout: 3000, reconnect: false });

// A consumer of EVENTS that selects ci_passed in one repository, with a 2 s ack wait.
async function setup(nc, name, repo) {
  const jsm = await jetstreamManager(nc);
  await ensureStream(jsm, A);
  await jsm.consumers.add("EVENTS", {
    durable_name: name,
    filter_subject: `ev.${A}.${repo}.*.*.ci_passed`,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    ack_wait: 2e9,
  });
  return jsm;
}

const message = (repo, signal, extra) => ({
  ...blank(`d-${randomUUID()}`, `${A}/${repo}`), v: 2, signal, pr: 1, branch: "claude/x", sha: "9f2c1e0aaaa", ...extra,
});
const publish = (nc, repo, m) => jetstream(nc).publish(`ev.${A}.${repo}.pr.1.${m.signal}`, JSON.stringify(m), { msgID: m.delivery });

// Spawns the client with the reader seed in the environment only (it writes its own key file).
// --window 0: one line per event, which these checks read; the summary has unit tests.
function watch(url, profile, dir) {
  const child = spawn(process.execPath, [WATCH, "--owner", A, "--profile", profile, "--window", "0"], {
    env: { PATH: env.PATH, HOME: dir, EVENT_BROKER_URL: url, EVENT_BROKER_CLOUD_SEED: env.READER_SEED_A,
      EVENT_BROKER_NKEY_FILE: path.join(dir, "reader.nk"), WATCH_PIDFILE: path.join(dir, "watch.pid") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const w = { child, lines: [], err: "", waiters: [] };
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { w.lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    for (const fn of w.waiters.splice(0)) fn();
  });
  child.stderr.on("data", (d) => { w.err += d; });
  w.exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  // The next unread line, or null after ms with none.
  w.next = async (ms = TIMEOUT) => {
    const deadline = Date.now() + ms;
    while (w.lines.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise((r) => { const t = setTimeout(r, left); w.waiters.push(() => { clearTimeout(t); r(); }); });
    }
    return w.lines.shift();
  };
  return w;
}

async function drained(jsm, name) {
  for (let i = 0; i < 20; i++) {
    const c = await jsm.consumers.info("EVENTS", name);
    if (c.num_pending === 0 && c.num_ack_pending === 0) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

for (const [label, url] of [["LAN", env.NATS_URL], ["websocket", env.NATS_WS_URL]]) {
  test(`watch.js over ${label}: WATCH-ARMED, then the line of the selected signal and none of the other, acked after the write`, { skip }, async () => {
    const id = randomUUID().slice(0, 8);
    const repo = `wc-${label.toLowerCase()}-${id}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-client-"));
    const nc = await receiver();
    const w = watch(url, `wc-${id}`, dir);
    try {
      const jsm = await setup(nc, `wc-${id}`, repo);
      const passed = message(repo, "ci_passed");
      await publish(nc, repo, passed);
      await publish(nc, repo, message(repo, "review_approved"));

      assert.match(await w.next(), new RegExp(`^WATCH-ARMED ${A} consumer=wc-${id} unprocessed=\\d+$`));
      assert.strictEqual(await w.next(), `ci_passed ${A}/${repo}#1 branch=claude/x sha=9f2c1e0 delivery=${passed.delivery}`);
      assert.strictEqual(await w.next(1500), null, "the consumer filter must drop review_approved");
      assert.ok(await drained(jsm, `wc-${id}`), "the printed message must be acked");

      assert.strictEqual(fs.readFileSync(path.join(dir, "reader.nk"), "utf8"), `${env.READER_SEED_A}\n`);
      if (process.platform !== "win32") assert.strictEqual(fs.statSync(path.join(dir, "reader.nk")).mode & 0o777, 0o600);

      w.child.kill("SIGTERM");
      assert.deepStrictEqual(await w.exit, { code: 0, signal: null });
      assert.ok(!w.err.includes(env.READER_SEED_A) && !w.lines.join("\n").includes(env.READER_SEED_A));
    } finally {
      w.child.kill("SIGKILL");
      await nc.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("watch.js: with stdout closed after WATCH-ARMED it exits 3 without acking, and the next run still prints the message", { skip }, async () => {
  const id = randomUUID().slice(0, 8);
  const repo = `wc-closed-${id}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-client-"));
  const nc = await receiver();
  const first = watch(env.NATS_URL, `wc-${id}`, dir);
  let second;
  try {
    const jsm = await setup(nc, `wc-${id}`, repo);
    assert.match(await first.next(), /^WATCH-ARMED /);
    first.child.stdout.destroy(); // the reader of its stdout is gone: the next write fails
    const m = message(repo, "ci_passed");
    await publish(nc, repo, m);
    assert.deepStrictEqual(await Promise.race([first.exit, new Promise((r) => setTimeout(() => r("timeout"), TIMEOUT))]), { code: 3, signal: null });

    // Unacked: it comes back after the 2 s ack wait.
    second = watch(env.NATS_URL, `wc-${id}`, dir);
    assert.match(await second.next(), /^WATCH-ARMED /);
    const line = await second.next();
    assert.ok(line && line.startsWith("ci_passed "), `got ${line}`);
    assert.ok(line.endsWith(`delivery=${m.delivery}`));
    assert.ok(await drained(jsm, `wc-${id}`));
  } finally {
    first.child.kill("SIGKILL");
    if (second) second.child.kill("SIGKILL");
    await nc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watch.js adapter: pending() asks the server each time, so WATCH-ALIVE does not repeat a stale count", { skip }, async () => {
  const id = randomUUID().slice(0, 8);
  const repo = `wc-pending-${id}`;
  const nc = await receiver();
  const reader = await connect({ servers: env.NATS_URL, authenticator: nkeyAuthenticator(new TextEncoder().encode(env.READER_SEED_A)), timeout: 3000, reconnect: false });
  try {
    await setup(nc, `wc-${id}`, repo);
    const a = adapter(reader, A, `wc-${id}`);
    assert.strictEqual(await a.pending(), 0);
    await publish(nc, repo, message(repo, "ci_passed"));
    assert.strictEqual(await a.pending(), 1);
    assert.deepStrictEqual(await a.streamSubjects(), [`ev.${A}.>`]);
  } finally {
    await reader.close();
    await nc.close();
  }
});
