"use strict";
// POST /github  an App webhook delivery: signature checked, normalized, published to JetStream with
//               the delivery GUID as the message id; a push or PR update also starts a
//               mergeability check.
// GET  /healthz liveness for the NAS.
const http = require("node:http");
const fs = require("node:fs");
const { verifySignature } = require("./verify");
const { normalize, mergeTrigger } = require("./normalize");

const MAX_BODY = 25 * 1024 * 1024; // GitHub caps a delivery at 25 MB

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

function send(res, status, body = "") {
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function createReceiver({ secret, publish, onTrigger, log = console.error }) {
  async function onDelivery(req, res) {
    let body;
    try { body = await readBody(req); } catch { return send(res, 413); }
    if (!verifySignature(secret, body, req.headers["x-hub-signature-256"])) return send(res, 401);
    const event = req.headers["x-github-event"];
    if (event === "ping") return send(res, 200);
    let payload;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return send(res, 400); }
    const delivery = req.headers["x-github-delivery"] || null;
    const name = typeof payload?.action === "string" ? `${event}.${payload.action}` : event;
    const tag = `${delivery || "-"} ${name} ->`;
    const out = normalize(event, payload, delivery);
    const trigger = mergeTrigger(event, payload);
    if (!out && !trigger) { log(`${tag} dropped`); return send(res, 204); }
    if (out) {
      let ack;
      try { ack = await publish(out.subject, out.event, delivery); } catch (e) { log(`publish ${out.subject}: ${e.message}`); return send(res, 503); }
      log(`${tag} ${ack && ack.duplicate ? "duplicate" : "published"} ${out.subject}`);
    } else {
      log(`${tag} trigger-only`);
    }
    if (trigger) Promise.resolve().then(() => onTrigger(trigger)).catch((e) => log(`mergeability: ${e.message}`));
    send(res, 202, { subject: out ? out.subject : null });
  }

  return http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "POST" && path === "/github") return void onDelivery(req, res);
    if (req.method === "GET" && path === "/healthz") return send(res, 200, "ok");
    send(res, 404);
  });
}

const fileSetting = (name) => {
  const file = process.env[name];
  if (!file) throw new Error(`${name} is not set`);
  return fs.readFileSync(file, "utf8").trim();
};

async function main() {
  const { connect, nkeyAuthenticator } = require("@nats-io/transport-node");
  const { jetstream, jetstreamManager } = require("@nats-io/jetstream");
  const { ensureStream } = require("./stream");
  const { createApp } = require("./github-app");
  const { createMergeWatch } = require("./mergeable");

  const nc = await connect({
    servers: process.env.NATS_URL || "nats://nats:4222",
    authenticator: nkeyAuthenticator(new TextEncoder().encode(fileSetting("NATS_NKEY_SEED_FILE"))),
    maxReconnectAttempts: -1,
  });
  await ensureStream(await jetstreamManager(nc));
  const js = jetstream(nc);
  const publish = (subject, event, msgID) => js.publish(subject, JSON.stringify(event), msgID ? { msgID } : undefined);

  if (!process.env.APP_ID) throw new Error("APP_ID is not set");
  const app = createApp({ appId: process.env.APP_ID, privateKey: fileSetting("APP_PRIVATE_KEY_FILE") });
  const watch = createMergeWatch({ gh: app, publish });
  const server = createReceiver({ secret: fileSetting("WEBHOOK_SECRET_FILE"), publish, onTrigger: (t) => watch.handle(t) });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () => console.log(`event-broker receiver on ${port}`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createReceiver };
