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
  "RECEIVER_NKEY=<receiver public NKey>",
  "CLOUD_NKEY=<cloud public NKey>",
  "LAN_UNUSED_PASSWORD=<random>",
  "",
].join("\n");

function workdir(env = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-broker-setup-"));
  fs.writeFileSync(path.join(dir, ".env.example"), EXAMPLE);
  if (env !== null) fs.writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

const readEnv = (dir) => Object.fromEntries(fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n")
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const secret = (dir, name) => fs.readFileSync(path.join(dir, "secrets", name), "utf8").trim();
const publicOf = (seed) => nkeys.fromSeed(new TextEncoder().encode(seed)).getPublicKey();
const quiet = { log: () => {}, isRoot: false };

test("a fresh folder gets .env from the example, both NKey pairs, a webhook secret and a LAN password", () => {
  const dir = workdir();
  const r = runSetup(dir, quiet);
  const env = readEnv(dir);
  assert.strictEqual(env.RECEIVER_NKEY, publicOf(secret(dir, "receiver_nkey_seed")));
  assert.strictEqual(env.CLOUD_NKEY, publicOf(secret(dir, "cloud_seed")));
  for (const k of ["RECEIVER_NKEY", "CLOUD_NKEY"]) assert.match(env[k], /^U[A-Z2-7]{55}$/);
  assert.match(secret(dir, "webhook_secret"), /^[0-9a-f]{64}$/);
  assert.match(env.LAN_UNUSED_PASSWORD, /^[0-9a-f]{48}$/);
  assert.ok(fs.readFileSync(path.join(dir, ".env"), "utf8").startsWith("# comment kept"), "comments kept");
  assert.deepStrictEqual(r.todo.sort(), ["APP_ID", "LAN_ADDRESS", "secrets/app_private_key.pem"]);
});

test("a second run changes nothing", () => {
  const dir = workdir();
  runSetup(dir, quiet);
  const before = { env: fs.readFileSync(path.join(dir, ".env"), "utf8"), r: secret(dir, "receiver_nkey_seed"), c: secret(dir, "cloud_seed"), w: secret(dir, "webhook_secret") };
  const r = runSetup(dir, quiet);
  assert.deepStrictEqual(r.changed, []);
  assert.deepStrictEqual({ env: fs.readFileSync(path.join(dir, ".env"), "utf8"), r: secret(dir, "receiver_nkey_seed"), c: secret(dir, "cloud_seed"), w: secret(dir, "webhook_secret") }, before);
});

test("a seed pasted into CLOUD_NKEY moves to secrets/cloud_seed, and .env gets its public key", () => {
  const pair = nkeys.createUser();
  const seed = new TextDecoder().decode(pair.getSeed());
  const dir = workdir(EXAMPLE.replace("CLOUD_NKEY=<cloud public NKey>", `CLOUD_NKEY=${seed}`));
  runSetup(dir, quiet);
  assert.strictEqual(secret(dir, "cloud_seed"), seed);
  assert.strictEqual(readEnv(dir).CLOUD_NKEY, pair.getPublicKey());
});

test("an invalid seed is replaced by a new pair; a wrong public key is rederived from a valid seed", () => {
  const dir = workdir(EXAMPLE.replace("CLOUD_NKEY=<cloud public NKey>", "CLOUD_NKEY=SUbroken"));
  fs.mkdirSync(path.join(dir, "secrets"));
  const pair = nkeys.createUser();
  fs.writeFileSync(path.join(dir, "secrets", "receiver_nkey_seed"), new TextDecoder().decode(pair.getSeed()) + "\n");
  const r = runSetup(dir, quiet);
  const env = readEnv(dir);
  assert.strictEqual(env.RECEIVER_NKEY, pair.getPublicKey(), "kept the valid receiver seed");
  assert.strictEqual(env.CLOUD_NKEY, publicOf(secret(dir, "cloud_seed")));
  assert.ok(r.changed.includes("CLOUD_NKEY"));
});

test("APP_ID, LAN_ADDRESS and an existing webhook secret are kept", () => {
  const dir = workdir(EXAMPLE.replace("APP_ID=<app id>", "APP_ID=1234567").replace("LAN_ADDRESS=<NAS LAN address>", "LAN_ADDRESS=10.0.0.5"));
  fs.mkdirSync(path.join(dir, "secrets"));
  fs.writeFileSync(path.join(dir, "secrets", "webhook_secret"), "keep-me\n");
  fs.writeFileSync(path.join(dir, "secrets", "app_private_key.pem"), "pem");
  const r = runSetup(dir, quiet);
  const env = readEnv(dir);
  assert.strictEqual(env.APP_ID, "1234567");
  assert.strictEqual(env.LAN_ADDRESS, "10.0.0.5");
  assert.strictEqual(secret(dir, "webhook_secret"), "keep-me");
  assert.deepStrictEqual(r.todo, []);
});

test("as root, the container's secrets go to uid 1000 and the cloud seed and .env to the folder's owner", () => {
  const dir = workdir();
  fs.mkdirSync(path.join(dir, "secrets"));
  fs.writeFileSync(path.join(dir, "secrets", "app_private_key.pem"), "pem");
  const owners = {};
  runSetup(dir, { log: () => {}, isRoot: true, owner: { uid: 1026, gid: 100 }, chown: (p, uid, gid) => { owners[path.relative(dir, p).replace(/\\/g, "/")] = [uid, gid]; } });
  assert.deepStrictEqual(owners["secrets/webhook_secret"], [1000, 1000]);
  assert.deepStrictEqual(owners["secrets/receiver_nkey_seed"], [1000, 1000]);
  assert.deepStrictEqual(owners["secrets/app_private_key.pem"], [1000, 1000]);
  assert.deepStrictEqual(owners["secrets/cloud_seed"], [1026, 100]);
  assert.deepStrictEqual(owners[".env"], [1026, 100]);
});

test("the report never prints a seed or a secret", () => {
  const dir = workdir();
  const lines = [];
  runSetup(dir, { log: (l) => lines.push(l), isRoot: false });
  const out = lines.join("\n");
  assert.doesNotMatch(out, /S[A-Z][A-Z2-7]{56}/, "no seed");
  assert.ok(!out.includes(secret(dir, "webhook_secret")), "no webhook secret");
  assert.ok(!out.includes(readEnv(dir).LAN_UNUSED_PASSWORD), "no LAN password");
  assert.match(out, /secrets\/cloud_seed/, "says where the cloud seed is");
});
