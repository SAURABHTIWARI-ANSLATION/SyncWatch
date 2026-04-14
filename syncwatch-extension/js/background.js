// ─────────────────────────────────────────────────────────────────
// SyncWatch Extension — Background Service Worker  (FIXED v1.1)
// ─────────────────────────────────────────────────────────────────
'use strict';

const BACKEND_HTTP = 'https://syncwatch-64jv.onrender.com';
const BACKEND_WS = 'wss://syncwatch-64jv.onrender.com';

let db = {};   // Per-tab state
let sockets = {};   // One WebSocket per tab

chrome.storage.session.get(['db']).then(d => { db = d.db || {}; });

function saveDb() { chrome.storage.session.set({ db }); }

// ── Utility ──────────────────────────────────────────────────────

function sendToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => { });
}

function wsSend(tabId, msg) {
  const ws = sockets[tabId];
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── WebSocket management ──────────────────────────────────────────

function connectWS(tabId, roomId, isHost) {
  if (sockets[tabId]) { try { sockets[tabId].close(); } catch (_) { } }

  const ws = new WebSocket(BACKEND_WS);
  sockets[tabId] = ws;

  ws.onopen = () => {
    console.log(`[SW] WS open tab=${tabId} room=${roomId}`);
    const hostSecret = db[tabId] ? db[tabId].hostSecret : null;
    ws.send(JSON.stringify({ type: 'join', roomId, hostSecret }));
  };

  ws.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(tabId, msg);
  };

  ws.onclose = () => {
    console.log(`[SW] WS closed tab=${tabId}`);
    sendToTab(tabId, { sw: 'disconnected' });
    delete sockets[tabId];
  };

  ws.onerror = () => {
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
      // FIX: store otherUsers so they're available for getStatus calls
      db[tabId].otherUsers = msg.otherUsers || [];
      saveDb();

      // FIX: forward otherUsers to content script so screen share knows who to offer
      sendToTab(tabId, {
        sw: 'joined',
        roomId: msg.roomId,
        userId: msg.userId,
        memberCount: msg.memberCount,
        state: msg.state,
        otherUsers: msg.otherUsers || []
      });
      chrome.runtime.sendMessage({
        sw: 'joined', tabId,
        roomId: msg.roomId,
        memberCount: msg.memberCount,
        state: msg.state
      }).catch(() => { });
      break;

    case 'play':
      sendToTab(tabId, { sw: 'play', time: msg.time, userId: msg.userId });
      chrome.runtime.sendMessage({ sw: 'play', tabId, time: msg.time, userId: msg.userId }).catch(() => { });
      break;

    case 'pause':
      sendToTab(tabId, { sw: 'pause', time: msg.time, userId: msg.userId });
      chrome.runtime.sendMessage({ sw: 'pause', tabId, time: msg.time, userId: msg.userId }).catch(() => { });
      break;

    case 'seek':
      sendToTab(tabId, { sw: 'seek', time: msg.time, userId: msg.userId });
      chrome.runtime.sendMessage({ sw: 'seek', tabId, time: msg.time, userId: msg.userId }).catch(() => { });
      break;

    case 'sync':
      sendToTab(tabId, { sw: 'sync', state: msg.state });
      break;

    case 'chat':
      sendToTab(tabId, { sw: 'chat', text: msg.text, userId: msg.userId, ts: msg.ts });
      chrome.runtime.sendMessage({ sw: 'chat', tabId, text: msg.text, userId: msg.userId }).catch(() => { });
      break;

    case 'user_joined':
      if (db[tabId]) {
        db[tabId].memberCount = msg.memberCount;
        // FIX: maintain otherUsers list so screen share can reach new viewers
        if (!db[tabId].otherUsers) db[tabId].otherUsers = [];
        if (!db[tabId].otherUsers.includes(msg.userId)) {
          db[tabId].otherUsers.push(msg.userId);
        }
        saveDb();
      }
      sendToTab(tabId, { sw: 'user_joined', userId: msg.userId, memberCount: msg.memberCount });
      chrome.runtime.sendMessage({ sw: 'user_joined', tabId, userId: msg.userId, memberCount: msg.memberCount }).catch(() => { });
      break;

    case 'user_left':
      if (db[tabId]) {
        db[tabId].memberCount = msg.memberCount;
        // FIX: remove departed user from otherUsers list
        if (db[tabId].otherUsers) {
          db[tabId].otherUsers = db[tabId].otherUsers.filter(id => id !== msg.userId);
        }
        saveDb();
      }
      sendToTab(tabId, { sw: 'user_left', userId: msg.userId, memberCount: msg.memberCount });
      chrome.runtime.sendMessage({ sw: 'user_left', tabId, userId: msg.userId, memberCount: msg.memberCount }).catch(() => { });
      break;

    case 'signal':
      sendToTab(tabId, { sw: 'signal', senderId: msg.senderId, signalData: msg.signalData });
      break;

    case 'error':
      sendToTab(tabId, { sw: 'error', msg: msg.msg });
      chrome.runtime.sendMessage({ sw: 'error', tabId, msg: msg.msg }).catch(() => { });
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
        const hostSecret = data.hostSecret;
        const tabId = msg.tabId;
        db[tabId] = { roomId, hostSecret, isHost: true, userId: null, memberCount: 1, otherUsers: [] };
        saveDb();
        connectWS(tabId, roomId, true);
        sendResponse({ ok: true, roomId });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Popup: Join Room ──
  if (msg.action === 'joinRoom') {
    const roomId = (msg.roomId || '').toUpperCase().trim();
    const tabId = msg.tabId;
    fetch(`${BACKEND_HTTP}/room/${roomId}`)
      .then(r => r.json())
      .then(data => {
        if (!data.exists) {
          sendResponse({ ok: false, error: `Room "${roomId}" not found or expired.` });
          return;
        }
        db[tabId] = { roomId, isHost: false, userId: null, memberCount: 0, otherUsers: [] };
        saveDb();
        connectWS(tabId, roomId, false);
        sendResponse({ ok: true, roomId });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Popup / Content: Leave Room ──
  // FIX: accept tabId from popup OR use senderTabId from content script
  if (msg.action === 'leaveRoom') {
    const tabId = msg.tabId || senderTabId;
    if (!tabId) { sendResponse && sendResponse({ ok: false, error: 'No tabId' }); return true; }
    if (sockets[tabId]) { try { sockets[tabId].close(); } catch (_) { } delete sockets[tabId]; }
    if (db[tabId]) { delete db[tabId]; saveDb(); }
    sendToTab(tabId, { sw: 'left' });
    sendResponse && sendResponse({ ok: true });
    return true;
  }

  // ── Popup / Content: Get status ──
  // FIX: use senderTabId as fallback when msg.tabId is null (content script calls)
  if (msg.action === 'getStatus') {
    const tabId = msg.tabId || senderTabId;
    sendResponse({
      room: tabId ? (db[tabId] || null) : null,
      connected: tabId ? !!(sockets[tabId] && sockets[tabId].readyState === WebSocket.OPEN) : false
    });
    return true;
  }

  // ── Content: Playback events → forward to server ──
  if (msg.action === 'playbackEvent' && senderTabId) {
    if (!db[senderTabId]) return;
    wsSend(senderTabId, msg.event);
    return;
  }

  // ── Content: Chat message ──
  if (msg.action === 'sendChat' && senderTabId) {
    wsSend(senderTabId, { type: 'chat', text: msg.text });
    return;
  }

  // ── Content: WebRTC signal (screen share) ──
  if (msg.action === 'signal' && senderTabId) {
    wsSend(senderTabId, { type: 'signal', targetId: msg.targetId, signalData: msg.signalData });
    return;
  }

  // ── Content: Heartbeat ──
  if (msg.action === 'heartbeat' && senderTabId) {
    wsSend(senderTabId, { type: 'heartbeat' });
    return;
  }

  // ── Content: Video found ──
  if (msg.action === 'videoFound' && senderTabId) {
    if (!db[senderTabId]) return;
    if (msg.score > (db[senderTabId].vidscore || 0)) {
      db[senderTabId].vidscore = msg.score;
      db[senderTabId].vframe = sender.frameId;
      saveDb();
    }
    return;
  }

  // ── Content: Sync request ──
  if (msg.action === 'syncRequest' && senderTabId) {
    wsSend(senderTabId, { type: 'sync_request' });
    return;
  }

  // ── Content: Screen Share Request (Native Desktop Capture) ──
  if (msg.action === 'requestScreenShare' && senderTabId) {
    chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab', 'audio'], sender.tab, (streamId) => {
      sendToTab(senderTabId, { sw: 'screenShareGranted', streamId });
    });
    return true;
  }
});

// ── Tab cleanup ───────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  if (sockets[tabId]) { try { sockets[tabId].close(); } catch (_) { } delete sockets[tabId]; }
  if (db[tabId]) { delete db[tabId]; saveDb(); }
});