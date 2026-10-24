# event-broker

GitHub PR events for the dispatcher. A read-only GitHub App sends webhooks to a small Node
receiver, which publishes them to NATS JetStream. The dispatcher reads them through a durable
consumer and messages each worker at once. The design lives in
[`docs/event-broker-design.md`](https://github.com/kade-agent/agent-config/blob/main/docs/event-broker-design.md)
in kade-agent/agent-config.

```
GitHub App webhook ─▶ receiver ─▶ JetStream stream GITHUB ─▶ consumer "dispatcher"
  (HMAC checked)       │                                   ├─ LAN: nats://<LAN address>:4222, no key
                       └─ after a push or PR update:       └─ cloud: wss://<nas domain>/nats, NKey
                          reads mergeable_state, publishes "mergeable"
```

This repository is public. Nothing in it names the NAS: addresses, the domain, keys and secrets
live only in the NAS's `.env` and `secrets/`, and in the dispatcher's environment.

## Events

Subjects:
- `github.<owner>.<repo>.pr.<n>.<event>`;
- `github.<owner>.<repo>.branch.<branch>.<event>` for a check with no PR;
- `github.<owner>.<repo>.push.<branch>` for a push.

Dots, `*`, `>` and spaces in names become `_`. Each message is one JSON object:

```json
{"delivery":"1f2e…","repo":"stella-rain/app","pr":341,"branch":"claude/z3-orbs","event":"check_run",
 "action":"completed","merged":null,"draft":false,"auto_merge":true,"conclusion":"failure",
 "check":{"name":"test","url":"https://github.com/…"},"mergeable_state":null,"sha":"9f2c1e0"}
```

| GitHub event | Kept when |
|---|---|
| `pull_request` | `closed`, `ready_for_review`, `converted_to_draft`, `auto_merge_enabled`, `auto_merge_disabled` |
| `check_suite`, `check_run`, `workflow_run` | `completed` |
| `pull_request_review` | `submitted` (the review state is in `conclusion`) |
| `push` | to the default branch |
| `mergeable` (made by the receiver) | a PR's `mergeable_state` changed: `clean`, `behind`, `dirty`, `blocked`, `unstable` |

A PR `opened`, `reopened` or `synchronize` is not published, but it starts a mergeability check
on that PR. A push to the default branch starts one on every open PR on that base.

## Deploying on the NAS (Kade, once)

1. **Create the GitHub App** (organization settings → Developer settings → GitHub Apps):
   - Webhook URL: `https://<nas domain>/github`. Webhook secret: a long random string.
   - Repository permissions, all **read-only**: Metadata, Pull requests, Checks, Actions, Contents.
   - Subscribe to events: Pull request, Check suite, Check run, Workflow run, Pull request review,
     Push.
   - Generate a private key (a `.pem` download), and note the App id.
   - Install it on the stella-rain organization, for all repositories.
2. **Make the NKeys** in a checkout on the NAS (`npm ci` first). Run `node scripts/nkey.js` twice,
   once for `receiver` and once for `cloud`. Line 1 is the seed, which is secret; line 2 is the
   public key.
3. **Fill in `secrets/`:**
   - `webhook_secret`
   - `app_private_key.pem`
   - `receiver_nkey_seed` (the receiver's line 1)
   Keep the cloud seed for step 6 only.
4. **Fill in `.env`** from `.env.example`: the LAN address, the App id, both public keys (line 2)
   and a random `LAN_UNUSED_PASSWORD`.
5. **Start it** with `docker compose up -d --build`. Then point the reverse proxy for the domain at it:
   - `/github` → `127.0.0.1:8787`;
   - `/nats` → `127.0.0.1:8080`, as a websocket upgrade.
   The router forwards only 443. Port 4222 stays on the LAN.
6. **The dispatcher:**
   - **Local:** `EVENT_BROKER_URL=nats://<LAN address>:4222`, no key.
   - **Cloud:** in the environment's private init script, write the cloud seed to a file with
     `umask 077`, and set `EVENT_BROKER_URL=wss://<nas domain>/nats` and
     `EVENT_BROKER_NKEY_FILE=<that file>`. Never echo the seed.
7. **Check it:**
   - The App's "Recent deliveries" page shows the `ping` with a 200.
   - From the LAN: `nats --server nats://<LAN address>:4222 consumer next GITHUB dispatcher`
     prints the next event after a PR changes.

Revoking a key: remove its public key from `.env`, then `docker compose up -d`.

## Development

- `npm ci && node --test` runs the unit tests. The integration tests in `test/integration/` skip
  unless a nats-server is running.
- CI runs both, with throwaway NKeys and the real `nats/nats-server.conf`.
- See `AGENTS.md` for the layout and the gates.
