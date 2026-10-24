"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { makeHandler } = require("./handler");

// No key file: the function's own default service account supplies the credentials.
initializeApp();

exports.relay = onRequest(
  // Public on purpose: daemons and phones call it unauthenticated, and each
  // route checks its own handle secret or rate limit instead.
  { region: "europe-west1", maxInstances: 3, memory: "256MiB", invoker: "public" },
  makeHandler({ db: getFirestore(), messaging: getMessaging() }),
);
