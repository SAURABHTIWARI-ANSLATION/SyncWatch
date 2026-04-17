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
let globalRoom = null; // Single global session state across all tabs

// ── Init ──────────────────────────────────────────────────────────

let initPromise = chrome.storage.session.get(['globalRoom']).then(d => {
  globalRoom = d.globalRoom || null;
  console.log('[SW Background] DB initialized:', globalRoom);
});

function saveDb() {
  chrome.storage.session.set({ globalRoom });
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

function broadcastToAllTabs(msg) {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, msg, { frameId: 0 }).catch(() => {});
    });
  });
  // Also send to extension pages (popup)
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function offscreenSend(swAction, payload = null) {
  await setupOffscreen();
  chrome.runtime.sendMessage({
    target: 'offscreen',
    sw: swAction,
    tabId: 'GLOBAL', // Use a single global socket for the browser
    roomId: payload?.roomId,
    userId: payload?.userId,
    payload
  });
}

// ── Handle messages FROM offscreen (relay to tabs) ─────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== 'background') return;

  switch (msg.sw) {
    case 'from_server':
      initPromise.then(() => handleServerMessage(msg.payload));
      break;
    case 'ws_closed':
      broadcastToAllTabs({ sw: 'disconnected' });
      break;
    case 'ws_error':
      broadcastToAllTabs({ sw: 'error', msg: msg.msg });
      break;
  }
});

function handleServerMessage(msg) {
  if (msg.type === 'joined') {
    if (!globalRoom) globalRoom = {};
    globalRoom.userId = msg.userId;
    globalRoom.roomId = msg.roomId;
    globalRoom.memberCount = msg.memberCount;
    globalRoom.otherUsers = msg.otherUsers || [];
    saveDb();
    broadcastToAllTabs({ sw: 'joined', ...msg, isHost: globalRoom.isHost || false });
    return;
  }

  if (msg.type === 'user_joined' || msg.type === 'user_left') {
    if (globalRoom) {
      globalRoom.memberCount = msg.memberCount;
      if (msg.type === 'user_joined') {
        if (!globalRoom.otherUsers) globalRoom.otherUsers = [];
        if (!globalRoom.otherUsers.includes(msg.userId)) globalRoom.otherUsers.push(msg.userId);
      } else {
        if (globalRoom.otherUsers) globalRoom.otherUsers = globalRoom.otherUsers.filter(id => id !== msg.userId);
      }
      saveDb();
    }
  }

  if (msg.type === 'host_only_mode') {
    if (globalRoom) {
      globalRoom.hostOnlyMode = msg.state;
      saveDb();
    }
  }

  // PRD Fix: relay sync_request so the host can respond with current video state
  if (msg.type === 'sync_request') {
    broadcastToAllTabs({ sw: 'sync_request', fromUserId: msg.userId });
    return;
  }

  const broadcastMsg = { sw: msg.type, ...msg };
  broadcastToAllTabs(broadcastMsg);
}

// ── Handle messages FROM Content/Popup ────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'background' || msg.target === 'offscreen') return;

  const senderTabId = sender.tab ? sender.tab.id : null;

  switch (msg.action) {
    case 'syncFromWeb':
      globalRoom = { roomId: msg.roomId, persistentUserId: msg.userId, isHost: false, memberCount: 1, otherUsers: [], hostOnlyMode: false };
      saveDb();
      offscreenSend('connect', { roomId: msg.roomId, userId: msg.userId });
      sendResponse({ ok: true });
      return true;

    case 'createRoom':
      fetch(`${BACKEND_HTTP}/room/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
        .then(r => r.json())
        .then(data => {
          const { roomId, hostId } = data;
          globalRoom = { roomId, hostId, persistentUserId: msg.userId, isHost: true, memberCount: 1, otherUsers: [], hostOnlyMode: false };
          saveDb();
          offscreenSend('connect', { roomId, userId: msg.userId });
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
          globalRoom = { roomId: rId, persistentUserId: msg.userId, isHost: false, memberCount: 0, otherUsers: [], hostOnlyMode: false };
          saveDb();
          offscreenSend('connect', { roomId: rId, userId: msg.userId });
          sendResponse({ ok: true, roomId: rId });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'leaveRoom':
      offscreenSend('close');
      globalRoom = null;
      saveDb();
      broadcastToAllTabs({ sw: 'left' });
      sendResponse({ ok: true });
      break;

    case 'getStatus':
      initPromise.then(() => {
        sendResponse({
          room: globalRoom || null,
          connected: globalRoom ? true : false
        });
      });
      return true;

    // PRD Fix: hostOnlyToggle — store in db + relay to room via WS
    case 'hostOnlyToggle':
      initPromise.then(() => {
        if (globalRoom) {
          globalRoom.hostOnlyMode = msg.state;
          saveDb();
          offscreenSend('send', {
            type: 'host_only_mode',
            state: msg.state
          });
        }
      });
      break;

    case 'playbackEvent':
    case 'sendChat':
    case 'signal':
    case 'heartbeat':
    case 'syncRequest':
      initPromise.then(() => {
        if (globalRoom) {
          const payload = { ...msg };
          if (msg.action === 'playbackEvent') {
            Object.assign(payload, msg.event);
          } else if (msg.action === 'sendChat') {
            payload.type = 'chat';
          } else if (msg.action === 'syncRequest') {
            payload.type = 'sync_request';
          }
          offscreenSend('send', payload);
        }
      });
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
  // We no longer nuke the room if any arbitrary tab closes, 
  // since the room is global. Users explicitly leave via 'leaveRoom'.
  // However we might want to clean up something if needed.
});