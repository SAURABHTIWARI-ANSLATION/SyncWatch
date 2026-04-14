// ─────────────────────────────────────────────────────────────────
// SyncWatch Extension — Background Service Worker (REFACTORED v2.0)
// ─────────────────────────────────────────────────────────────────
'use strict';

const BACKEND_HTTP = 'https://syncwatch-64jv.onrender.com';
let db = {}; // Per-tab state (synced with storage)

// Initialize db from session storage
chrome.storage.session.get(['db']).then(d => {
  db = d.db || {};
  console.log('[SW Background] DB initialized:', db);
});

function saveDb() {
  chrome.storage.session.set({ db });
}

// ── Utility ──────────────────────────────────────────────────────

async function setupOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['LOCAL_STORAGE'], // Using LOCAL_STORAGE as a generic reason to stay alive
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
      sendToTab(tabId, { sw: 'joined', ...msg });
      break;

    case 'play':
    case 'pause':
    case 'seek':
    case 'chat':
    case 'user_joined':
    case 'user_left':
    case 'signal':
    case 'error':
    case 'sync':
      if (msg.type === 'user_joined' || msg.type === 'user_left') {
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
      }
      sendToTab(tabId, { sw: msg.type, ...msg });
      break;
  }
}

// ── Handle messages FROM Content/Popup ────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'background' || msg.target === 'offscreen') return; // Filter signals between workers

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
          db[tabId] = { roomId, hostId, persistentUserId: msg.userId, isHost: true, memberCount: 1, otherUsers: [] };
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
          db[tabId] = { roomId: rId, persistentUserId: msg.userId, isHost: false, memberCount: 0, otherUsers: [] };
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
        connected: stId ? true : false // Assumption: offscreen handles connection state
      });
      break;

    case 'playbackEvent':
    case 'sendChat':
    case 'signal':
    case 'heartbeat':
    case 'syncRequest':
      if (senderTabId) {
          const payload = { ...msg };
          if (msg.action === 'playbackEvent') {
              // Flatten event structure
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