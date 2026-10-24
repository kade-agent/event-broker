"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { createApp } = require("../src/github-app");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });
const b64 = (s) => JSON.parse(Buffer.from(s, "base64url").toString());

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", auth: init.headers && init.headers.authorization });
    const path = new URL(url).pathname + new URL(url).search;
    const body = routes(path, init);
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test("the App JWT is RS256, issued by the App id, backdated 60 s and valid under 10 minutes", () => {
  const app = createApp({ appId: "123", privateKey: pem, fetch: fakeFetch(() => null), now: () => 1_000_000_000 });
  const [h, p, sig] = app.jwt().split(".");
  assert.deepStrictEqual(b64(h), { alg: "RS256", typ: "JWT" });
  const claims = b64(p);
  assert.strictEqual(claims.iss, "123");
  assert.strictEqual(claims.iat, 1_000_000 - 60);
  assert.ok(claims.exp - 1_000_000 <= 600 && claims.exp > 1_000_000);
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url")));
});

test("a GET uses an installation token, cached per owner until a minute before it expires", async () => {
  let t = 0;
  const fetch = fakeFetch((path, init) => {
    if (path === "/repos/stella-rain/app/installation") return { id: 42 };
    if (path === "/app/installations/42/access_tokens" && init.method === "POST") {
      return { token: `tok${fetch.calls.length}`, expires_at: new Date(t + 3600_000).toISOString() };
    }
    if (path.startsWith("/repos/stella-rain/app/pulls")) return [{ number: 1 }];
    return null;
  });
  const app = createApp({ appId: "1", privateKey: pem, fetch, now: () => t });
  assert.deepStrictEqual(await app.get("stella-rain/app", "/pulls?state=open"), [{ number: 1 }]);
  await app.get("stella-rain/app", "/pulls?state=open");
  const tokenCalls = () => fetch.calls.filter((c) => c.url.endsWith("/access_tokens")).length;
  assert.strictEqual(tokenCalls(), 1);
  const reads = fetch.calls.filter((c) => c.url.includes("/pulls"));
  assert.ok(reads.every((c) => /^token tok\d+$/.test(c.auth)), "reads carry the installation token");
  t = 3600_000 - 30_000;
  await app.get("stella-rain/app", "/pulls?state=open");
  assert.strictEqual(tokenCalls(), 2, "renewed inside the last minute");
});

test("a failed GitHub read throws with its status", async () => {
  const fetch = fakeFetch((path) => (path.endsWith("/installation") ? { id: 1 } : path.endsWith("/access_tokens") ? { token: "t", expires_at: new Date(3600_000).toISOString() } : null));
  const app = createApp({ appId: "1", privateKey: pem, fetch, now: () => 0 });
  await assert.rejects(app.get("o/r", "/pulls/9"), /404/);
});
