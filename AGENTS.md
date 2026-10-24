# kade-agent/event-broker

A small Node service on Kade's NAS. GitHub sends webhook deliveries to `POST /github`. The service
checks each delivery's HMAC signature and turns it into one JSON line. It stores the line and
streams it to subscribers on `GET /events` (SSE, bearer token, `Last-Event-ID` replay). Its only
client is the dispatcher's PR watch, described in `agent-skills/dispatcher/references/pr-watch.md`
in kade-agent/agent-config. Keep the event format in step with that file.

The global rules (`~/.claude/AGENTS.md`) and the `repo-workflow` skill apply. Nothing here
overrides them.

## Layout

| Path | What |
|---|---|
| `src/verify.js` | `X-Hub-Signature-256` check, constant time |
| `src/normalize.js` | GitHub event to `{repo, pr, branch, event, action, merged, conclusion, sha}`, or `null` to drop it |
| `src/store.js` | Append-only JSONL in `DATA_DIR`; ids only increase, kept for the last 5000 events or 7 days |
| `src/server.js` | `node:http` server: `POST /github`, `GET /events`, `GET /healthz` |
| `test/` | `node --test` tests, one file per module |
| `Dockerfile`, `compose.yaml` | How it runs on the NAS |

No runtime dependencies: a new one is Kade's call.

## Settings

All of them come from the environment. Secrets are files outside git, never values in a URL.

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_SECRET_FILE` | (required) | The org webhook's secret |
| `READ_TOKEN_FILE` | (required) | The bearer token subscribers send |
| `PORT` | `8787` | Listen port behind the NAS reverse proxy (TLS there) |
| `DATA_DIR` | `./data` | Where `events.jsonl` lives |

## Gates

| Part | Gate |
|---|---|
| `src/`, `test/`, `package.json` | `node --test` (CI: `test.yml`) |
| `Dockerfile`, `compose.yaml` | `docker build .`; NOT VERIFIED where Docker is not installed |
| A live delivery and the dispatcher's subscription | After deploy on the NAS (Kade) |
| `.github/workflows/` | YAML parses; NOT VERIFIED until they have run on GitHub |

## Version control

`claude/<task>` from an up-to-date `main`, one task per PR. PRs touching `AGENTS.md`, `CLAUDE.md`
or `.github/` are drafts that Kade merges.
