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
  const out = { owner: undefined, profile: undefined, json: false, window: 30, state: undefined, all: false, alive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--all") out.all = true; // decision 27
    else if (a === "--alive") out.alive = true; // decision 28
    else if (a === "--owner" || a === "--profile" || a === "--window" || a === "--state") {
      if (i + 1 >= argv.length) throw new Fatal(`${a} needs a value`, 2);
      out[a.slice(2)] = argv[++i];
    } else throw new Fatal(`unknown argument ${a}`, 2);
  }
  if (out.state !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(out.state)) throw new Fatal("--state needs <owner>/<repo>", 2);
  if (typeof out.window === "string") {
    if (!/^\d+$/.test(out.window)) throw new Fatal("--window needs a whole number of seconds", 2);
    out.window = Number(out.window);
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

  if (args.state && args.state.split("/")[0].toLowerCase() !== owner) {
    throw new Fatal(`--state ${args.state} is not in ${owner}'s account`, 2);
  }

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
    owner, url, keyFile, json: args.json, window: args.window, state: args.state, all: args.all, alive: args.alive,
    profile: args.profile || "dispatcher",
    pidFile: get("WATCH_PIDFILE") || path.join(dir, `watch-${owner}.pid`),
    ignoreFile: get("WATCH_IGNOREFILE") || path.join(dir, `ignore-${owner}`), // decision 26
  };
}

// One compact line per event: `<signal> <repo>#<n>` (`<repo>@<branch>` when there is no PR or issue),
// then key=value for each non-null field. A value holding a space, a quote or `=` is a JSON string.
const quote = (v) => (/[\s"=]/.test(v) ? JSON.stringify(v) : v);

function formatLine(m, json) {
  if (json) return JSON.stringify(m);
  const n = m.pr ?? m.issue;
  const parts = [`${m.signal} ${m.repo}${n != null ? `#${n}` : `@${m.branch}`}`];
  const fields = [
    ["branch", m.pr != null ? m.branch : null],
    ["sha", m.sha ? String(m.sha).slice(0, 7) : null],
    ["check", m.check && m.check.name],
    ["url", (m.check && m.check.url) || (m.comment && m.comment.url)],
    ["conclusion", String(m.signal).endsWith("_other") ? m.conclusion : null],
    ["red", Array.isArray(m.red) ? (m.red.length ? m.red.join(",") : "-") : null], // decision 20
    ["label", m.label],
    ["state_reason", m.state_reason],
    ["author", m.comment && m.comment.author],
    ["line", m.comment && m.comment.line], // decision 23
    ["delivery", m.delivery ? String(m.delivery).slice(0, 8) : null], // decision 28; --json has it all
  ];
  for (const [k, v] of fields) if (v != null && v !== "") parts.push(`${k}=${quote(String(v))}`);
  return parts.join(" ");
}

// Decision 25: the most urgent entries first; the rest keep first-seen order after them.
const URGENCY = ["pr_merged", "pr_closed", "pr_report", "main_failed", "merge_dirty", "merge_behind", "main_passed"];
const rank = (signal) => { const i = URGENCY.indexOf(signal); return i < 0 ? URGENCY.length : i; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Decision 17: one summary for a window's events. Events with the same signal, target and check
// are one entry, the latest, with count= when there are more. Decision 25: a header line, then one
// entry per line, by urgency (a Monitor cuts a long line). --json: every event, ungrouped.
// Decision 26: ignored is how many of the window's events the ignore file dropped.
function formatSummary(events, json, ignored = 0) {
  if (json) return JSON.stringify({ summary: true, count: events.length, events, ...(ignored ? { ignored } : {}) });
  const groups = new Map();
  for (const m of events) {
    const n = m.pr ?? m.issue;
    const key = `${m.signal} ${m.repo}${n != null ? `#${n}` : `@${m.branch}`} ${m.check ? m.check.name : ""}`;
    const g = groups.get(key);
    if (g) { g.last = m; g.count++; } else groups.set(key, { last: m, count: 1 });
  }
  const entries = [...groups.values()]
    .map((g, i) => ({ g, i, r: rank(g.last.signal) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map(({ g }) => formatLine(g.last, false) + (g.count > 1 ? ` count=${g.count}` : ""));
  const header = `SUMMARY ${plural(events.length, "event", "events")} ${plural(entries.length, "entry", "entries")}`;
  return [header + (ignored ? ` ignored=${ignored}` : ""), ...entries].join("\n");
}

// Decision 26: the dispatcher appends `<ISO time> label <owner>/<repo>#<n> <label>` after each label
// it sets. The keys of the last hour; a missing or unreadable file gives none.
const IGNORE_MS = 3600000;
function ignoreKeys(fs, file, now) {
  const keys = new Set();
  const text = file ? readOrNull(fs, file) : null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\S+) (label \S+#\d+ .+)$/.exec(raw.trim());
    const at = m ? Date.parse(m[1]) : NaN;
    if (!Number.isNaN(at) && now - at <= IGNORE_MS) keys.add(m[2]);
  }
  return keys;
}
const ignoredBy = (keys, m) => m.signal === "issue_labeled" && keys.has(`label ${m.repo}#${m.issue} ${m.label}`);

// Decision 21 (S3): watch.js --state's lines. The red line, then one line per PR snapshot by number,
// null fields left out and values quoted as in an entry. --json: one object. Decision 27: only open
// PRs, with only their failed or pending (null: no conclusion recorded) checks; all = every one.
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const openOnly = (s) => ({ ...s, checks: Object.fromEntries(Object.entries(s.checks || {}).filter(([, v]) => v == null || FAILED.has(v))) });
function formatState({ repo, red, prs }, json, all = false) {
  const shown = all ? prs : prs.filter((s) => s.state === "open").map(openOnly);
  const sorted = [...shown].sort((a, b) => a.pr - b.pr);
  if (json) return [JSON.stringify({ repo, red, prs: sorted })];
  const line = (s) => {
    const checks = Object.entries(s.checks || {}).map(([k, v]) => `${k}:${v}`).join(",");
    const fields = [
      ["state", s.state], ["branch", s.branch], ["sha", s.sha ? String(s.sha).slice(0, 7) : null],
      ["mergeable", s.mergeable_state], ["checks", checks || null], ["review", s.review],
      ["draft", s.draft], ["auto_merge", s.auto_merge], ["last_comment", s.last_comment && s.last_comment.author],
      ["updated_at", s.updated_at],
    ];
    return [`pr ${s.repo}#${s.pr}`, ...fields.filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${quote(String(v))}`)].join(" ");
  };
  return [`STATE ${repo} red=${red.length ? quote(red.join(",")) : "-"}`, ...sorted.map(line)];
}

const SEEN_MAX = 1000; // stream sequences remembered, to ack a redelivery without printing it again
const ALIVE_MS = 600000; // quiet this long -> a consumer info, printed as WATCH-ALIVE with --alive
const DOWN_MS = 120000; // disconnected for longer than this -> BROKER-DOWN
const TICK_MS = 5000; // parent, disconnect and heartbeat checks
const CONNECT_RETRY_MS = 5000;
const PULL_RETRY_MS = 1000;

// The watch. Resolves to the exit code: 0 a quiet end, 1 BROKER-DOWN, 2 settings, 3 a failed write.
// deps: settings {owner, profile, json, window (s, 0 = a line per event), pidFile}; connect(hooks) -> conn {streamSubjects(), pending(),
// next() -> {seq, data, ack()} | null, close()}, with hooks {disconnected(), reconnected()};
// write(line) (rejects on failure); now(); sleep(ms); every(ms, fn) -> cancel; checkParent() (throws
// when the parent is gone); fs; pid; signal (an AbortSignal: SIGINT, SIGTERM, SIGHUP).
async function run(d) {
  const { owner, profile, json, pidFile } = d.settings;
  const windowMs = (d.settings.window ?? 30) * 1000;
  let ended = false;
  let code = 0;
  let conn = null;
  let armed = false;
  let lastLine = 0;
  let lastProbe = 0; // decision 28: the consumer info runs without --alive too, as the health probe
  let disconnectedAt = null;
  let infoFails = 0;
  let aliveBusy = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const seen = new Set();
  let batch = []; // the open window's messages, acked after their SUMMARY is written
  let batchStart = null;
  let backlog = 0; // messages of the start backlog still to read; at 0 it is one summary at once
  let flushing = null;

  // Stops everything; the optional line (BROKER-DOWN) is written before the run resolves.
  const end = (exitCode, line) => {
    if (ended) return;
    ended = true;
    code = exitCode;
    (async () => {
      if (line) await d.write(line).catch(() => {});
      finish(code);
    })();
  };
  // A line printed: false when stdout failed (the run ends with 3, and nothing is acked).
  const emit = async (line) => {
    if (ended) return false;
    try { await d.write(line); } catch { end(3); return false; }
    lastLine = d.now();
    return true;
  };
  const down = (e) => end(1, `BROKER-DOWN ${e && e.message ? e.message : e}`);
  const superseded = () => {
    try {
      const text = d.fs.readFileSync(pidFile, "utf8").trim();
      return text !== "" && text !== String(d.pid);
    } catch { return false; }
  };
  const ack = async (m) => { try { await m.ack(); } catch { /* it comes back after the ack wait */ } };
  const remember = (seq) => {
    seen.add(seq);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  };
  // Writes the open window as one summary (one write), then acks it; a window of only ignored
  // events (decision 26) prints nothing and is acked. One flush at a time (the loop and the tick).
  const flush = () => (flushing ??= (async () => {
    const items = batch;
    batch = [];
    batchStart = null;
    if (!items.length) return;
    const keys = ignoreKeys(d.fs, d.settings.ignoreFile, d.now());
    const shown = items.filter((m) => !ignoredBy(keys, m.data));
    if (shown.length && !(await emit(formatSummary(shown.map((m) => m.data), json, items.length - shown.length)))) return;
    for (const m of items) await ack(m);
  })().finally(() => { flushing = null; }));
  const windowDue = () => batch.length > 0 && d.now() - batchStart >= windowMs;

  const hooks = {
    disconnected: () => { if (disconnectedAt == null) disconnectedAt = d.now(); },
    reconnected: () => { disconnectedAt = null; },
  };
  const status = (n) => `${owner} consumer=${profile} unprocessed=${n}`;

  async function tick() {
    if (ended) return;
    try { d.checkParent(); } catch { end(0); return; }
    if (disconnectedAt != null && d.now() - disconnectedAt > DOWN_MS) { down(new Error("disconnected for over 120 s")); return; }
    if (windowDue()) await flush();
    if (!armed || aliveBusy || d.now() - Math.max(lastLine, lastProbe) < ALIVE_MS) return;
    aliveBusy = true;
    try {
      const n = await conn.pending();
      infoFails = 0;
      lastProbe = d.now();
      if (d.settings.alive) await emit(`WATCH-ALIVE ${status(n)}`);
    } catch (e) {
      if (++infoFails >= 2) down(e);
    } finally { aliveBusy = false; }
  }

  async function connectTwice() {
    for (let attempt = 1; ; attempt++) {
      try { return await d.connect(hooks); } catch (e) {
        if (attempt >= 2) { down(e); return null; }
        await d.sleep(CONNECT_RETRY_MS);
      }
    }
  }

  async function main() {
    try {
      d.fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      d.fs.writeFileSync(pidFile, `${d.pid}\n`);
    } catch (e) { end(2, `BROKER-DOWN cannot write the pidfile ${pidFile} (${e.code || "error"})`); return; }
    if (superseded()) { end(0); return; }

    conn = await connectTwice();
    if (!conn) return;
    if (ended) { await conn.close().catch(() => {}); return; } // run() has already passed its own close

    const subjects = await conn.streamSubjects();
    if (subjects.length !== 1 || subjects[0] !== `ev.${owner}.>`) { end(1, `BROKER-DOWN key is for another account (want ${owner})`); return; }
    const pending = await conn.pending();
    if (superseded()) { end(0); return; }
    if (!(await emit(`WATCH-ARMED ${status(pending)}`))) return;
    armed = true;
    backlog = pending;

    let fails = 0;
    while (!ended) {
      if (superseded()) { end(0); return; }
      let m;
      try { m = await conn.next(); fails = 0; } catch (e) {
        if (ended) return;
        if (++fails >= 2) { down(e); return; }
        await d.sleep(PULL_RETRY_MS);
        continue;
      }
      if (!m || ended) continue;
      if (seen.has(m.seq)) { await ack(m); continue; }
      // Anything without a signal and a repo cannot be a line: drop it, or it would come back forever.
      const valid = m.data && m.data.signal && m.data.repo;
      if (windowMs === 0) {
        const ignored = valid && ignoredBy(ignoreKeys(d.fs, d.settings.ignoreFile, d.now()), m.data);
        if (valid && !ignored && !(await emit(formatLine(m.data, json)))) return;
        remember(m.seq);
        await ack(m);
        continue;
      }
      remember(m.seq);
      if (valid) {
        if (batchStart == null) batchStart = d.now();
        batch.push(m);
      } else await ack(m);
      if (backlog > 0 && --backlog === 0) await flush();
      else if (windowDue()) await flush();
    }
  }

  const stopTick = d.every(TICK_MS, tick);
  if (d.signal.aborted) end(0);
  else d.signal.addEventListener("abort", () => end(0), { once: true });
  main().catch((e) => down(e));

  await done;
  stopTick();
  if (conn) await conn.close().catch(() => {});
  return code;
}

module.exports = { Fatal, parseArgs, parseEnvFile, resolveSettings, formatLine, formatSummary, formatState, run };
