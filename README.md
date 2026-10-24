# event-broker

GitHub PR events for the dispatcher. A read-only GitHub App sends webhooks to a small Node
receiver, which publishes them to NATS JetStream. The dispatcher reads them through a durable
consumer and messages each worker at once. The design lives in
[`docs/event-broker-design.md`](https://github.com/kade-agent/agent-config/blob/main/docs/event-broker-design.md)
in kade-agent/agent-config.

```
GitHub App webhook ─▶ receiver ─▶ JetStream stream GITHUB ─▶ consumer "dispatcher"
  (HMAC checked)       │                                   ├─ LAN: nats://<LAN address>:4222, no key
                       └─ after a push or PR update:       └─ cloud: wss://<nats host>, NKey
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
   - Webhook URL: `https://<webhook host>/github`. Leave the webhook secret empty for now; step 3
     makes one.
   - Repository permissions, all **read-only**: Metadata, Pull requests, Checks, Actions, Contents.
   - Subscribe to events: Pull request, Check suite, Check run, Workflow run, Pull request review,
     Push.
   - "Where can this GitHub App be installed?": **Only on this account**. The receiver has no owner
     allowlist.
   - Generate a private key (a `.pem` download), and note the App ID.
   - Install it on the organization: the App's page → **Install App**.
2. **Put the App key** in the checkout on the NAS, at `secrets/app_private_key.pem`.
3. **Run the setup:** `docker compose run --rm setup`. It:
   - writes `.env` from `.env.example`, and makes both NKey pairs. The public keys are always
     derived from the seeds, so a seed can never end up in `.env`;
   - makes the webhook secret and the LAN password;
   - sets every secret to mode 600, owned by the containers' user;
   - prints what changed and what is still to do, never a seed or a secret.

   Run it again any time: it fixes what is wrong and keeps the rest.
4. **Finish by hand:**
   - in `.env`, set `APP_ID` (the App's page, "About") and `LAN_ADDRESS` (the NAS's LAN address);
   - paste the contents of `secrets/webhook_secret` into the App's webhook secret, then save.
5. **Start it:** `docker compose up -d --build`. Then give the reverse proxy one hostname per
   route, each **one level** under a wildcard certificate (`*.<domain>` does not cover
   `a.b.<domain>`):
   - `<webhook host>` → `127.0.0.1:8787`;
   - `<nats host>` → `127.0.0.1:8080`, with the WebSocket headers.

   The router forwards only 443. Port 4222 stays on the LAN.
6. **The dispatcher** runs `client/watch.sh` as its Monitor command (agent-config,
   `pr-watch.md`). It prints one event per line, and `BROKER-DOWN <why>` when it gives up.
   - **Local:** `EVENT_BROKER_URL=nats://<LAN address>:4222`, no key. On Windows:
     - install `nats.exe` from the natscli releases (`nats-0.5.0-windows-amd64.zip`) and put
       its folder on the user `PATH`;
     - set the URL with `setx`;
     - restart the Claude app, so new sessions see both.
   - **Cloud,** the environment's settings:
     - **Variables:** `EVENT_BROKER_URL=wss://<nats host>`,
       `EVENT_BROKER_NKEY_FILE=/root/.event-broker.nk`, and `EVENT_BROKER_CLOUD_SEED` (the line
       in `secrets/cloud_seed`, which is never mounted into a container).
     - **Network access:** allows `<nats host>`.
     - **Setup script:** runs `client/install-nats.sh` from this repository (pinned natscli
       0.5.0), and nothing else:
       `curl -fsSL https://raw.githubusercontent.com/kade-agent/event-broker/main/client/install-nats.sh | bash`.
       A setup script cannot see the environment's variables, so it never writes the seed.
       `client/watch.sh` writes the seed file from `EVENT_BROKER_CLOUD_SEED` when the watch
       starts.
7. **Check it:**
   - The App's "Recent deliveries" page shows the `ping` with a 200. A 401 means the App's webhook
     secret differs from `secrets/webhook_secret`.
   - From the LAN: `nats --server nats://<LAN address>:4222 consumer info GITHUB dispatcher`
     reads the consumer without taking an event.

Replacing a key: delete its seed file in `secrets/`, run `docker compose run --rm setup`, then
`docker compose up -d --force-recreate`. For the cloud key, also update the cloud environment's
seed.

## Development

- `npm ci && node --test` runs the unit tests. The integration tests in `test/integration/` skip
  unless a nats-server is running.
- CI runs both, with throwaway NKeys and the real `nats/nats-server.conf`.
- See `AGENTS.md` for the layout and the gates.
