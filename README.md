# event-broker

A GitHub webhook receiver that runs on the NAS. It checks each PR event and serves it as an SSE
stream with replay. The dispatcher's PR watch subscribes to that stream, as
`agent-skills/dispatcher/references/pr-watch.md` in kade-agent/agent-config describes. A merge,
a red run, a review or a push to `main` reaches the dispatcher within seconds, and it messages the
worker.

```
GitHub org webhook ──POST /github──▶ event-broker (NAS) ──GET /events (SSE)──▶ dispatcher Monitor
```

## Events

Each stored event is one JSON line with an id that only increases:

```json
{"repo":"stella-rain/app","pr":341,"branch":"claude/z3-orbs","event":"pull_request","action":"closed","merged":true,"conclusion":null,"sha":"9f2c1e0","id":412}
```

| GitHub event | Kept when | `conclusion` |
|---|---|---|
| `pull_request` | `closed` (with `merged` true or false) | null |
| `check_suite`, `check_run` | `completed` | the check's conclusion |
| `pull_request_review` | `submitted` | the review state |
| `push` | to the default branch (`pr` is null) | null |

Everything else gets a 204 and is not stored. The store keeps the last 5000 events, or 7 days of
them, and always the newest.

## Deploying on the NAS (Kade, once)

1. Make two secrets, for example with `openssl rand -hex 32` each:
   - `secrets/webhook_secret`: the webhook's secret;
   - `secrets/read_token`: the token the dispatcher sends.
   Both stay on the NAS and in the dispatcher's token file, never in git.
2. Run `docker compose up -d --build`. The service listens on `127.0.0.1:8787`.
3. Point the NAS reverse proxy at it, with TLS on the domain, for example
   `https://events.<nas domain>` → `127.0.0.1:8787`.
4. Check it: `curl https://events.<nas domain>/healthz` answers `ok`.
5. Add the stella-rain organization webhook (Settings → Webhooks → Add webhook):
   - Payload URL: `https://events.<nas domain>/github`
   - Content type: `application/json`
   - Secret: the contents of `secrets/webhook_secret`
   - Events, chosen individually: Pull requests, Check suites, Check runs, Pull request reviews,
     Pushes.
   GitHub's first delivery is a `ping`, and it should show 200.
6. On the dispatcher's PC:
   - put the line `Authorization: Bearer <read token>` in a file outside git;
   - set `EVENT_BROKER_URL=https://events.<nas domain>`;
   - set `EVENT_BROKER_TOKEN_FILE=<that file>`.
   For cloud sessions, use the same two settings as environment secrets.

## Subscribing by hand

```bash
curl -sN -H @"$EVENT_BROKER_TOKEN_FILE" -H "Last-Event-ID: 0" "$EVENT_BROKER_URL/events"
```

With `Last-Event-ID` you get what came after that id, then live events. Without it you get live
events only. A `: heartbeat` comment arrives every 30 s.

## Development

`node --test`: no dependencies, Node 22 or later. See `AGENTS.md` for the layout and the gates.
