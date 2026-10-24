#!/usr/bin/env bash
# Installs the pinned natscli that client/watch.sh runs, for a cloud environment's setup script
# (Linux, amd64 or arm64). The version is pinned: the GitHub "latest release" API answers 403
# from the cloud sandbox. Settings: NATS_CLI_VERSION (default 0.5.0), NATS_CLI_DIR (default
# /usr/local/bin). It needs no secret, and it writes none.
set -eu
v="${NATS_CLI_VERSION:-0.5.0}"
dest="${NATS_CLI_DIR:-/usr/local/bin}"
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "install-nats: unsupported machine $(uname -m)" >&2; exit 1 ;;
esac
if [ -x "$dest/nats" ] && "$dest/nats" --version 2>/dev/null | grep -qx "$v"; then
  echo "install-nats: nats $v already in $dest"; exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/nats.zip" "https://github.com/nats-io/natscli/releases/download/v$v/nats-$v-linux-$arch.zip"
unzip -oq "$tmp/nats.zip" -d "$tmp"
mkdir -p "$dest"
install -m 0755 "$tmp/nats-$v-linux-$arch/nats" "$dest/nats"
echo "install-nats: installed nats $("$dest/nats" --version) in $dest"
