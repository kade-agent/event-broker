#!/usr/bin/env bash
# The dispatcher's PR watch (agent-config: agent-skills/dispatcher/references/pr-watch.md).
# Run it as a Claude Code Monitor command: each stdout line is one event (a JSON object), or
# "BROKER-DOWN <why>" before it exits, which sends the dispatcher to the gh poll.
#
# Settings, from the environment only:
#   EVENT_BROKER_URL        nats://<LAN address>:4222 (no key), or wss://<nats host> from the cloud
#   EVENT_BROKER_NKEY_FILE  cloud only: where the cloud seed file goes
#   EVENT_BROKER_CLOUD_SEED cloud only: the seed. A cloud setup script cannot see the environment's
#                           variables, so the seed file is written here, when the watch starts.
#   EVENT_BROKER_CONSUMER   default "dispatcher"
#   WATCH_PIDFILE           default ~/.claude/dispatcher/watch.pid; the newest watch owns it
#   NATS_BIN                default "nats"
set -u
url="${EVENT_BROKER_URL:-}"
if [ -z "$url" ]; then echo "BROKER-DOWN EVENT_BROKER_URL is not set"; exit 2; fi
nats="${NATS_BIN:-nats}"
consumer="${EVENT_BROKER_CONSUMER:-dispatcher}"
pid="${WATCH_PIDFILE:-$HOME/.claude/dispatcher/watch.pid}"

key=()
keyfile="${EVENT_BROKER_NKEY_FILE:-}"
if [ -n "$keyfile" ]; then
  if [ ! -s "$keyfile" ]; then
    if [ -z "${EVENT_BROKER_CLOUD_SEED:-}" ]; then
      echo "BROKER-DOWN no key: $keyfile is missing and EVENT_BROKER_CLOUD_SEED is empty"; exit 1
    fi
    (umask 077 && printf '%s\n' "$EVENT_BROKER_CLOUD_SEED" > "$keyfile")
  fi
  key=(--nkey "$keyfile")
fi

mkdir -p "$(dirname "$pid")"
echo $$ > "$pid"
fails=0
while [ "$(cat "$pid" 2>/dev/null)" = "$$" ]; do
  if out=$("$nats" --server "$url" ${key[@]+"${key[@]}"} consumer next GITHUB "$consumer" --raw --count 1 --wait 60s 2>&1); then
    printf '%s\n' "$out"
    fails=0
  else
    case "$out" in
      *imeout*|*"no message"*) fails=0 ;; # a quiet minute, not an outage
      *) fails=$((fails + 1))
         if [ "$fails" -ge 2 ]; then echo "BROKER-DOWN $out"; exit 1; fi ;;
    esac
  fi
done
