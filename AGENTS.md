# kade-agent/event-broker

The NAS side of the dispatcher's PR events. The design is `docs/event-broker-design.md` in
kade-agent/agent-config, a living doc: a change to the design is made there first. The
dispatcher's side is `agent-skills/dispatcher/references/pr-watch.md` there.

- A GitHub App (read-only) sends webhook deliveries to `POST /github`.
- The receiver checks the HMAC, normalizes the event and publishes it to its owner's NATS account (stream
  `GITHUB`, subjects `github.<owner>.>`, the delivery GUID as the message id); only `ALLOWED_OWNERS`.
- After a push to a default branch or a PR `synchronize`, it reads the open PRs'
  `mergeable_state` with an App installation token, and publishes a `mergeable` event when the
  state changes.
- The dispatcher reads its org's filtered durable consumer with that org's reader NKey: on the LAN,
  or from the cloud over websocket. There is no keyless access.

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
| `nats/nats-server.conf` | JetStream, one account per allowed owner with its receiver and reader users (design section 7) |
| `src/stream.js` | creates or updates, per owner, stream `GITHUB` and consumer `dispatcher` (8 filter_subjects) at start |
| `scripts/setup.js` | `docker compose run --rm setup`: .env, a receiver and a reader NKey pair per owner, secrets and their owners |
| `scripts/nkey.js` | prints a new NKey: seed (secret) and public key |
| `client/watch.sh` | the dispatcher's watch (agent-config `pr-watch.md`): the consumer loop, the pidfile, the cloud seed |
| `client/install-nats.sh` | installs the pinned natscli (0.5.0) in a cloud setup script |
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
| `ALLOWED_OWNERS` | (required) | owners whose deliveries are accepted, comma-separated; one NATS account each |
| `MAIN_INFO_WORKFLOWS` | (empty) | `<owner>/<repo>:<workflow name>`, comma-separated: runs on main published as `main_info`, never red (design decision 32) |
| `NATS_NKEY_SEEDS_FILE` | (required) | the `receiver-<owner>` seeds, one `<owner> <seed>` line per allowed owner |
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
