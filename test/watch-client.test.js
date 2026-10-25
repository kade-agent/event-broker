"use strict";
// client/watch-core.js with every effect injected: no network, no real files, no real clock.
const test = require("node:test");
const assert = require("node:assert");
const { resolveSettings, parseArgs, parseEnvFile, Fatal } = require("../client/watch-core");

const HOME = "/home/u";
const BROKER_ENV = `${HOME}/.claude/dispatcher/broker.env`;

// An in-memory fs: files is path -> text; writes and chmods are recorded.
function fakeFs(files = {}) {
  const fs = {
    files: { ...files }, writes: [], dirs: [],
    readFileSync(p) {
      if (!(p in fs.files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return fs.files[p];
    },
    mkdirSync(p, o) { fs.dirs.push([p, o]); },
    writeFileSync(p, text, o) { fs.files[p] = text; fs.writes.push([p, text, o]); },
    chmodSync(p, mode) { fs.writes.push([p, "chmod", mode]); },
  };
  return fs;
}
const resolve = (over = {}) => resolveSettings({ argv: ["--owner", "kade-agent"], env: { EVENT_BROKER_URL: "nats://lan:4222" }, home: HOME, fs: fakeFs({ [`${HOME}/.claude/dispatcher/kade-agent.nk`]: "SUASEED\n" }), platform: "linux", ...over });
const fatal = (code, re) => (e) => e instanceof Fatal && e.exitCode === code && re.test(e.message);

test("arguments: --owner, --profile and --json", () => {
  assert.deepStrictEqual(parseArgs(["--owner", "a", "--profile", "all", "--json"]), { owner: "a", profile: "all", json: true });
  assert.deepStrictEqual(parseArgs([]), { owner: undefined, profile: undefined, json: false });
  assert.throws(() => parseArgs(["--nope"]), fatal(2, /--nope/));
  assert.throws(() => parseArgs(["--owner"]), fatal(2, /--owner/));
});

test("broker.env: KEY=value lines, comments and blanks skipped, one pair of quotes stripped", () => {
  const text = ["# a comment", "", "A=1", "B = two words ", 'C="quoted"', "D='single'", 'E=""x""', "F=a=b", "no equals"].join("\n");
  assert.deepStrictEqual(parseEnvFile(text), { A: "1", B: "two words", C: "quoted", D: "single", E: '"x"', F: "a=b" });
});

test("settings: the environment's URL wins over the file's; with the environment unset the file's is used", () => {
  const files = { [BROKER_ENV]: "EVENT_BROKER_URL=wss://file\n", [`${HOME}/.claude/dispatcher/kade-agent.nk`]: "S\n" };
  assert.strictEqual(resolve({ env: { EVENT_BROKER_URL: "nats://env" }, fs: fakeFs(files) }).url, "nats://env");
  assert.strictEqual(resolve({ env: {}, fs: fakeFs(files) }).url, "wss://file");
});

test("settings: no URL -> exit 2 naming EVENT_BROKER_URL", () => {
  assert.throws(() => resolve({ env: {} }), fatal(2, /EVENT_BROKER_URL/));
});

test("settings: --owner wins over EVENT_BROKER_OWNER; the owner may come from the environment or the file; none -> exit 2 naming --owner", () => {
  const env = { EVENT_BROKER_URL: "u", EVENT_BROKER_OWNER: "b" };
  const fsFor = (o) => fakeFs({ [`${HOME}/.claude/dispatcher/${o}.nk`]: "S\n" });
  assert.strictEqual(resolve({ argv: ["--owner", "a"], env, fs: fsFor("a") }).owner, "a");
  assert.strictEqual(resolve({ argv: [], env, fs: fsFor("b") }).owner, "b");
  assert.strictEqual(resolve({ argv: [], env: { EVENT_BROKER_URL: "u" }, fs: fakeFs({ [BROKER_ENV]: "EVENT_BROKER_OWNER=c\n", [`${HOME}/.claude/dispatcher/c.nk`]: "S\n" }) }).owner, "c");
  assert.throws(() => resolve({ argv: [], env: { EVENT_BROKER_URL: "u" } }), fatal(2, /--owner/));
});

test("settings: the profile defaults to dispatcher; --json is carried", () => {
  const s = resolve({ argv: ["--owner", "kade-agent", "--json"] });
  assert.strictEqual(s.profile, "dispatcher");
  assert.strictEqual(s.json, true);
  assert.strictEqual(resolve({ argv: ["--owner", "kade-agent", "--profile", "all"] }).profile, "all");
});

test("key: the default path is <home>/.claude/dispatcher/<owner>.nk; EVENT_BROKER_NKEY_FILE overrides it", () => {
  assert.strictEqual(resolve().keyFile, `${HOME}/.claude/dispatcher/kade-agent.nk`);
  const fs = fakeFs({ "/k/seed": "S\n" });
  assert.strictEqual(resolve({ env: { EVENT_BROKER_URL: "u", EVENT_BROKER_NKEY_FILE: "/k/seed" }, fs }).keyFile, "/k/seed");
});

test("key: a missing file plus a seed writes the seed and a newline at mode 600 (chmod skipped on win32)", () => {
  const fs = fakeFs();
  const env = { EVENT_BROKER_URL: "u", EVENT_BROKER_CLOUD_SEED: "SUATHESEED" };
  const s = resolve({ env, fs });
  const path = `${HOME}/.claude/dispatcher/kade-agent.nk`;
  assert.strictEqual(s.keyFile, path);
  assert.strictEqual(fs.files[path], "SUATHESEED\n");
  assert.deepStrictEqual(fs.dirs, [[`${HOME}/.claude/dispatcher`, { recursive: true }]]);
  assert.strictEqual(fs.writes[0][2].mode, 0o600);
  assert.ok(fs.writes.some((w) => w[1] === "chmod" && w[2] === 0o600));
  const w = fakeFs();
  resolve({ env, fs: w, platform: "win32" });
  assert.ok(!w.writes.some((x) => x[1] === "chmod"));
});

test("key: an empty file counts as missing; an existing key is left alone", () => {
  const path = `${HOME}/.claude/dispatcher/kade-agent.nk`;
  const env = { EVENT_BROKER_URL: "u", EVENT_BROKER_CLOUD_SEED: "NEW" };
  const empty = fakeFs({ [path]: " \n" });
  resolve({ env, fs: empty });
  assert.strictEqual(empty.files[path], "NEW\n");
  const kept = fakeFs({ [path]: "OLD\n" });
  resolve({ env, fs: kept });
  assert.strictEqual(kept.files[path], "OLD\n");
  assert.deepStrictEqual(kept.writes, []);
});

test("key: missing file and no seed -> exit 2 naming the path; the seed never appears in an error", () => {
  assert.throws(() => resolve({ fs: fakeFs() }), fatal(2, /\/home\/u\/\.claude\/dispatcher\/kade-agent\.nk/));
  const fs = fakeFs();
  fs.writeFileSync = () => { throw new Error("EACCES writing SUATHESEED"); };
  try { resolve({ env: { EVENT_BROKER_URL: "u", EVENT_BROKER_CLOUD_SEED: "SUATHESEED" }, fs }); assert.fail("must throw"); } catch (e) {
    assert.ok(e instanceof Fatal && e.exitCode === 2);
    assert.ok(!e.message.includes("SUATHESEED"));
  }
});

test("pidfile: WATCH_PIDFILE, else <home>/.claude/dispatcher/watch-<owner>.pid", () => {
  assert.strictEqual(resolve().pidFile, `${HOME}/.claude/dispatcher/watch-kade-agent.pid`);
  assert.strictEqual(resolve({ env: { EVENT_BROKER_URL: "u", WATCH_PIDFILE: "/p/x.pid" } }).pidFile, "/p/x.pid");
});
