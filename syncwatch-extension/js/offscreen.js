// ─────────────────────────────────────────────────────────────────
// SyncWatch — Offscreen Document (Persistent WebSocket)
// FIX v2.1: Added IndexedDB keep-alive + WS PING/PONG to prevent
//           Chrome from suspending the offscreen document under
//           memory pressure (PRD: Service Worker Hibernation fix).
// ─────────────────────────────────────────────────────────────────
'use strict';

const BACKEND_WS = 'wss://syncwatch-64jv.onrender.com';
let sockets = {};

// ── IndexedDB Keep-Alive ──────────────────────────────────────────
// Writing to IndexedDB every 25s signals to Chrome that this document
// is still actively in use, preventing premature suspension.

let keepAliveDB = null;

function initKeepAliveDB() {
  try {
    const req = indexedDB.open('sw_keepalive', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('ping', { keyPath: 'id' });
    };
    req.onsuccess = e => {
      keepAliveDB = e.target.result;
      console.log('[SW Offscreen] IndexedDB keep-alive initialized');
    };
    req.onerror = () => console.warn('[SW Offscreen] IndexedDB init failed, keep-alive disabled');
  } catch (e) {
    console.warn('[SW Offscreen] IndexedDB unavailable:', e);
  }
}

function pingIndexedDB() {
  if (!keepAliveDB) return;
  try {
    const tx = keepAliveDB.transaction('ping', 'readwrite');
    tx.objectStore('ping').put({ id: 1, ts: Date.now() });
  } catch (e) {
    // Non-fatal; DB may have been closed
  }
}

// Write to IndexedDB every 25 seconds to stay alive
setInterval(pingIndexedDB, 25000);
initKeepAliveDB();

// ── WebSocket PING/PONG ───────────────────────────────────────────
// Send a heartbeat ping to the backend every 30s per socket.
// This keeps the WS connection alive through idle timeouts and also
// re-confirms the offscreen document is actively running.

function startWsPing(tabId) {
  // Clear any existing ping interval for this tab
  if (sockets[tabId]?._pingInterval) {
    clearInterval(sockets[tabId]._pingInterval);
  }
  const interval = setInterval(() => {
    const ws = sockets[tabId];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (_) { }
    // Also write to IndexedDB to keep offscreen alive
    pingIndexedDB();
  }, 30000);

  if (sockets[tabId]) sockets[tabId]._pingInterval = interval;
  return interval;
}

console.log('[SW Offscreen] Offscreen document loaded');

// ── Message listener ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.sw) {
    case 'connect':
      connectWS(msg.tabId, msg.roomId, msg.userId);
      break;
    case 'send':
      wsSend(msg.tabId, msg.payload);
      break;
    case 'close':
      if (sockets[msg.tabId]) {
        if (sockets[msg.tabId]._pingInterval) clearInterval(sockets[msg.tabId]._pingInterval);
        try { sockets[msg.tabId].close(); } catch (_) { }
        delete sockets[msg.tabId];
      }
      break;
    case 'ping':
      // Background alarm woke us — write to IndexedDB to confirm we're alive
      pingIndexedDB();
      break;
  }
});

// ── WebSocket management ──────────────────────────────────────────

function connectWS(tabId, roomId, userId) {
  if (sockets[tabId]) {
    if (sockets[tabId]._pingInterval) clearInterval(sockets[tabId]._pingInterval);
    try { sockets[tabId].close(); } catch (_) { }
  }

  console.log(`[SW Offscreen] Connecting to WS: tab=${tabId}, room=${roomId}`);
  const ws = new WebSocket(BACKEND_WS);
  sockets[tabId] = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', roomId, userId }));
    startWsPing(tabId);
  };

  ws.onmessage = e => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }

    // Silently absorb server-side pong responses; don't relay them
    if (payload.type === 'pong') return;

    chrome.runtime.sendMessage({
      target: 'background',
      sw: 'from_server',
      tabId,
      payload
    });
  };

  ws.onclose = () => {
    if (sockets[tabId]?._pingInterval) clearInterval(sockets[tabId]._pingInterval);
    chrome.runtime.sendMessage({ target: 'background', sw: 'ws_closed', tabId });
    delete sockets[tabId];
  };

  ws.onerror = () => {
    chrome.runtime.sendMessage({ target: 'background', sw: 'ws_error', tabId, msg: 'WebSocket failed' });
  };
}

function wsSend(tabId, payload) {
  const ws = sockets[tabId];
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Flatten playbackEvent wrapper if present (legacy path)
    if (payload.action === 'playbackEvent' && payload.event) {
      ws.send(JSON.stringify(payload.event));
    } else {
      ws.send(JSON.stringify(payload));
    }
  } else {
    console.warn(`[SW Offscreen] Cannot send: WS not open for tab ${tabId}`);
  }
}