# Conductor push relay

A single Firebase Cloud Function (2nd gen, `europe-west1`, project `claude-conductor-62582`) that wakes the Conductor Android app through FCM when a chat blocks on the user. Only the relay holds Firebase credentials (its own default service account); daemons hold a per-phone `handle` + `secret`.

## API

All routes are POST with a JSON body of at most 4 KB (413 over). Non-POST is 405, unknown path 404, bad or missing fields 400 `{ "error": "..." }`.

| Route | Body | Result |
| --- | --- | --- |
| `/register` | `{ token }` | 200 `{ handle, secret }`; 429 over 20 registrations/hour/IP |
| `/update` | `{ handle, secret, token }` | 204; 401 bad secret; 404 unknown handle |
| `/unregister` | `{ handle, secret }` | 204 (also if already gone); 401 bad secret |
| `/send` | `{ handle, secret, chatId, chatName? }` | 204; 401; 404 unknown handle or dead FCM token (handle deleted); 429 over 60 sends/hour/handle; 502 other FCM error |

`/send` pushes a data-only message `{ type: "blocked", chatId, chatName? }` with high priority and a 1 hour TTL.

## Develop

```
cd functions
npm install
npm test
```

## Deploy

```
firebase deploy --only functions --project claude-conductor-62582
```

run from `relay/`. If it stops at "User code failed to load. Cannot determine backend specification. Timeout after 10000", set `FUNCTIONS_DISCOVERY_TIMEOUT=60` first (needed on Joe's PC, 2026-10-24): the CLI's 10s default is too short to load firebase-admin there.

The per-IP limit keys on the last `X-Forwarded-For` entry, the one Google's front end appends: the framework trusts the proxy, so `req.ip` is the first entry, which the caller can set to anything.

Rate-limit rows in `ipLimits` carry an `expireAt` timestamp at the end of their window. Firestore deletes them through a TTL policy, set once per project:

```
gcloud firestore fields ttls update expireAt --collection-group=ipLimits --enable-ttl --project claude-conductor-62582
```

`handles` has no TTL: a handle whose phone reinstalled is deleted by the next send that hits its dead FCM token, and expiring a live but quiet phone's handle would stop its pushes with nothing telling the phone to register again.
