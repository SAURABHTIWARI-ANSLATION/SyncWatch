// ─────────────────────────────────────────────────────────────────
// SyncWatch Extension — Background Service Worker
// Talks to: https://syncwatch-64jv.onrender.com  (WebSocket + REST)
// ─────────────────────────────────────────────────────────────────
'use strict';

const BACKEND_HTTP = 'https://syncwatch-64jv.onrender.com';
const BACKEND_WS   = 'wss://syncwatch-64jv.onrender.com';

// Per-tab state:
// { roomId, userId, wsUrl, isHost, vframe, vidscore, memberCount }
let db = {};

// One shared WebSocket per tab (keyed by tabId)
let sockets = {};

// Restore session state on startup
chrome.storage.session.get(['db']).then(d => {
  db = d.db || {};
});

function saveDb() {
  chrome.storage.session.set({ db });
}

// ── Utility ──────────────────────────────────────────────────────

function sendToTab(tabId, msg, frameId = 0) {
  chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {});
}

function wsSend(tabId, msg) {
  const ws = sockets[tabId];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── WebSocket management ──────────────────────────────────────────

function connectWS(tabId, roomId, isHost) {
  // Close existing socket for this tab
  if (sockets[tabId]) {
    try { sockets[tabId].close(); } catch (_) {}
  }

  const ws = new WebSocket(BACKEND_WS);
  sockets[tabId] = ws;

  ws.onopen = () => {
    console.log(`[SW] WS open for tab ${tabId}, joining room ${roomId}`);
    ws.send(JSON.stringify({ type: 'join', roomId }));
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(tabId, msg);
  };

  ws.onclose = () => {
    console.log(`[SW] WS closed for tab ${tabId}`);
    sendToTab(tabId, { sw: 'disconnected' });
    delete sockets[tabId];
  };

  ws.onerror = err => {
    console.error(`[SW] WS error for tab ${tabId}:`, err);
    sendToTab(tabId, { sw: 'error', msg: 'WebSocket connection failed' });
  };
}

// ── Handle messages FROM server ───────────────────────────────────

function handleServerMessage(tabId, msg) {
  switch (msg.type) {

    case 'joined':
      if (!db[tabId]) db[tabId] = {};
      db[tabId].userId = msg.userId;
      db[tabId].roomId = msg.roomId;
      db[tabId].memberCount = msg.memberCount;
      saveDb();

      // Forward to content + popup
      sendToTab(tabId, { sw: 'joined', roomId: msg.roomId, userId: msg.userId, memberCount: msg.memberCount, state: msg.state });
      // Notify popup if open
      chrome.runtime.sendMessage({ sw: 'joined', tabId, roomId: msg.roomId, memberCount: msg.memberCount, state: msg.state }).catch(() => {});
      break;

    case 'play':
      sendToTab(tabId, { sw: 'play', time: msg.time, userId: msg.userId });
      chrome.runtime.sendMessage({ sw: 'play', tabId, time: msg.time, userId: msg.userId }).catch(() => {});
      break;

    case 'pause':
      sendToTab(tabId, { sw: 'pause', time: msg.time, userId: msg.userId });
      chrome.runtime.sendMessage({ sw: 'pause', tabId, time: msg.time, userId: msg.userId }).catch(() => {});
      break;

    case 'seek':
      sendToTab(tabId, { sw: 'seek', time: msg.time, userId: msg.userId });
      chrome.runtime.sendMessage({ sw: 'seek', tabId, time: msg.time, userId: msg.userId }).catch(() => {});
      break;

    case 'sync':
      sendToTab(tabId, { sw: 'sync', state: msg.state });
      break;

    case 'chat':
      sendToTab(tabId, { sw: 'chat', text: msg.text, userId: msg.userId, ts: msg.ts });
      chrome.runtime.sendMessage({ sw: 'chat', tabId, text: msg.text, userId: msg.userId }).catch(() => {});
      break;

    case 'user_joined':
      if (db[tabId]) db[tabId].memberCount = msg.memberCount;
      saveDb();
      sendToTab(tabId, { sw: 'user_joined', userId: msg.userId, memberCount: msg.memberCount });
      chrome.runtime.sendMessage({ sw: 'user_joined', tabId, userId: msg.userId, memberCount: msg.memberCount }).catch(() => {});
      break;

    case 'user_left':
      if (db[tabId]) db[tabId].memberCount = msg.memberCount;
      saveDb();
      sendToTab(tabId, { sw: 'user_left', userId: msg.userId, memberCount: msg.memberCount });
      chrome.runtime.sendMessage({ sw: 'user_left', tabId, userId: msg.userId, memberCount: msg.memberCount }).catch(() => {});
      break;

    case 'signal':
      // WebRTC signaling — forward to content script (screen share)
      sendToTab(tabId, { sw: 'signal', senderId: msg.senderId, signalData: msg.signalData });
      break;

    case 'error':
      sendToTab(tabId, { sw: 'error', msg: msg.msg });
      chrome.runtime.sendMessage({ sw: 'error', tabId, msg: msg.msg }).catch(() => {});
      break;

    case 'heartbeat_ack':
      break;
  }
}

// ── Handle messages FROM popup / content scripts ──────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderTabId = sender.tab ? sender.tab.id : null;

  // ── Popup: Create Room ──
  if (msg.action === 'createRoom') {
    fetch(`${BACKEND_HTTP}/room/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(r => r.json())
      .then(data => {
        const roomId = data.roomId;
        const tabId  = msg.tabId;

        db[tabId] = {
          roomId,
          isHost: true,
          userId: null,
          memberCount: 1,
          vframe: null,
          vidscore: 0
        };
        saveDb();

        connectWS(tabId, roomId, true);
        sendResponse({ ok: true, roomId });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  // ── Popup: Join Room ──
  if (msg.action === 'joinRoom') {
    const roomId = (msg.roomId || '').toUpperCase().trim();
    const tabId  = msg.tabId;

    // Check if room exists first
    fetch(`${BACKEND_HTTP}/room/${roomId}`)
      .then(r => r.json())
      .then(data => {
        if (!data.exists) {
          sendResponse({ ok: false, error: `Room "${roomId}" not found or expired.` });
          return;
        }
        db[tabId] = {
          roomId,
          isHost: false,
          userId: null,
          memberCount: 0,
          vframe: null,
          vidscore: 0
        };
        saveDb();
        connectWS(tabId, roomId, false);
        sendResponse({ ok: true, roomId });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Popup: Leave Room ──
  if (msg.action === 'leaveRoom') {
    const tabId = msg.tabId;
    if (sockets[tabId]) {
      try { sockets[tabId].close(); } catch (_) {}
      delete sockets[tabId];
    }
    if (db[tabId]) {
      delete db[tabId];
      saveDb();
    }
    sendToTab(tabId, { sw: 'left' });
    sendResponse({ ok: true });
    return true;
  }

  // ── Popup / Content: Get status for a tab ──
  if (msg.action === 'getStatus') {
    const tabId = msg.tabId;
    sendResponse({
      room: db[tabId] || null,
      connected: !!(sockets[tabId] && sockets[tabId].readyState === WebSocket.OPEN)
    });
    return true;
  }

  // ── Content: Playback events (play/pause/seek) → forward to server ──
  if (msg.action === 'playbackEvent' && senderTabId) {
    const tabId = senderTabId;
    if (!db[tabId]) return;
    wsSend(tabId, msg.event);
    return;
  }

  // ── Content: Chat message from controls overlay ──
  if (msg.action === 'sendChat' && senderTabId) {
    wsSend(senderTabId, { type: 'chat', text: msg.text });
    return;
  }

  // ── Content: WebRTC signal (screen share) ──
  if (msg.action === 'signal' && senderTabId) {
    wsSend(senderTabId, {
      type: 'signal',
      targetId: msg.targetId,
      signalData: msg.signalData
    });
    return;
  }

  // ── Content: Heartbeat ──
  if (msg.action === 'heartbeat' && senderTabId) {
    wsSend(senderTabId, { type: 'heartbeat' });
    return;
  }

  // ── Content: Video found (score detection) ──
  if (msg.action === 'videoFound' && senderTabId) {
    if (!db[senderTabId]) return;
    if (msg.score > (db[senderTabId].vidscore || 0)) {
      db[senderTabId].vidscore = msg.score;
      db[senderTabId].vframe  = sender.frameId;
      saveDb();
    }
    return;
  }

  // ── Content: Sync request ──
  if (msg.action === 'syncRequest' && senderTabId) {
    wsSend(senderTabId, { type: 'sync_request' });
    return;
  }
});

// ── Tab cleanup ───────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  if (sockets[tabId]) {
    try { sockets[tabId].close(); } catch (_) {}
    delete sockets[tabId];
  }
  if (db[tabId]) {
    delete db[tabId];
    saveDb();
  }
});
