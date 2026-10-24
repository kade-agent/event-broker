"use strict";
// Sets up a deploy folder on the NAS (README, "Deploying"): .env from .env.example, both NKey pairs
// with the public keys always derived from their seeds, the webhook secret, the LAN password, and
// file owners the containers can read. Safe to run again: it fixes what is wrong and keeps the rest.
// Run on the NAS: docker compose run --rm setup
// It never prints a seed or a secret.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { nkeys } = require("@nats-io/transport-node");

const CONTAINER = { uid: 1000, gid: 1000 }; // the image's "node" user
const enc = new TextEncoder();
const dec = new TextDecoder();

const placeholder = (v) => v == null || v === "" || /^<.*>$/.test(v);

// The public key of a user seed ("SU…"), or null when it is not one.
function publicOf(seed) {
  if (typeof seed !== "string" || !seed.startsWith("SU")) return null;
  try {
    const pub = nkeys.fromSeed(enc.encode(seed)).getPublicKey();
    return pub.startsWith("U") ? pub : null;
  } catch { return null; }
}

function readEnv(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r/g, "").split("\n") : null;
}

function runSetup(dir, { log = console.log, isRoot = process.getuid ? process.getuid() === 0 : false,
  chown = fs.chownSync, owner = null } = {}) {
  const changed = [];
  const todo = [];
  const envFile = path.join(dir, ".env");
  const secrets = path.join(dir, "secrets");
  const at = (name) => path.join(secrets, name);
  const readSecret = (name) => (fs.existsSync(at(name)) ? fs.readFileSync(at(name), "utf8").trim() : "");
  const writeSecret = (name, value) => fs.writeFileSync(at(name), value + "\n", { mode: 0o600 });

  let lines = readEnv(envFile);
  if (!lines) {
    lines = readEnv(path.join(dir, ".env.example")) || [];
    changed.push(".env");
  }
  const get = (key) => {
    const l = lines.find((x) => x.startsWith(key + "="));
    return l === undefined ? undefined : l.slice(key.length + 1).trim();
  };
  const set = (key, value) => {
    if (get(key) === value) return;
    const i = lines.findIndex((x) => x.startsWith(key + "="));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.splice(lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
    changed.push(key);
  };

  fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });

  if (!readSecret("webhook_secret")) {
    writeSecret("webhook_secret", crypto.randomBytes(32).toString("hex"));
    changed.push("secrets/webhook_secret");
  }

  // Each pair: keep a valid seed file; else take a seed pasted into .env by mistake; else make one.
  for (const [file, key] of [["receiver_nkey_seed", "RECEIVER_NKEY"], ["cloud_seed", "CLOUD_NKEY"]]) {
    let seed = readSecret(file);
    if (!publicOf(seed)) {
      const pasted = get(key);
      seed = publicOf(pasted) ? pasted : dec.decode(nkeys.createUser().getSeed());
      writeSecret(file, seed);
      changed.push(`secrets/${file}`);
    }
    set(key, publicOf(seed));
  }

  if (placeholder(get("LAN_UNUSED_PASSWORD"))) set("LAN_UNUSED_PASSWORD", crypto.randomBytes(24).toString("hex"));
  // compose reads every .env value for every service, so a "<…>" left here would break even this
  // command's next run; empty makes compose use its default until Kade fills it in.
  for (const key of ["APP_ID", "LAN_ADDRESS"]) {
    if (!placeholder(get(key))) continue;
    set(key, "");
    todo.push(key);
  }
  if (!fs.existsSync(at("app_private_key.pem"))) todo.push("secrets/app_private_key.pem");

  if (changed.length) fs.writeFileSync(envFile, lines.join("\n"), { mode: 0o600 });

  // Owners: the container reads its three secrets as uid 1000; the person deploying reads the rest.
  const me = owner || (() => { const s = fs.statSync(dir); return { uid: s.uid, gid: s.gid }; })();
  const files = [
    [at("webhook_secret"), CONTAINER], [at("receiver_nkey_seed"), CONTAINER], [at("app_private_key.pem"), CONTAINER],
    [at("cloud_seed"), me], [envFile, me],
  ];
  for (const [file, who] of files) {
    if (!fs.existsSync(file)) continue;
    fs.chmodSync(file, 0o600);
    if (isRoot) chown(file, who.uid, who.gid);
  }
  if (isRoot) chown(secrets, me.uid, me.gid);

  log(changed.length ? `Changed: ${changed.join(", ")}` : "Nothing to change: the folder is set up.");
  log("The cloud environment's EVENT_BROKER_CLOUD_SEED is the line in secrets/cloud_seed (it is never mounted into a container).");
  if (todo.length) log(`Still to do by hand: ${todo.join(", ")} (README, "Deploying").`);
  else log("Next: docker compose up -d");
  if (!isRoot) log("Not run as root: file owners were left as they are (docker compose run --rm setup runs as root).");
  return { changed, todo };
}

if (require.main === module) runSetup(path.resolve(process.argv[2] || "."));

module.exports = { runSetup, publicOf };
