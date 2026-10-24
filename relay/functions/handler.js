"use strict";
const core = require("./core");

// db and messaging are injected so tests run against fakes with no emulator.
function makeHandler({ db, messaging, now = Date.now }) {
  const handles = () => db.collection("handles");
  const ipLimits = () => db.collection("ipLimits");

  async function register(body, ip) {
    const limitRef = ipLimits().doc(core.sha256Hex(String(ip || "unknown")));
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(limitRef);
      const d = snap.exists ? snap.data() : {};
      const w = core.nextWindow(d.windowStart, d.count, now(), core.REGISTER_LIMIT);
      if (!w.allowed) return false;
      // expireAt drives a Firestore TTL policy on ipLimits: a row is useless once its window ends.
      tx.set(limitRef, { windowStart: w.start, count: w.count, expireAt: new Date(w.start + core.WINDOW_MS) });
      return true;
    });
    if (!allowed) return { status: 429, body: { error: "rate limit exceeded" } };

    const handle = core.randomB64url(16);
    const secret = core.randomB64url(32);
    await handles().doc(handle).set({
      token: body.token,
      secretHash: core.sha256Hex(secret),
      createdAt: now(),
      sendWindowStart: now(),
      sendCount: 0,
    });
    return { status: 200, body: { handle, secret }, handle };
  }

  async function authed(body) {
    const ref = handles().doc(body.handle);
    const snap = await ref.get();
    if (!snap.exists) return { fail: { status: 404, body: { error: "unknown handle" } } };
    if (!core.secretMatches(body.secret, snap.data().secretHash)) {
      return { fail: { status: 401, body: { error: "bad secret" } } };
    }
    return { ref, data: snap.data() };
  }

  async function update(body) {
    const a = await authed(body);
    if (a.fail) return a.fail;
    await a.ref.update({ token: body.token });
    return { status: 204 };
  }

  async function unregister(body) {
    const ref = handles().doc(body.handle);
    const snap = await ref.get();
    if (!snap.exists) return { status: 204 };
    if (!core.secretMatches(body.secret, snap.data().secretHash)) {
      return { status: 401, body: { error: "bad secret" } };
    }
    await ref.delete();
    return { status: 204 };
  }

  async function send(body) {
    const ref = handles().doc(body.handle);
    // Auth and the counter share one transaction so concurrent sends cannot both squeeze under the cap.
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: 404, body: { error: "unknown handle" } };
      const d = snap.data();
      if (!core.secretMatches(body.secret, d.secretHash)) {
        return { status: 401, body: { error: "bad secret" } };
      }
      const w = core.nextWindow(d.sendWindowStart, d.sendCount, now(), core.SEND_LIMIT);
      if (!w.allowed) return { status: 429, body: { error: "rate limit exceeded" } };
      tx.update(ref, { sendWindowStart: w.start, sendCount: w.count });
      return { token: d.token };
    });
    if (out.status) return out;

    try {
      await messaging.send(core.buildMessage(out.token, body.chatId, body.chatName));
    } catch (e) {
      if (core.DEAD_TOKEN_CODES.has(e && e.code)) {
        await ref.delete();
        return { status: 404, body: { error: "token no longer valid" } };
      }
      return { status: 502, body: { error: "push delivery failed" } };
    }
    return { status: 204 };
  }

  const routes = {
    "/register": (b, req) => register(b, core.clientIp(req)),
    "/update": update,
    "/unregister": unregister,
    "/send": send,
  };

  return async function handler(req, res) {
    const route = req.path;
    let result;
    try {
      if (!Object.hasOwn(routes, route)) {
        result = { status: 404, body: { error: "not found" } };
      } else if (req.method !== "POST") {
        result = { status: 405, body: { error: "method not allowed" } };
      } else {
        const raw = req.rawBody ? req.rawBody.length : Buffer.byteLength(JSON.stringify(req.body ?? {}));
        if (raw > core.MAX_BODY_BYTES) {
          result = { status: 413, body: { error: "body too large" } };
        } else {
          const bad = core.validate(route, req.body);
          result = bad ? { status: 400, body: { error: bad } } : await routes[route](req.body, req);
        }
      }
    } catch (e) {
      // Never include the error text: Firestore/FCM messages can echo tokens.
      result = { status: 500, body: { error: "internal error" } };
    }
    const prefix = result.handle ||(req.body && typeof req.body.handle === "string" ? req.body.handle : "");
    console.log(JSON.stringify({ route, status: result.status, handle: prefix.slice(0, 6) }));
    if (result.body === undefined) res.status(result.status).end();
    else res.status(result.status).json(result.body);
  };
}

module.exports = { makeHandler };
