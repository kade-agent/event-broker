"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseSeeds, publisherFor } = require("../src/receiver");

test("parseSeeds reads one owner and seed per line, owners lower-cased", () => {
  assert.deepStrictEqual(parseSeeds("Kade-Agent SUaaa\nstella-rain SUbbb\n\n"), { "kade-agent": "SUaaa", "stella-rain": "SUbbb" });
});

test("publisherFor sends an event through its owner's connection", async () => {
  const sent = [];
  const pub = publisherFor({ "kade-agent": (s) => sent.push(["a", s]), "stella-rain": (s) => sent.push(["b", s]) });
  await pub("github.Stella-Rain.r.pr.1.pull_request", { repo: "Stella-Rain/r" }, "g1");
  await pub("github.kade-agent.r.push.main", { repo: "kade-agent/r" }, "g2");
  assert.deepStrictEqual(sent, [["b", "github.Stella-Rain.r.pr.1.pull_request"], ["a", "github.kade-agent.r.push.main"]]);
});

test("publisherFor rejects an owner with no connection", async () => {
  const pub = publisherFor({ "kade-agent": () => {} });
  await assert.rejects(pub("github.x.r.push.main", { repo: "x/r" }, "g"), /no receiver connection for x/);
});
