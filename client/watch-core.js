"use strict";
// The dispatcher's watch client (agent-config docs/event-broker-design.md, section 9): settings,
// the line format and the loop. Every effect (consumer, writer, clock, file system, parent check)
// is injected, so test/watch-client.test.js runs it without a network. client/watch.js wires it.
const path = require("node:path");

// A settings or broker error: the caller prints `BROKER-DOWN <message>` and exits with exitCode.
class Fatal extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const out = { owner: undefined, profile: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--owner" || a === "--profile") {
      if (i + 1 >= argv.length) throw new Fatal(`${a} needs a value`, 2);
      out[a.slice(2)] = argv[++i];
    } else throw new Fatal(`unknown argument ${a}`, 2);
  }
  return out;
}

// KEY=value lines; `#` lines and blank lines skipped; one pair of surrounding quotes stripped.
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const readOrNull = (fs, p) => {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
};

// Each setting from the environment, else from <home>/.claude/dispatcher/broker.env. When the key
// file is missing or empty and EVENT_BROKER_CLOUD_SEED is set, the seed is written to it (mode 600).
// No error text carries the seed.
function resolveSettings({ argv, env, home, fs, platform }) {
  const args = parseArgs(argv);
  const dir = path.join(home, ".claude", "dispatcher");
  const file = parseEnvFile(readOrNull(fs, path.join(dir, "broker.env")) ?? "");
  const get = (k) => (env[k] ? env[k] : file[k] || undefined);

  const url = get("EVENT_BROKER_URL");
  if (!url) throw new Fatal("EVENT_BROKER_URL is not set", 2);
  const owner = (args.owner || get("EVENT_BROKER_OWNER") || "").toLowerCase();
  if (!owner) throw new Fatal("no owner: pass --owner <org> or set EVENT_BROKER_OWNER", 2);

  const keyFile = get("EVENT_BROKER_NKEY_FILE") || path.join(dir, `${owner}.nk`);
  const existing = readOrNull(fs, keyFile);
  if (existing === null || !existing.trim()) {
    const seed = get("EVENT_BROKER_CLOUD_SEED");
    if (!seed) throw new Fatal(`no key: ${keyFile} is missing and EVENT_BROKER_CLOUD_SEED is not set`, 2);
    try {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, `${seed.trim()}\n`, { mode: 0o600 });
      if (platform !== "win32") fs.chmodSync(keyFile, 0o600);
    } catch (e) {
      throw new Fatal(`no key: cannot write ${keyFile} (${e.code || "error"})`, 2);
    }
  }

  return {
    owner, url, keyFile, json: args.json,
    profile: args.profile || "dispatcher",
    pidFile: get("WATCH_PIDFILE") || path.join(dir, `watch-${owner}.pid`),
  };
}

module.exports = { Fatal, parseArgs, parseEnvFile, resolveSettings };
