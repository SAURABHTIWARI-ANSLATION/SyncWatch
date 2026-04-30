'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SyncWatch — Offscreen Document
// Hosts the persistent WebSocket connection. Chrome cannot suspend this
// document as long as we periodically write to IndexedDB.
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_WS = 'wss://syncwatch-ad6y.onrender.com';

// One socket per "tabId" key — we use 'GLOBAL' as the single key
const sockets = {};

// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB keep-alive — prevents Chrome from suspending offscreen documents
// ─────────────────────────────────────────────────────────────────────────────

let keepAliveDB = null;

(function initDB() {
  try {
    const req = indexedDB.open('sw_keepalive', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('ping', { keyPath: 'id' });
    req.onsuccess       = e => { keepAliveDB = e.target.result; };
    req.onerror         = () => console.warn('[Offscreen] IndexedDB init failed');
  } catch (e) {
    console.warn('[Offscreen] IndexedDB unavailable:', e);
  }
})();

function pingDB() {
  if (!keepAliveDB) return;
  try {
    keepAliveDB.transaction('ping', 'readwrite').objectStore('ping').put({ id: 1, ts: Date.now() });
  } catch (_) {}
}

// Ping DB every 25s to stay alive
setInterval(pingDB, 25_000);

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket management
// ─────────────────────────────────────────────────────────────────────────────

function openSocket(tabId, roomId, userId) {
  // Close any existing socket for this key
  const existing = sockets[tabId];
  if (existing) {
    if (existing._pingTimer) clearInterval(existing._pingTimer);
    try { existing.close(); } catch (_) {}
    delete sockets[tabId];
  }

  const ws = new WebSocket(BACKEND_WS);
  sockets[tabId] = ws;

  ws.onopen = () => {
    // Send join immediately after connection
    ws.send(JSON.stringify({ type: 'join', roomId, userId }));

    // Heartbeat every 30s keeps the WS alive through idle timeouts
    ws._pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
        pingDB();
      } else {
        clearInterval(ws._pingTimer);
      }
    }, 30_000);
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    // Filter out server acks — they are not events for the UI
    if (msg.type === 'pong' || msg.type === 'heartbeat_ack') return;

    chrome.runtime.sendMessage({
      target:  'background',
      sw:      'from_server',
      tabId,
      payload: msg
    }).catch(() => {});
  };

  ws.onclose = () => {
    if (ws._pingTimer) clearInterval(ws._pingTimer);
    delete sockets[tabId];
    chrome.runtime.sendMessage({ target: 'background', sw: 'ws_closed', tabId }).catch(() => {});
  };

  ws.onerror = () => {
    chrome.runtime.sendMessage({
      target: 'background',
      sw:     'ws_error',
      tabId,
      msg:    'WebSocket connection failed'
    }).catch(() => {});
  };
}

function closeSocket(tabId) {
  const ws = sockets[tabId];
  if (!ws) return;
  if (ws._pingTimer) clearInterval(ws._pingTimer);
  try { ws.close(); } catch (_) {}
  delete sockets[tabId];
}

function sendOnSocket(tabId, payload) {
  const ws = sockets[tabId];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.warn('[Offscreen] Cannot send — WS not open for', tabId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message listener — commands from background
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
  if (msg.target !== 'offscreen') return;

  switch (msg.sw) {
    case 'connect':
      openSocket(msg.tabId, msg.roomId, msg.userId);
      break;
    case 'send':
      sendOnSocket(msg.tabId, msg.payload);
      break;
    case 'close':
      closeSocket(msg.tabId);
      break;
    case 'ping':
      // Background alarm woke us — just ping DB
      pingDB();
      break;
  }
});

console.log('[Offscreen] Loaded');