# kade-agent/event-broker

The NAS side of the dispatcher's PR events. The design is `docs/event-broker-design.md` in
kade-agent/agent-config, a living doc: a change to the design is made there first. The
dispatcher's side is `agent-skills/dispatcher/references/pr-watch.md` there.

- A GitHub App (read-only) sends webhook deliveries to `POST /github`.
- The receiver checks the HMAC, normalizes the event and publishes it to NATS JetStream (stream
  `GITHUB`, subjects `github.>`, the delivery GUID as the message id).
- After a push to a default branch or a PR `synchronize`, it reads the open PRs'
  `mergeable_state` with an App installation token, and publishes a `mergeable` event when the
  state changes.
- The dispatcher reads through a durable consumer: on the LAN with no key, from the cloud over
  websocket with an NKey.

The global rules (`~/.claude/AGENTS.md`) and the `repo-workflow` skill apply. Nothing here
overrides them.

## Layout

| Path | What |
|---|---|
| `src/verify.js` | `X-Hub-Signature-256` check, constant time |
| `src/normalize.js` | delivery -> `{subject, event}` (design section 4), or `null` to drop it |
| `src/github-app.js` | App JWT (RS256, `node:crypto`), installation token cache, `GET` helper |
| `src/mergeable.js` | after a trigger: reads `mergeable_state` past `unknown`, publishes on change |
| `src/receiver.js` | `node:http`: `POST /github`, `GET /healthz`; wiring and settings |
| `nats/nats-server.conf` | JetStream, the three users and their permissions (design section 7) |
| `src/stream.js` | creates or updates stream `GITHUB` and consumer `dispatcher` at start |
| `scripts/nkey.js` | prints a new NKey: seed (secret) and public key |
| `.env.example` | the NAS's compose settings as placeholders; the real `.env` is never committed |
| `test/` | unit tests; `test/integration/` runs only with `NATS_URL` set (CI starts nats-server) |
| `Dockerfile`, `compose.yaml` | how it runs on the NAS |

Runtime dependencies: `@nats-io/transport-node` and `@nats-io/jetstream` (Kade, 2026-10-24),
pinned exactly. Another one is Kade's call.

## Settings

All of them come from the environment. Secrets are files outside git.

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_SECRET_FILE` | (required) | the App's webhook secret |
| `APP_ID` | (required) | the GitHub App's id |
| `APP_PRIVATE_KEY_FILE` | (required) | the App's private key (PEM) |
| `NATS_URL` | `nats://nats:4222` | the NATS server, inside compose |
| `NATS_NKEY_SEED_FILE` | (required) | the `receiver` user's NKey seed |
| `PORT` | `8787` | listen port behind the NAS reverse proxy (TLS there) |

## Gates

| Part | Gate |
|---|---|
| `src/`, `test/`, `scripts/`, `package.json` | `npm ci && node --test` (CI: `test.yml`) |
| `nats/nats-server.conf` | CI's integration job against a real nats-server; NOT VERIFIED locally without it |
| `Dockerfile`, `compose.yaml` | `docker build .` in CI; NOT VERIFIED where Docker is not installed |
| A live delivery, the proxy routes, a cloud subscription | after Kade's deploy on the NAS |
| `.github/workflows/` | YAML parses; NOT VERIFIED until they have run on GitHub |

## Version control

`claude/<task>` from an up-to-date `main`, one task per PR. PRs touching `AGENTS.md`, `CLAUDE.md`
or `.github/` are drafts that Kade merges.
