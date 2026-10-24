"use strict";
const crypto = require("node:crypto");

const MAX_BODY_BYTES = 4096;
const REGISTER_LIMIT = 20;
const SEND_LIMIT = 60;
const WINDOW_MS = 60 * 60 * 1000;

const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomB64url = (n) => crypto.randomBytes(n).toString("base64url");

// Hash both sides first so the compare is fixed-length; timingSafeEqual throws on unequal lengths.
function secretMatches(secret, storedHash) {
  if (typeof secret !== "string" || typeof storedHash !== "string") return false;
  const a = Buffer.from(sha256Hex(secret), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const isStr = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;

// Returns an error string, or null when the body is valid for the route.
function validate(route, body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const need = (field, min, max) => (isStr(body[field], min, max) ? null : `invalid ${field}`);
  const creds = () => need("handle", 1, 64) || need("secret", 1, 128);
  switch (route) {
    case "/register":
      return need("token", 1, 4096);
    case "/update":
      return creds() || need("token", 1, 4096);
    case "/unregister":
      return creds();
    case "/send": {
      const bad = creds() || need("chatId", 1, 128);
      if (bad) return bad;
      if (body.chatName !== undefined && !isStr(body.chatName, 0, 200)) return "invalid chatName";
      return null;
    }
    default:
      return "unknown route";
  }
}

// Fixed-window counter. Pure so the 61st-send boundary is testable without Firestore.
function nextWindow(start, count, now, limit) {
  const expired = typeof start !== "number" || now - start >= WINDOW_MS;
  const base = expired ? { start: now, count: 0 } : { start, count: typeof count === "number" ? count : 0 };
  if (base.count >= limit) return { allowed: false, start: base.start, count: base.count };
  return { allowed: true, start: base.start, count: base.count + 1 };
}

// The functions framework trusts the proxy, so req.ip is the LEFTMOST
// X-Forwarded-For entry, which the caller controls. Google's front end appends
// the real address last (checked live 2026-10-24: a faked "203.0.113.7" came
// through as "203.0.113.7,<caller>"), so the rate limit keys on that one.
function clientIp(req) {
  const xff = req.headers && req.headers["x-forwarded-for"];
  const last = typeof xff === "string" ? xff.split(",").pop().trim() : "";
  return last || req.ip;
}

function buildMessage(token, chatId, chatName) {
  return {
    token,
    data: { type: "blocked", chatId, ...(chatName ? { chatName } : {}) },
    android: { priority: "high", ttl: 3600000 },
  };
}

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

module.exports = {
  MAX_BODY_BYTES,
  REGISTER_LIMIT,
  SEND_LIMIT,
  WINDOW_MS,
  DEAD_TOKEN_CODES,
  sha256Hex,
  randomB64url,
  secretMatches,
  validate,
  nextWindow,
  clientIp,
  buildMessage,
};
