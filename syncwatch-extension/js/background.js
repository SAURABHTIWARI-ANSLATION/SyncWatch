// ─────────────────────────────────────────────────────────────────
// SyncWatch Extension — Background Service Worker (REFACTORED v3.0)
// Fixes (PRD):
//  - Alarm-based keepalive pings offscreen every ~24s to prevent suspension
//  - isHost flag forwarded to content script on 'joined'
//  - sync_request & host_only_mode relayed from server to tab
//  - hostOnlyToggle action handled here + relayed to room via WS
// ─────────────────────────────────────────────────────────────────
'use strict';

const BACKEND_HTTP = 'https://syncwatch-64jv.onrender.com';
let db = {}; // Per-tab state (synced with storage)

// ── Init ──────────────────────────────────────────────────────────

chrome.storage.session.get(['db']).then(d => {
  db = d.db || {};
  console.log('[SW Background] DB initialized:', db);
});

function saveDb() {
  chrome.storage.session.set({ db });
}

// ── Alarm-based Keep-Alive ────────────────────────────────────────
// PRD Fix: Register a repeating alarm that pings the offscreen document,
// ensuring Chrome cannot silently garbage-collect it under memory pressure.

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 }); // ~24 seconds
});

// Also register on service worker startup (handles browser restarts)
chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'sw-keepalive') return;
  // Ensure offscreen document exists, then ping it
  try {
    await setupOffscreen();
    chrome.runtime.sendMessage({ target: 'offscreen', sw: 'ping' }).catch(() => { });
  } catch (e) {
    console.warn('[SW Background] Keep-alive setupOffscreen error:', e);
  }
});

// ── Utility ──────────────────────────────────────────────────────

async function setupOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['LOCAL_STORAGE'],
    justification: 'Maintaining a stable WebSocket connection for real-time video synchronization.'
  });
}

function sendToTab(tabId, msg, retries = 3) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {
    if (retries > 0) {
      setTimeout(() => sendToTab(tabId, msg, retries - 1), 500);
    } else {
      console.warn(`[SW Background] Failed to send to tab ${tabId} after retries.`);
    }
  });
}

async function offscreenSend(tabId, swAction, payload = null) {
  await setupOffscreen();
  chrome.runtime.sendMessage({
    target: 'offscreen',
    sw: swAction,
    tabId,
    roomId: payload?.roomId,
    userId: payload?.userId,
    payload
  });
}

// ── Handle messages FROM offscreen (relay to tabs) ─────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== 'background') return;

  const tabId = msg.tabId;
  switch (msg.sw) {
    case 'from_server':
      handleServerMessage(tabId, msg.payload);
      break;
    case 'ws_closed':
      sendToTab(tabId, { sw: 'disconnected' });
      break;
    case 'ws_error':
      sendToTab(tabId, { sw: 'error', msg: msg.msg });
      break;
  }
});

function handleServerMessage(tabId, msg) {
  if (!tabId) return;

  switch (msg.type) {
    case 'joined':
      if (!db[tabId]) db[tabId] = {};
      db[tabId].userId = msg.userId;
      db[tabId].roomId = msg.roomId;
      db[tabId].memberCount = msg.memberCount;
      db[tabId].otherUsers = msg.otherUsers || [];
      saveDb();
      // PRD Fix: forward isHost so content script can enforce RBAC
      sendToTab(tabId, { sw: 'joined', ...msg, isHost: db[tabId].isHost || false });
      break;

    case 'user_joined':
    case 'user_left':
      if (db[tabId]) {
        db[tabId].memberCount = msg.memberCount;
        if (msg.type === 'user_joined') {
          if (!db[tabId].otherUsers) db[tabId].otherUsers = [];
          if (!db[tabId].otherUsers.includes(msg.userId)) db[tabId].otherUsers.push(msg.userId);
        } else {
          if (db[tabId].otherUsers) db[tabId].otherUsers = db[tabId].otherUsers.filter(id => id !== msg.userId);
        }
        saveDb();
      }
      // Broadcast to both the content script and any open extension pages (like the popup)
      const broadcastMsg = { sw: msg.type, tabId, ...msg };
      sendToTab(tabId, broadcastMsg);
      chrome.runtime.sendMessage(broadcastMsg).catch(() => {}); // Popup might be closed, ignore error
      break;

    // PRD Fix: relay sync_request so the host can respond with current video state
    case 'sync_request':
      sendToTab(tabId, { sw: 'sync_request', fromUserId: msg.userId });
      break;

    // PRD Fix: relay host_only_mode changes to all room members
    case 'host_only_mode':
      if (db[tabId]) {
        db[tabId].hostOnlyMode = msg.state;
        saveDb();
      }
      sendToTab(tabId, { sw: 'host_only_mode', state: msg.state, userId: msg.userId });
      break;

    case 'play':
    case 'pause':
    case 'seek':
    case 'sync':
    case 'chat':
    case 'signal':
    case 'error':
      sendToTab(tabId, { sw: msg.type, ...msg });
      break;
  }
}

// ── Handle messages FROM Content/Popup ────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'background' || msg.target === 'offscreen') return;

  const senderTabId = sender.tab ? sender.tab.id : null;

  switch (msg.action) {
    case 'createRoom':
      fetch(`${BACKEND_HTTP}/room/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
        .then(r => r.json())
        .then(data => {
          const { roomId, hostId } = data;
          const tabId = msg.tabId;
          db[tabId] = { roomId, hostId, persistentUserId: msg.userId, isHost: true, memberCount: 1, otherUsers: [], hostOnlyMode: false };
          saveDb();
          offscreenSend(tabId, 'connect', { roomId, userId: msg.userId });
          sendResponse({ ok: true, roomId });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'joinRoom':
      const rId = (msg.roomId || '').toUpperCase().trim();
      fetch(`${BACKEND_HTTP}/room/${rId}`)
        .then(r => r.json())
        .then(data => {
          if (!data.exists) return sendResponse({ ok: false, error: `Room "${rId}" not found.` });
          const tabId = msg.tabId;
          db[tabId] = { roomId: rId, persistentUserId: msg.userId, isHost: false, memberCount: 0, otherUsers: [], hostOnlyMode: false };
          saveDb();
          offscreenSend(tabId, 'connect', { roomId: rId, userId: msg.userId });
          sendResponse({ ok: true, roomId: rId });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'leaveRoom':
      const ltId = msg.tabId || senderTabId;
      if (ltId) {
        offscreenSend(ltId, 'close');
        delete db[ltId];
        saveDb();
        sendToTab(ltId, { sw: 'left' });
      }
      sendResponse({ ok: true });
      break;

    case 'getStatus':
      const stId = msg.tabId || senderTabId;
      sendResponse({
        room: stId ? (db[stId] || null) : null,
        connected: stId ? true : false
      });
      break;

    // PRD Fix: hostOnlyToggle — store in db + relay to room via WS
    case 'hostOnlyToggle':
      if (senderTabId && db[senderTabId]) {
        db[senderTabId].hostOnlyMode = msg.state;
        saveDb();
        offscreenSend(senderTabId, 'send', {
          type: 'host_only_mode',
          state: msg.state
        });
      }
      break;

    case 'playbackEvent':
    case 'sendChat':
    case 'signal':
    case 'heartbeat':
    case 'syncRequest':
      if (senderTabId) {
        const payload = { ...msg };
        if (msg.action === 'playbackEvent') {
          Object.assign(payload, msg.event);
        } else if (msg.action === 'sendChat') {
          payload.type = 'chat';
        } else if (msg.action === 'syncRequest') {
          payload.type = 'sync_request';
        }
        offscreenSend(senderTabId, 'send', payload);
      }
      break;

    case 'requestScreenShare':
      if (senderTabId) {
        chrome.windows.create({
          url: `share-prompt.html?tabId=${senderTabId}`,
          type: 'popup',
          width: 420,
          height: 300
        });
      }
      break;

    case 'internal':
      if (msg.action === 'shareIdCaptured') {
        sendToTab(msg.tabId, { sw: 'screenShareGranted', streamId: msg.streamId });
      }
      break;
  }
});

// ── Tab cleanup ───────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  offscreenSend(tabId, 'close');
  if (db[tabId]) { delete db[tabId]; saveDb(); }
});