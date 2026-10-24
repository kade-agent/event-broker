"use strict";
// Read-only GitHub API access as the App (design section 3): an RS256 JWT signed with the App's
// private key buys an installation token (one hour), cached per owner until a minute before expiry.
const crypto = require("node:crypto");

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function createApp({ appId, privateKey, fetch = globalThis.fetch, now = Date.now, api = "https://api.github.com" }) {
  const installations = new Map(); // owner -> installation id
  const tokens = new Map(); // owner -> { token, expiresAt }

  function jwt() {
    const t = Math.floor(now() / 1000);
    const head = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: t - 60, exp: t + 540, iss: String(appId) })}`;
    return `${head}.${crypto.sign("sha256", Buffer.from(head), privateKey).toString("base64url")}`;
  }

  async function call(path, auth, method = "GET") {
    const res = await fetch(api + path, {
      method,
      headers: {
        authorization: auth, accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", "user-agent": "kade-agent-event-broker",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} ${method} ${path}`);
    return res.json();
  }

  async function installationToken(repo) {
    const owner = repo.split("/")[0];
    const cached = tokens.get(owner);
    if (cached && now() < cached.expiresAt - 60_000) return cached.token;
    if (!installations.has(owner)) installations.set(owner, (await call(`/repos/${repo}/installation`, `Bearer ${jwt()}`)).id);
    const t = await call(`/app/installations/${installations.get(owner)}/access_tokens`, `Bearer ${jwt()}`, "POST");
    tokens.set(owner, { token: t.token, expiresAt: Date.parse(t.expires_at) });
    return t.token;
  }

  return {
    jwt,
    async get(repo, path) {
      return call(`/repos/${repo}${path}`, `token ${await installationToken(repo)}`);
    },
  };
}

module.exports = { createApp };
