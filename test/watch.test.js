"use strict";
// client/watch.sh against a fake `nats`: each call pops one scripted answer from a queue file.
// When the queue is empty, the fake hands the pidfile to another owner, so the loop ends.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const WATCH = path.join(__dirname, "..", "client", "watch.sh");
const sh = (p) => p.replace(/\\/g, "/");

const FAKE = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls"
line=$(head -n 1 "$FAKE_DIR/queue" 2>/dev/null)
if [ -z "$line" ]; then echo 0 > "$WATCH_PIDFILE"; echo "nats: error: no message received: timeout"; exit 1; fi
tail -n +2 "$FAKE_DIR/queue" > "$FAKE_DIR/queue.next"; mv "$FAKE_DIR/queue.next" "$FAKE_DIR/queue"
case "$line" in
  OK\\ *) echo "\${line#OK }"; exit 0 ;;
  TIMEOUT) echo "nats: error: no message received: timeout"; exit 1 ;;
  *) echo "nats: error: \${line#ERR }"; exit 1 ;;
esac
`;

function run(queue, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-watch-"));
  fs.writeFileSync(path.join(dir, "nats"), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "queue"), queue.map((l) => l + "\n").join(""));
  const r = spawnSync("bash", [sh(WATCH)], {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env, FAKE_DIR: sh(dir), NATS_BIN: sh(path.join(dir, "nats")), WATCH_PIDFILE: sh(path.join(dir, "watch.pid")),
      EVENT_BROKER_URL: "nats://broker.test:4222", EVENT_BROKER_NKEY_FILE: "", EVENT_BROKER_CLOUD_SEED: "", ...env,
    },
  });
  const calls = fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") : [];
  return { ...r, dir, calls };
}

const bashMissing = spawnSync("bash", ["-c", "true"]).status !== 0 && "bash is not installed";

test("events print one per line; a quiet minute is not an outage", { skip: bashMissing }, () => {
  const r = run(['OK {"pr":1}', "TIMEOUT", 'OK {"pr":2}']);
  assert.deepStrictEqual(r.stdout.trim().split("\n"), ['{"pr":1}', '{"pr":2}']);
  assert.match(r.calls[0], /--server nats:\/\/broker\.test:4222 consumer next GITHUB dispatcher --raw --count 1 --wait 60s/);
  assert.doesNotMatch(r.calls[0], /--nkey/, "no key on the LAN");
});

test("two failures in a row print BROKER-DOWN and stop", { skip: bashMissing }, () => {
  const r = run(['OK {"pr":1}', "ERR connection refused", "ERR connection refused", 'OK {"pr":9}']);
  const lines = r.stdout.trim().split("\n");
  assert.strictEqual(lines[0], '{"pr":1}');
  assert.match(lines[1], /^BROKER-DOWN .*connection refused/);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.calls.length, 3, "stopped before reading on");
});

test("with a key file setting, the seed is written from the environment at run time, mode 600", { skip: bashMissing }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-seed-"));
  const keyFile = sh(path.join(tmp, "event-broker.nk"));
  const r = run(['OK {"pr":1}'], { EVENT_BROKER_NKEY_FILE: keyFile, EVENT_BROKER_CLOUD_SEED: "SUAFAKESEED" });
  assert.strictEqual(fs.readFileSync(keyFile, "utf8"), "SUAFAKESEED\n");
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.match(r.calls[0], new RegExp(`--nkey ${keyFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(r.stdout, /SUAFAKESEED/, "the seed is never printed");
});

test("an existing key file is kept", { skip: bashMissing }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-seed-"));
  const keyFile = path.join(tmp, "event-broker.nk");
  fs.writeFileSync(keyFile, "SUAKEEP\n");
  run([], { EVENT_BROKER_NKEY_FILE: sh(keyFile), EVENT_BROKER_CLOUD_SEED: "SUANEW" });
  assert.strictEqual(fs.readFileSync(keyFile, "utf8"), "SUAKEEP\n");
});

test("a key file setting with no seed and no file stops with BROKER-DOWN", { skip: bashMissing }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-seed-"));
  const r = run(['OK {"pr":1}'], { EVENT_BROKER_NKEY_FILE: sh(path.join(tmp, "missing.nk")) });
  assert.match(r.stdout, /^BROKER-DOWN .*EVENT_BROKER_CLOUD_SEED/);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.calls.length, 0);
});

test("a newer watch owning the pidfile ends this one", { skip: bashMissing }, () => {
  const r = run([]); // the fake hands the pidfile away on its first call
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.calls.length, 1);
});

test("no EVENT_BROKER_URL is a clear error", { skip: bashMissing }, () => {
  const r = run([], { EVENT_BROKER_URL: "" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /EVENT_BROKER_URL/);
});
