// Claude Conductor Browser Bridge.
//
// A thin proxy: the Conductor daemon calls a fixed set of chrome.* functions
// through it and hears their events back. Which chat owns which window and
// tab, and how CDP sessions route, lives entirely in the daemon, so this
// file holds no per-chat state and a service worker restart loses nothing
// the daemon cannot rebuild.
//
// Pairing: the daemon's port and secret come from the native messaging host
// the daemon registers. Only an extension listed in that host's
// allowed_origins (this one, by its pinned key) can start it, so no web page
// or other extension can learn the secret.

const HOST = 'com.claude_conductor.browser';
const RECONNECT_ALARM = 'reconnect';

// Everything the daemon may call. Anything else is refused, so a compromised
// daemon link still cannot reach bookmarks, history, downloads or settings.
const CALLS = {
  'debugger.attach': (target, version) => chrome.debugger.attach(target, version),
  'debugger.detach': (target) => chrome.debugger.detach(target),
  'debugger.sendCommand': (target, method, params) => chrome.debugger.sendCommand(target, method, params),
  'tabs.create': (props) => chrome.tabs.create(props),
  'tabs.get': (tabId) => chrome.tabs.get(tabId),
  'tabs.update': (tabId, props) => chrome.tabs.update(tabId, props),
  'tabs.remove': (tabIds) => chrome.tabs.remove(tabIds),
  'windows.create': (props) => chrome.windows.create(props),
  'windows.get': (windowId, query) => chrome.windows.get(windowId, query),
  'windows.update': (windowId, props) => chrome.windows.update(windowId, props),
  'windows.remove': (windowId) => chrome.windows.remove(windowId),
};

let socket = null;
let connecting = false;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function emit(event, args) {
  send({ event, args });
}

// Listeners sit at the top level: an MV3 worker woken by one of these events
// only delivers it to listeners registered synchronously on startup.
chrome.debugger.onEvent.addListener((source, method, params) => emit('debugger.onEvent', [source, method, params]));
chrome.debugger.onDetach.addListener((source, reason) => emit('debugger.onDetach', [source, reason]));
chrome.tabs.onCreated.addListener((tab) => emit('tabs.onCreated', [tab]));
chrome.tabs.onRemoved.addListener((tabId, info) => emit('tabs.onRemoved', [tabId, info]));
chrome.windows.onRemoved.addListener((windowId) => emit('windows.onRemoved', [windowId]));
// openerTabId on tabs.onCreated is unreliable for window.open popups; this
// event always names the tab that opened the new one.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) =>
  emit('webNavigation.onCreatedNavigationTarget', [details]),
);

function browserName() {
  if (navigator.brave) return 'brave';
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (brands.includes('Microsoft Edge')) return 'edge';
  if (brands.includes('Google Chrome')) return 'chrome';
  return 'chromium';
}

async function installId() {
  const { installId } = await chrome.storage.local.get('installId').catch(() => ({}));
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id }).catch(() => {});
  return id;
}

async function handle(message) {
  const call = CALLS[message.call];
  if (!call) {
    send({ id: message.id, error: `not allowed: ${message.call}` });
    return;
  }
  try {
    const result = await call(...(message.args ?? []));
    send({ id: message.id, result: result ?? null });
  } catch (e) {
    send({ id: message.id, error: String(e?.message ?? e) });
  }
}

async function connect() {
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  try {
    // Fails when the daemon is not running or never registered the host;
    // the reconnect alarm tries again.
    const pairing = await chrome.runtime.sendNativeMessage(HOST, { type: 'pair' });
    if (!pairing?.port || !pairing?.token) return;
    const url = `ws://127.0.0.1:${pairing.port}/extension?token=${encodeURIComponent(pairing.token)}`;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = async () => {
      send({
        event: 'hello',
        args: [{ browser: browserName(), userAgent: navigator.userAgent, installId: await installId(), version: chrome.runtime.getManifest().version }],
      });
    };
    ws.onmessage = (e) => {
      let message;
      try {
        message = JSON.parse(e.data);
      } catch {
        return;
      }
      // The daemon pings to keep this worker alive: any message on an open
      // WebSocket resets the MV3 idle timer.
      if (message.ping) return send({ pong: message.ping });
      if (message.id !== undefined) handle(message);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
    };
  } catch {
    // Retried by the alarm.
  } finally {
    connecting = false;
  }
}

// Wakes the worker to reconnect after the daemon restarts; 30s is the
// shortest period Chrome allows.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
