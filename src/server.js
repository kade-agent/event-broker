"use strict";
// POST /github   a webhook delivery: signature checked, normalized, stored, sent to subscribers.
// GET  /events   SSE for the dispatcher, with `Authorization: Bearer <read token>`. With
//                Last-Event-ID, it replays what came after that id; without one, new events only.
// GET  /healthz  liveness for the NAS, no token.
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { verifySignature } = require("./verify");
const { normalize } = require("./normalize");
const { openStore } = require("./store");

const MAX_BODY = 25 * 1024 * 1024; // GitHub caps a delivery at 25 MB

function tokenMatches(token, header) {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const a = crypto.createHash("sha256").update(header.slice(7)).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const frame = (e) => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;

function createServer({ secret, token, store, heartbeatMs = 30000 }) {
  const subscribers = new Set();

  async function onDelivery(req, res) {
    let body;
    try { body = await readBody(req); } catch { return send(res, 413); }
    if (!verifySignature(secret, body, req.headers["x-hub-signature-256"])) return send(res, 401);
    const event = req.headers["x-github-event"];
    if (event === "ping") return send(res, 200);
    let payload;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return send(res, 400); }
    const line = normalize(event, payload);
    if (!line) return send(res, 204);
    const stored = store.append(line);
    for (const s of subscribers) s.write(frame(stored));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: stored.id }));
  }

  function onSubscribe(req, res) {
    if (!tokenMatches(token, req.headers.authorization)) return send(res, 401);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    const lastEventId = req.headers["last-event-id"];
    if (lastEventId !== undefined && /^\d+$/.test(lastEventId)) {
      for (const e of store.since(Number(lastEventId))) res.write(frame(e));
    }
    // Replay and registration run in one tick, so no event falls between them.
    subscribers.add(res);
    const beat = setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs);
    req.on("close", () => { clearInterval(beat); subscribers.delete(res); });
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/github") return void onDelivery(req, res);
    if (req.method === "GET" && url.pathname === "/events") return onSubscribe(req, res);
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok");
    send(res, 404);
  });
}

function send(res, status, text = "") {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}

const readSecret = (name) => {
  const file = process.env[name];
  if (!file) throw new Error(`${name} is not set`);
  return fs.readFileSync(file, "utf8").trim();
};

if (require.main === module) {
  const store = openStore(process.env.DATA_DIR || "./data");
  const server = createServer({ secret: readSecret("WEBHOOK_SECRET_FILE"), token: readSecret("READ_TOKEN_FILE"), store });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () => console.log(`event-broker listening on ${port}, last id ${store.lastId()}`));
}

module.exports = { createServer };
