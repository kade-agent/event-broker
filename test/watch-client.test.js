"use strict";
// client/watch-core.js with every effect injected: no network, no real files, no real clock.
const test = require("node:test");
const assert = require("node:assert");
const { resolveSettings, parseArgs, parseEnvFile, formatLine, Fatal } = require("../client/watch-core");

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

// The v2 object of design section 9, with the v1 fields null unless a test sets them.
const msg = (o) => ({
  v: 2, signal: null, delivery: "D1", repo: "stella-rain/app", pr: null, branch: null, event: null, action: null,
  merged: null, draft: null, auto_merge: null, conclusion: null, check: null, mergeable_state: null, sha: null,
  issue: null, label: null, state_reason: null, comment: null, ...o,
});

test("line: pr_merged with branch, 7-character sha and delivery", () => {
  assert.strictEqual(
    formatLine(msg({ signal: "pr_merged", repo: "stella-rain/core", pr: 365, branch: "claude/br1e-worst-minute", sha: "9f2c1e0aaaa", delivery: "1f2e3d" }), false),
    "pr_merged stella-rain/core#365 branch=claude/br1e-worst-minute sha=9f2c1e0 delivery=1f2e3d");
});

test("line: a branch-scope event is <repo>@<branch> and carries no branch= field", () => {
  assert.strictEqual(
    formatLine(msg({ signal: "main_failed", repo: "stella-rain/app", branch: "main", sha: "9f2c1e0", conclusion: "failure",
      check: { name: "test", url: "https://github.com/stella-rain/app/actions/runs/1" }, delivery: "D9" }), false),
    "main_failed stella-rain/app@main sha=9f2c1e0 check=test url=https://github.com/stella-rain/app/actions/runs/1 delivery=D9");
});

test("line: a value with a space is a JSON string", () => {
  assert.strictEqual(
    formatLine(msg({ signal: "ci_failed", repo: "kade-agent/event-broker", pr: 17, branch: "claude/x", sha: "abcdef0123",
      check: { name: "Line endings", url: "https://github.com/kade-agent/event-broker/runs/2" }, delivery: "D2" }), false),
    'ci_failed kade-agent/event-broker#17 branch=claude/x sha=abcdef0 check="Line endings" url=https://github.com/kade-agent/event-broker/runs/2 delivery=D2');
});

test("line: a value with a quote or an equals sign is a JSON string", () => {
  const line = formatLine(msg({ signal: "ci_failed", pr: 1, check: { name: 'a"b', url: "https://x/?q=1" } }), false);
  assert.ok(line.includes('check="a\\"b"'));
  assert.ok(line.includes('url="https://x/?q=1"'));
});

test("line: conclusion= only on an *_other signal that has one", () => {
  assert.ok(formatLine(msg({ signal: "ci_other", pr: 3, conclusion: "cancelled" }), false).includes(" conclusion=cancelled"));
  assert.ok(formatLine(msg({ signal: "merge_other", pr: 3, mergeable_state: "has_hooks", conclusion: "x" }), false).includes(" conclusion=x"));
  assert.ok(!formatLine(msg({ signal: "ci_failed", pr: 3, conclusion: "failure" }), false).includes("conclusion"));
  assert.ok(!formatLine(msg({ signal: "merge_other", pr: 3 }), false).includes("conclusion"));
});

test("line: issue number, label, state_reason, comment author and url", () => {
  assert.strictEqual(formatLine(msg({ signal: "issue_labeled", repo: "a/b", issue: 5, label: "ready", delivery: "D3" }), false),
    "issue_labeled a/b#5 label=ready delivery=D3");
  assert.strictEqual(formatLine(msg({ signal: "issue_closed", repo: "a/b", issue: 5, state_reason: "not_planned", delivery: "D4" }), false),
    "issue_closed a/b#5 state_reason=not_planned delivery=D4");
  assert.strictEqual(formatLine(msg({ signal: "pr_comment", repo: "a/b", pr: 6, branch: "x", comment: { id: 1, author: "kade", url: "https://c/1" }, delivery: "D5" }), false),
    "pr_comment a/b#6 branch=x url=https://c/1 author=kade delivery=D5");
});

test("line: the check url beats the comment url", () => {
  assert.ok(formatLine(msg({ signal: "ci_failed", pr: 1, check: { name: "t", url: "https://check" }, comment: { url: "https://comment" } }), false).includes("url=https://check"));
});

test("line: a null delivery is left out", () => {
  assert.strictEqual(formatLine(msg({ signal: "pr_closed", repo: "a/b", pr: 1, delivery: null }), false), "pr_closed a/b#1");
});

test("line: --json prints the parseable v2 object on one line", () => {
  const m = msg({ signal: "pr_merged", pr: 4, branch: "b", sha: "9f2c1e0aaaa" });
  const line = formatLine(m, true);
  assert.ok(!line.includes("\n"));
  assert.deepStrictEqual(JSON.parse(line), m);
  assert.strictEqual(JSON.parse(line).v, 2);
});
