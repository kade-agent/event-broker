"use strict";
// Prints a new NATS user NKey: the seed on line 1 (secret: it goes in a file, never in git) and the
// public key on line 2 (for .env). Run on the NAS: node scripts/nkey.js
const { nkeys } = require("@nats-io/transport-node");

const pair = nkeys.createUser();
const dec = new TextDecoder();
process.stdout.write(`${dec.decode(pair.getSeed())}\n${pair.getPublicKey()}\n`);
