"use strict";
const test = require("node:test");
const assert = require("node:assert");
const core = require("./core");
const { makeHandler } = require("./handler");

function fakeDb() {
  const store = new Map();
  const key = (c, id) => `${c}/${id}`;
  const ref = (c, id) => ({
    get: async () => ({ exists: store.has(key(c, id)), data: () => ({ ...store.get(key(c, id)) }) }),
    set: async (v) => void store.set(key(c, id), { ...v }),
    update: async (v) => void store.set(key(c, id), { ...store.get(key(c, id)), ...v }),
    delete: async () => void store.delete(key(c, id)),
  });
  const tx = {
    get: (r) => r.get(),
    set: (r, v) => r.set(v),
    update: (r, v) => r.update(v),
  };
  return {
    store,
    collection: (c) => ({ doc: (id) => ref(c, id) }),
    runTransaction: (fn) => fn(tx),
  };
}

function setup(sendImpl) {
  const db = fakeDb();
  const sent = [];
  const messaging = {
    send: async (m) => {
      sent.push(m);
      if (sendImpl) return sendImpl(m);
      return "id";
    },
  };
  let t = 1_000_000;
  const clock = { advance: (ms) => (t += ms) };
  const handler = makeHandler({ db, messaging, now: () => t });
  async function call(path, body, opts = {}) {
    const res = { code: null, json: undefined };
    const r = {
      status: (c) => ((res.code = c), r),
      json: (b) => ((res.json = b), r),
      end: () => r,
    };
    await handler({ method: opts.method || "POST", path, body, ip: opts.ip || "1.2.3.4", rawBody: opts.rawBody }, r);
    return res;
  }
  return { db, sent, call, clock };
}

async function registered(s) {
  const r = await s.call("/register", { token: "tok" });
  assert.equal(r.code, 200);
  return r.json;
}

test("register returns handle+secret and stores only the secret hash", async () => {
  const s = setup();
  const { handle, secret } = await registered(s);
  const doc = s.db.store.get(`handles/${handle}`);
  assert.equal(doc.secretHash, core.sha256Hex(secret));
  assert.equal(doc.token, "tok");
  assert.notEqual(doc.secretHash, secret);
});

test("register is limited to 20 per hour per IP, other IPs unaffected, window resets", async () => {
  const s = setup();
  for (let i = 0; i < 20; i++) assert.equal((await s.call("/register", { token: "t" })).code, 200);
  assert.equal((await s.call("/register", { token: "t" })).code, 429);
  assert.equal((await s.call("/register", { token: "t" }, { ip: "9.9.9.9" })).code, 200);
  s.clock.advance(core.WINDOW_MS);
  assert.equal((await s.call("/register", { token: "t" })).code, 200);
});

test("send with a bad secret gives 401 and sends nothing", async () => {
  const s = setup();
  const { handle } = await registered(s);
  const r = await s.call("/send", { handle, secret: "wrong", chatId: "c1" });
  assert.equal(r.code, 401);
  assert.equal(s.sent.length, 0);
});

test("send to an unknown handle gives 404", async () => {
  const s = setup();
  assert.equal((await s.call("/send", { handle: "nope", secret: "x", chatId: "c" })).code, 404);
});

test("the 61st send in a window gives 429, and the window then resets", async () => {
  const s = setup();
  const { handle, secret } = await registered(s);
  for (let i = 0; i < 60; i++) {
    assert.equal((await s.call("/send", { handle, secret, chatId: "c" })).code, 204, `send ${i + 1}`);
  }
  assert.equal((await s.call("/send", { handle, secret, chatId: "c" })).code, 429);
  assert.equal(s.sent.length, 60);
  s.clock.advance(core.WINDOW_MS);
  assert.equal((await s.call("/send", { handle, secret, chatId: "c" })).code, 204);
});

test("send builds a data-only high-priority message", async () => {
  const s = setup();
  const { handle, secret } = await registered(s);
  await s.call("/send", { handle, secret, chatId: "c1", chatName: "My chat" });
  assert.deepEqual(s.sent[0], {
    token: "tok",
    data: { type: "blocked", chatId: "c1", chatName: "My chat" },
    android: { priority: "high", ttl: 3600000 },
  });
  assert.equal("notification" in s.sent[0], false);
});

test("chatName is omitted from data when absent or empty", async () => {
  const s = setup();
  const { handle, secret } = await registered(s);
  await s.call("/send", { handle, secret, chatId: "c1" });
  await s.call("/send", { handle, secret, chatId: "c1", chatName: "" });
  assert.deepEqual(s.sent[0].data, { type: "blocked", chatId: "c1" });
  assert.equal("chatName" in s.sent[1].data, false);
});

test("a dead FCM token deletes the handle and gives 404", async () => {
  for (const code of ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]) {
    const s = setup(() => {
      throw Object.assign(new Error("x"), { code });
    });
    const { handle, secret } = await registered(s);
    const r = await s.call("/send", { handle, secret, chatId: "c" });
    assert.equal(r.code, 404);
    assert.equal(s.db.store.has(`handles/${handle}`), false);
  }
});

test("other FCM errors give 502 and keep the handle", async () => {
  const s = setup(() => {
    throw Object.assign(new Error("boom"), { code: "messaging/internal-error" });
  });
  const { handle, secret } = await registered(s);
  const r = await s.call("/send", { handle, secret, chatId: "c" });
  assert.equal(r.code, 502);
  assert.equal(s.db.store.has(`handles/${handle}`), true);
});

test("a body over 4 KB gives 413", async () => {
  const s = setup();
  const r = await s.call("/register", { token: "x".repeat(5000) });
  assert.equal(r.code, 413);
  const viaRaw = await s.call("/register", { token: "t" }, { rawBody: Buffer.alloc(4097) });
  assert.equal(viaRaw.code, 413);
});

test("non-POST gives 405 and unknown path gives 404", async () => {
  const s = setup();
  assert.equal((await s.call("/send", {}, { method: "GET" })).code, 405);
  assert.equal((await s.call("/nope", {})).code, 404);
  assert.equal((await s.call("/__proto__", {})).code, 404);
});

test("wrong-type or missing fields give 400 with an error", async () => {
  const s = setup();
  const bad = [
    ["/register", {}],
    ["/register", { token: 5 }],
    ["/register", { token: "" }],
    ["/send", { handle: "h", secret: "s" }],
    ["/send", { handle: "h", secret: "s", chatId: "x".repeat(129) }],
    ["/send", { handle: "h", secret: "s", chatId: "c", chatName: "x".repeat(201) }],
    ["/send", { handle: "h", secret: "s", chatId: "c", chatName: 3 }],
    ["/update", { handle: "h", secret: "s" }],
    ["/unregister", { handle: "h" }],
  ];
  for (const [p, b] of bad) {
    const r = await s.call(p, b);
    assert.equal(r.code, 400, p + JSON.stringify(b).slice(0, 40));
    assert.equal(typeof r.json.error, "string");
  }
  assert.equal((await s.call("/register", null)).code, 400);
});

test("update replaces the token; 401 on bad secret; 404 on unknown handle", async () => {
  const s = setup();
  const { handle, secret } = await registered(s);
  assert.equal((await s.call("/update", { handle, secret: "bad", token: "n" })).code, 401);
  assert.equal(s.db.store.get(`handles/${handle}`).token, "tok");
  assert.equal((await s.call("/update", { handle, secret, token: "n" })).code, 204);
  assert.equal(s.db.store.get(`handles/${handle}`).token, "n");
  assert.equal((await s.call("/update", { handle: "zz", secret, token: "n" })).code, 404);
});

test("unregister deletes, is idempotent, and 401s on bad secret", async () => {
  const s = setup();
  const { handle, secret } = await registered(s);
  assert.equal((await s.call("/unregister", { handle, secret: "bad" })).code, 401);
  assert.equal(s.db.store.has(`handles/${handle}`), true);
  assert.equal((await s.call("/unregister", { handle, secret })).code, 204);
  assert.equal(s.db.store.has(`handles/${handle}`), false);
  assert.equal((await s.call("/unregister", { handle, secret })).code, 204);
});

test("nextWindow math", () => {
  assert.deepEqual(core.nextWindow(undefined, undefined, 5, 2), { allowed: true, start: 5, count: 1 });
  assert.equal(core.nextWindow(0, 2, 10, 2).allowed, false);
  assert.equal(core.nextWindow(0, 2, core.WINDOW_MS, 2).allowed, true);
});

test("secretMatches rejects non-strings and wrong secrets", () => {
  const h = core.sha256Hex("s");
  assert.equal(core.secretMatches("s", h), true);
  assert.equal(core.secretMatches("t", h), false);
  assert.equal(core.secretMatches(undefined, h), false);
});
