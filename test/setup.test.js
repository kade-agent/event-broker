"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { nkeys } = require("@nats-io/transport-node");
const { runSetup } = require("../scripts/setup");

const EXAMPLE = [
  "# comment kept",
  "LAN_ADDRESS=<NAS LAN address>",
  "APP_ID=<app id>",
  "ALLOWED_OWNERS=kade-agent,stella-rain",
  "RECEIVER_NKEY=<old>",
  "CLOUD_NKEY=<old>",
  "LAN_UNUSED_PASSWORD=<old>",
  "",
].join("\n");

function workdir(env = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-setup-"));
  fs.writeFileSync(path.join(dir, ".env.example"), EXAMPLE);
  if (env !== null) fs.writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

const readEnv = (dir) => Object.fromEntries(fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n")
  .filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const secret = (dir, name) => fs.readFileSync(path.join(dir, "secrets", name), "utf8").trim();
const publicOf = (seed) => nkeys.fromSeed(new TextEncoder().encode(seed)).getPublicKey();
const quiet = { log: () => {}, isRoot: false };
const OWNERS = ["kade_agent", "stella_rain"];

test("each owner gets a receiver and a reader seed, and .env gets their public keys", () => {
  const dir = workdir();
  runSetup(dir, quiet);
  const env = readEnv(dir);
  const seedFiles = fs.readdirSync(path.join(dir, "secrets")).filter((f) => /^(receiver|reader)_.+_seed$/.test(f));
  assert.strictEqual(seedFiles.length, 4);
  for (const o of OWNERS) {
    const slug = o.replace("_", "-");
    for (const kind of ["receiver", "reader"]) {
      const key = env[`${kind.toUpperCase()}_NKEY_${o.toUpperCase()}`];
      assert.match(key, /^U[A-Z2-7]{55}$/);
      assert.strictEqual(key, publicOf(secret(dir, `${kind}_${slug}_seed`)));
    }
  }
  assert.notStrictEqual(env.RECEIVER_NKEY_KADE_AGENT, env.READER_NKEY_KADE_AGENT);
  assert.match(secret(dir, "webhook_secret"), /^[0-9a-f]{64}$/);
});

test("an owner with dashes maps to underscores in the variable name", () => {
  const dir = workdir(EXAMPLE.replace("kade-agent,stella-rain", "kade-k8s-platform"));
  runSetup(dir, quiet);
  assert.match(readEnv(dir).READER_NKEY_KADE_K8S_PLATFORM, /^U[A-Z2-7]{55}$/);
});

test("secrets/receiver_seeds has one owner-and-seed line per owner", () => {
  const dir = workdir();
  runSetup(dir, quiet);
  const lines = secret(dir, "receiver_seeds").split("\n");
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map((l) => l.split(" ")[0]), ["kade-agent", "stella-rain"]);
  assert.strictEqual(lines[0].split(" ")[1], secret(dir, "receiver_kade-agent_seed"));
  assert.strictEqual(lines[1].split(" ")[1], secret(dir, "receiver_stella-rain_seed"));
});

test("the old global keys are removed from .env", () => {
  const dir = workdir();
  runSetup(dir, quiet);
  const text = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.doesNotMatch(text, /^(RECEIVER_NKEY|CLOUD_NKEY|LAN_UNUSED_PASSWORD)=/m);
});

test("a second run prints Nothing to change and keeps every seed", () => {
  const dir = workdir();
  runSetup(dir, quiet);
  const snap = () => ({ env: fs.readFileSync(path.join(dir, ".env"), "utf8"), s: secret(dir, "reader_kade-agent_seed"), r: secret(dir, "receiver_seeds") });
  const before = snap();
  const lines = [];
  const r = runSetup(dir, { log: (l) => lines.push(l), isRoot: false });
  assert.deepStrictEqual(r.changed, []);
  assert.match(lines.join("\n"), /Nothing to change/);
  assert.deepStrictEqual(snap(), before);
});

test("a wrong public key is rederived from its seed, and an invalid seed is replaced", () => {
  const dir = workdir();
  runSetup(dir, quiet);
  const good = secret(dir, "reader_stella-rain_seed");
  fs.writeFileSync(path.join(dir, "secrets", "receiver_kade-agent_seed"), "SUbroken\n");
  fs.writeFileSync(path.join(dir, ".env"), fs.readFileSync(path.join(dir, ".env"), "utf8").replace(/^READER_NKEY_STELLA_RAIN=.*$/m, "READER_NKEY_STELLA_RAIN=UWRONG"));
  runSetup(dir, quiet);
  const env = readEnv(dir);
  assert.strictEqual(env.READER_NKEY_STELLA_RAIN, publicOf(good));
  assert.strictEqual(env.RECEIVER_NKEY_KADE_AGENT, publicOf(secret(dir, "receiver_kade-agent_seed")));
  assert.ok(secret(dir, "receiver_seeds").includes(secret(dir, "receiver_kade-agent_seed")));
});

test("APP_ID, LAN_ADDRESS and an existing webhook secret are kept", () => {
  const dir = workdir(EXAMPLE.replace("APP_ID=<app id>", "APP_ID=1234567").replace("LAN_ADDRESS=<NAS LAN address>", "LAN_ADDRESS=10.0.0.5"));
  fs.mkdirSync(path.join(dir, "secrets"));
  fs.writeFileSync(path.join(dir, "secrets", "webhook_secret"), "keep-me\n");
  fs.writeFileSync(path.join(dir, "secrets", "app_private_key.pem"), "pem");
  const r = runSetup(dir, quiet);
  assert.strictEqual(readEnv(dir).APP_ID, "1234567");
  assert.strictEqual(readEnv(dir).LAN_ADDRESS, "10.0.0.5");
  assert.strictEqual(secret(dir, "webhook_secret"), "keep-me");
  assert.deepStrictEqual(r.todo, []);
});

test("a fresh folder leaves placeholders empty and lists what is still to do", () => {
  const dir = workdir();
  const r = runSetup(dir, quiet);
  assert.strictEqual(readEnv(dir).APP_ID, "");
  assert.strictEqual(readEnv(dir).LAN_ADDRESS, "");
  assert.deepStrictEqual(r.todo.sort(), ["APP_ID", "LAN_ADDRESS", "secrets/app_private_key.pem"]);
});

test("without ALLOWED_OWNERS it stops and says so", () => {
  const dir = workdir(EXAMPLE.replace("ALLOWED_OWNERS=kade-agent,stella-rain", "ALLOWED_OWNERS="));
  assert.throws(() => runSetup(dir, quiet), /ALLOWED_OWNERS/);
});

test("as root, receiver seeds go to uid 1000 and reader seeds and .env to the folder's owner", () => {
  const dir = workdir();
  fs.mkdirSync(path.join(dir, "secrets"));
  fs.writeFileSync(path.join(dir, "secrets", "app_private_key.pem"), "pem");
  const owners = {};
  runSetup(dir, { log: () => {}, isRoot: true, owner: { uid: 1026, gid: 100 }, chown: (p, uid, gid) => { owners[path.relative(dir, p).replace(/\\/g, "/")] = [uid, gid]; } });
  for (const f of ["webhook_secret", "receiver_seeds", "receiver_kade-agent_seed", "app_private_key.pem"]) {
    assert.deepStrictEqual(owners[`secrets/${f}`], [1000, 1000], f);
  }
  assert.deepStrictEqual(owners["secrets/reader_kade-agent_seed"], [1026, 100]);
  assert.deepStrictEqual(owners[".env"], [1026, 100]);
});

test("the report names each reader seed's file, and never prints a seed or a secret", () => {
  const dir = workdir();
  const lines = [];
  runSetup(dir, { log: (l) => lines.push(l), isRoot: false });
  const out = lines.join("\n");
  assert.doesNotMatch(out, /S[A-Z][A-Z2-7]{56}/, "no seed");
  assert.ok(!out.includes(secret(dir, "webhook_secret")), "no webhook secret");
  assert.match(out, /secrets\/reader_kade-agent_seed/);
  assert.match(out, /secrets\/reader_stella-rain_seed/);
});
