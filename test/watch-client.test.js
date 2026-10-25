"use strict";
// client/watch-core.js with every effect injected: no network, no real files, no real clock.
const test = require("node:test");
const assert = require("node:assert");
const { resolveSettings, parseArgs, parseEnvFile, formatLine, run, Fatal } = require("../client/watch-core");

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

test("arguments: --owner, --profile, --json and --window", () => {
  assert.deepStrictEqual(parseArgs(["--owner", "a", "--profile", "all", "--json", "--window", "0"]), { owner: "a", profile: "all", json: true, window: 0 });
  assert.deepStrictEqual(parseArgs([]), { owner: undefined, profile: undefined, json: false, window: 30 });
  assert.throws(() => parseArgs(["--window", "x"]), fatal(2, /--window/));
  assert.throws(() => parseArgs(["--window", "-1"]), fatal(2, /--window/));
  assert.throws(() => parseArgs(["--window"]), fatal(2, /--window/));
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

test("settings: the profile defaults to dispatcher; --json and --window are carried", () => {
  const s = resolve({ argv: ["--owner", "kade-agent", "--json"] });
  assert.strictEqual(s.profile, "dispatcher");
  assert.strictEqual(s.json, true);
  assert.strictEqual(s.window, 30);
  assert.strictEqual(resolve({ argv: ["--owner", "kade-agent", "--window", "0"] }).window, 0);
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

// ---- the loop, with a fake connection, writer, clock and parent check ----

const ev = (seq, over = {}) => ({ seq, data: msg({ signal: "pr_merged", repo: "a/b", pr: seq, delivery: `D${seq}`, ...over }), ack: null });

// queue items: a message, null (a quiet minute) or an Error (a failed pull). When it runs dry the
// harness aborts the run, and the pull never resolves (the real one would block for a minute).
// window 0: one line per event, as the tests before decision 17 expect; the summary tests pass 30.
function harness({ queue = [], subjects = ["ev.kade-agent.>"], pending = 3, owner = "kade-agent", writeFails = false, connectFails = 0, pidText = "4242\n", window = 0 } = {}) {
  const h = { out: [], calls: [], clock: 0, ticks: [], queue: [...queue], connects: 0, nexts: 0, sleeps: [] };
  const ac = new AbortController();
  const fs = fakeFs({ "/p/watch.pid": pidText });
  h.fs = fs;
  h.ac = ac;
  const conn = {
    streamSubjects: async () => subjects,
    pending: async () => pending,
    next: async () => {
      h.nexts++;
      if (h.queue.length === 0) { ac.abort(); return new Promise(() => {}); }
      const item = h.queue.shift();
      if (item instanceof Error) throw item;
      return item;
    },
    close: async () => { h.calls.push("close"); },
  };
  h.conn = conn;
  h.deps = {
    settings: { owner, profile: "dispatcher", json: false, window, pidFile: "/p/watch.pid" },
    connect: async (hooks) => {
      h.hooks = hooks;
      if (h.connects++ < connectFails) throw new Error("connect refused");
      return conn;
    },
    write: async (line) => { h.calls.push(`write:${line.split(" ")[0]}`); if (writeFails) throw new Error("EPIPE"); h.out.push(line); },
    now: () => h.clock,
    sleep: async (ms) => { h.sleeps.push(ms); },
    every: (ms, fn) => { h.ticks.push({ ms, fn }); return () => {}; },
    checkParent: () => {},
    fs, pid: 4242, signal: ac.signal,
  };
  const wrap = (m) => m && !(m instanceof Error) && { ...m, ack: async () => { h.calls.push(`ack:${m.seq}`); } };
  h.queue = h.queue.map((m) => (m instanceof Error || m === null ? m : wrap(m)));
  return h;
}

test("loop: the first line is WATCH-ARMED with the unprocessed count; the pid is written first", async () => {
  const h = harness({ pending: 3 });
  assert.strictEqual(await run(h.deps), 0);
  assert.strictEqual(h.out[0], "WATCH-ARMED kade-agent consumer=dispatcher unprocessed=3");
  assert.strictEqual(h.fs.files["/p/watch.pid"], "4242\n");
});

test("loop: stream subjects of another account -> BROKER-DOWN, exit 1, no pull", async () => {
  const h = harness({ subjects: ["ev.stella-rain.>"] });
  assert.strictEqual(await run(h.deps), 1);
  assert.deepStrictEqual(h.out, ["BROKER-DOWN key is for another account (want kade-agent)"]);
  assert.strictEqual(h.nexts, 0);
});

test("loop: a stream with more than the one subject is another account too", async () => {
  const h = harness({ subjects: ["ev.kade-agent.>", "ev.stella-rain.>"] });
  assert.strictEqual(await run(h.deps), 1);
  assert.match(h.out[0], /^BROKER-DOWN key is for another account/);
});

test("loop: the line is written before the message is acked", async () => {
  const h = harness({ queue: [ev(1)] });
  await run(h.deps);
  assert.deepStrictEqual(h.calls.filter((c) => c !== "close"), ["write:WATCH-ARMED", "write:pr_merged", "ack:1"]);
  assert.strictEqual(h.out[1], "pr_merged a/b#1 delivery=D1");
});

test("loop: --json prints the object", async () => {
  const h = harness({ queue: [ev(1)] });
  h.deps.settings.json = true;
  await run(h.deps);
  assert.strictEqual(JSON.parse(h.out[1]).signal, "pr_merged");
});

test("loop: a failing write is not acked and exits 3", async () => {
  const h = harness({ queue: [ev(1)], writeFails: true });
  assert.strictEqual(await run(h.deps), 3);
  assert.ok(!h.calls.some((c) => c.startsWith("ack")));
});

test("loop: a failing write of a message line after ARMED exits 3 without acking", async () => {
  const h = harness({ queue: [ev(1)] });
  let n = 0;
  const write = h.deps.write;
  h.deps.write = async (l) => { if (++n === 2) throw new Error("EPIPE"); return write(l); };
  assert.strictEqual(await run(h.deps), 3);
  assert.deepStrictEqual(h.calls.filter((c) => c.startsWith("ack")), []);
});

test("loop: the same stream sequence twice is one line and two acks", async () => {
  const h = harness({ queue: [ev(7), ev(7)] });
  await run(h.deps);
  assert.strictEqual(h.out.length, 2); // ARMED and one line
  assert.deepStrictEqual(h.calls.filter((c) => c.startsWith("ack")), ["ack:7", "ack:7"]);
});

test("loop: only the last 1000 sequences are remembered", async () => {
  const queue = [];
  for (let i = 1; i <= 1001; i++) queue.push(ev(i));
  queue.push(ev(1));
  const h = harness({ queue });
  await run(h.deps);
  assert.strictEqual(h.out.length, 1 + 1001 + 1); // sequence 1 fell out of the window
});

test("loop: a message that is not JSON is acked and dropped", async () => {
  const h = harness({ queue: [{ seq: 1, data: null }] });
  await run(h.deps);
  assert.strictEqual(h.out.length, 1);
  assert.deepStrictEqual(h.calls.filter((c) => c.startsWith("ack")), ["ack:1"]);
});

const tickAt = async (h, ms) => { h.clock = ms; for (const t of h.ticks) await t.fn(); };
// A run that stays open: the pull blocks, and the test drives the ticks itself.
async function open(h) {
  h.queue = [];
  h.conn.next = async () => { h.nexts++; return new Promise(() => {}); };
  const p = run(h.deps);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return p;
}

test("alive: 600 s without a line prints WATCH-ALIVE from a fresh consumer info; 300 s prints nothing", async () => {
  const h = harness({ pending: 5 });
  const p = open(h);
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.ticks[0].ms, 5000);
  h.conn.pending = async () => 9;
  await tickAt(h, 300000);
  assert.strictEqual(h.out.length, 1);
  await tickAt(h, 600000);
  assert.strictEqual(h.out.length, 2);
  assert.strictEqual(h.out[1], "WATCH-ALIVE kade-agent consumer=dispatcher unprocessed=9");
  await tickAt(h, 660000); // the alive line counts as a line printed
  assert.strictEqual(h.out.length, 2);
  h.ac.abort();
  assert.strictEqual(await p, 0);
});

test("alive: two failed consumer infos in a row -> BROKER-DOWN, exit 1", async () => {
  const h = harness();
  const p = open(h);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  h.conn.pending = async () => { throw new Error("info failed"); };
  await tickAt(h, 600000);
  assert.strictEqual(h.out.length, 1);
  await tickAt(h, 605000);
  assert.strictEqual(await p, 1);
  assert.strictEqual(h.out.at(-1), "BROKER-DOWN info failed");
});

test("down: two failing pulls in a row -> BROKER-DOWN, exit 1", async () => {
  const h = harness({ queue: [new Error("pull failed"), new Error("pull failed")] });
  assert.strictEqual(await run(h.deps), 1);
  assert.strictEqual(h.out.at(-1), "BROKER-DOWN pull failed");
});

test("down: one failing pull then a message -> the line, no BROKER-DOWN", async () => {
  const h = harness({ queue: [new Error("pull failed"), ev(2), new Error("again")] });
  assert.strictEqual(await run(h.deps), 0);
  assert.ok(h.out.some((l) => l.startsWith("pr_merged ")));
  assert.ok(!h.out.some((l) => l.startsWith("BROKER-DOWN")));
});

test("down: a quiet minute (null) resets the failure count", async () => {
  const h = harness({ queue: [new Error("e"), null, new Error("e")] });
  assert.strictEqual(await run(h.deps), 0);
  assert.ok(!h.out.some((l) => l.startsWith("BROKER-DOWN")));
});

test("down: two failed connects 5 s apart -> BROKER-DOWN, exit 1; one failed connect still arms", async () => {
  const h = harness({ connectFails: 2 });
  assert.strictEqual(await run(h.deps), 1);
  assert.deepStrictEqual(h.out, ["BROKER-DOWN connect refused"]);
  assert.deepStrictEqual(h.sleeps, [5000]);
  const ok = harness({ connectFails: 1 });
  assert.strictEqual(await run(ok.deps), 0);
  assert.match(ok.out[0], /^WATCH-ARMED/);
});

test("down: a disconnect lasting over 120 s -> BROKER-DOWN, exit 1; a reconnect clears it", async () => {
  const h = harness();
  const p = open(h);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  h.clock = 1000;
  h.hooks.disconnected();
  await tickAt(h, 100000);
  assert.strictEqual(h.out.length, 1);
  h.hooks.reconnected();
  await tickAt(h, 200000);
  assert.strictEqual(h.out.length, 1);
  h.clock = 210000;
  h.hooks.disconnected();
  await tickAt(h, 331000);
  assert.strictEqual(await p, 1);
  assert.match(h.out.at(-1), /^BROKER-DOWN .*120 s/);
});

test("ending: the pidfile holding another pid -> exit 0, nothing more printed, no pull", async () => {
  const h = harness({ queue: [ev(1)] });
  // A newer watch takes the pidfile: our own write is lost and the file holds its pid.
  h.fs.writeFileSync = () => {};
  h.fs.readFileSync = () => "9999\n";
  assert.strictEqual(await run(h.deps), 0);
  assert.strictEqual(h.nexts, 0);
  assert.deepStrictEqual(h.out, []);
});

test("ending: the parent check throwing -> exit 0, no line", async () => {
  const h = harness();
  const p = open(h);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  h.deps.checkParent = () => { throw new Error("ESRCH"); };
  await tickAt(h, 5000);
  assert.strictEqual(await p, 0);
  assert.strictEqual(h.out.length, 1);
  assert.ok(h.calls.includes("close"));
});

test("ending: a signal closes the connection and exits 0; a blocked pull does not hold it", async () => {
  const h = harness();
  const p = open(h);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  h.ac.abort();
  assert.strictEqual(await p, 0);
  assert.ok(h.calls.includes("close"));
});

test("the seed never appears in the output of a failed run", async () => {
  const h = harness({ connectFails: 2 });
  await run(h.deps);
  assert.ok(!h.out.join("\n").includes("SUA"));
});

test("ending: a connect that finishes after the run ended is closed", async () => {
  const h = harness();
  let release;
  const late = new Promise((r) => { release = r; });
  h.deps.connect = async () => { await late; return h.conn; };
  const p = run(h.deps);
  h.ac.abort();
  assert.strictEqual(await p, 0);
  release();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(h.calls.includes("close"));
  assert.strictEqual(h.out.length, 0);
});

// ---- decision 17: the 30 s summary ----

const { formatSummary } = require("../client/watch-core");

test("summary line: entries in first-seen order, repeats of signal+target+check are the latest with count=", () => {
  const a = msg({ signal: "main_failed", repo: "a/b", branch: "main", check: { name: "Rust", url: null }, delivery: "D1" });
  const b = msg({ signal: "pr_merged", repo: "a/b", pr: 3, delivery: "D2" });
  const a2 = { ...a, delivery: "D3" };
  const c = msg({ signal: "main_failed", repo: "a/b", branch: "main", check: { name: "Lint", url: null }, delivery: "D4" });
  assert.strictEqual(formatSummary([a, b, a2, c], false),
    "SUMMARY 4 events | main_failed a/b@main check=Rust delivery=D3 count=2 | pr_merged a/b#3 delivery=D2 | main_failed a/b@main check=Lint delivery=D4");
  assert.strictEqual(formatSummary([b], false), "SUMMARY 1 event | pr_merged a/b#3 delivery=D2");
});

test("summary line: --json is one object with every event, ungrouped", () => {
  const b = msg({ signal: "pr_merged", repo: "a/b", pr: 3 });
  assert.deepStrictEqual(JSON.parse(formatSummary([b, b], true)), { summary: true, count: 2, events: [b, b] });
});

// A run whose pull hands out the queue, then blocks; the test drives the clock and the ticks.
async function summaryRun(h, items) {
  const queue = items.map((m) => ({ ...m, ack: async () => { h.calls.push(`ack:${m.seq}`); } }));
  h.conn.next = async () => { h.nexts++; return queue.length ? queue.shift() : new Promise(() => {}); };
  const done = run(h.deps);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return { done };
}

test("summary: events of one window are one line after 30 s, acked after it; nothing before", async () => {
  const h = harness({ pending: 0, window: 30 });
  const { done: p } = await summaryRun(h, [ev(1), ev(2)]);
  await tickAt(h, 29000);
  assert.deepStrictEqual(h.out, ["WATCH-ARMED kade-agent consumer=dispatcher unprocessed=0"]);
  assert.ok(!h.calls.some((c) => c.startsWith("ack")));
  await tickAt(h, 30000);
  assert.strictEqual(h.out[1], "SUMMARY 2 events | pr_merged a/b#1 delivery=D1 | pr_merged a/b#2 delivery=D2");
  assert.deepStrictEqual(h.calls.filter((c) => c !== "close").slice(-3), ["write:SUMMARY", "ack:1", "ack:2"]);
  h.ac.abort();
  assert.strictEqual(await p, 0);
});

test("summary: the window starts at its first event, not at the start of the watch", async () => {
  const h = harness({ pending: 0, window: 30 });
  h.clock = 50000;
  const { done: p } = await summaryRun(h, [ev(1)]);
  await tickAt(h, 75000);
  assert.strictEqual(h.out.length, 1);
  await tickAt(h, 80000);
  assert.match(h.out[1], /^SUMMARY 1 event \| pr_merged a\/b#1/);
  h.ac.abort();
  await p;
});

test("summary: the backlog counted at start is one summary as soon as it is read", async () => {
  const h = harness({ pending: 2, window: 30 });
  const { done: p } = await summaryRun(h, [ev(1), ev(2), ev(3)]);
  assert.strictEqual(h.out[1], "SUMMARY 2 events | pr_merged a/b#1 delivery=D1 | pr_merged a/b#2 delivery=D2");
  assert.strictEqual(h.out.length, 2); // event 3 waits for its own window
  await tickAt(h, 30000);
  assert.strictEqual(h.out[2], "SUMMARY 1 event | pr_merged a/b#3 delivery=D3");
  h.ac.abort();
  await p;
});

test("summary: a watch that ends with a window open prints and acks nothing of it", async () => {
  const h = harness({ pending: 0, window: 30 });
  const { done: p } = await summaryRun(h, [ev(1)]);
  h.ac.abort();
  assert.strictEqual(await p, 0);
  assert.strictEqual(h.out.length, 1);
  assert.ok(!h.calls.some((c) => c.startsWith("ack")));
});

test("summary: a failing summary write exits 3 and acks nothing", async () => {
  const h = harness({ pending: 0, window: 30 });
  const write = h.deps.write;
  h.deps.write = async (l) => { if (l.startsWith("SUMMARY")) throw new Error("EPIPE"); return write(l); };
  const { done: p } = await summaryRun(h, [ev(1)]);
  await tickAt(h, 30000);
  assert.strictEqual(await p, 3);
  assert.ok(!h.calls.some((c) => c.startsWith("ack")));
});
