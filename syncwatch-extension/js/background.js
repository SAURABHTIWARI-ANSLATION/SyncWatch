'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SyncWatch — Background Service Worker
// Single responsibility: bridge between offscreen WebSocket and content/popup.
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_HTTP = 'https://syncwatch-ad6y.onrender.com';

// ─────────────────────────────────────────────────────────────────────────────
// Session state — single room per browser profile
// ─────────────────────────────────────────────────────────────────────────────

let globalRoom = null;

const initPromise = chrome.storage.session.get(['globalRoom']).then(d => {
  globalRoom = d.globalRoom || null;
});

function saveRoom() {
  chrome.storage.session.set({ globalRoom });
}

// ─────────────────────────────────────────────────────────────────────────────
// Keep-alive: alarm pings the offscreen document every ~24s
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });
});
chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'sw-keepalive') return;
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ target: 'offscreen', sw: 'ping' }).catch(() => {});
  } catch (e) {
    console.warn('[BG] Keep-alive error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Offscreen document (persistent WebSocket host)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url:           'offscreen.html',
    reasons:       ['LOCAL_STORAGE'],
    justification: 'Maintaining persistent WebSocket for real-time video sync.'
  });
}

function wsSend(payload) {
  ensureOffscreen().then(() => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      sw:     'send',
      tabId:  'GLOBAL',
      payload
    }).catch(() => {});
  });
}

function wsConnect(roomId, userId) {
  ensureOffscreen().then(() => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      sw:     'connect',
      tabId:  'GLOBAL',
      roomId,
      userId
    }).catch(() => {});
  });
}

function wsDisconnect() {
  ensureOffscreen().then(() => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      sw:     'close',
      tabId:  'GLOBAL'
    }).catch(() => {});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast helpers
// ─────────────────────────────────────────────────────────────────────────────

function broadcast(msg) {
  // To all content scripts
  chrome.tabs.query({}, tabs => {
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, msg, { frameId: 0 }).catch(() => {});
    });
  });
  // To popup / extension pages
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle messages arriving FROM the server (via offscreen)
// ─────────────────────────────────────────────────────────────────────────────

function onServerMessage(msg) {
  switch (msg.type) {

    case 'joined':
      if (!globalRoom) globalRoom = {};
      globalRoom.userId      = msg.userId;
      globalRoom.roomId      = msg.roomId;
      globalRoom.memberCount = msg.memberCount;
      globalRoom.otherUsers  = msg.otherUsers || [];
      saveRoom();
      broadcast({ sw: 'joined', ...msg, isHost: globalRoom.isHost || false });
      break;

    case 'usersList':
      if (globalRoom) { globalRoom.memberCount = msg.memberCount; saveRoom(); }
      broadcast({ sw: 'usersList', list: msg.list, memberCount: msg.memberCount });
      break;

    case 'user_joined':
      if (globalRoom) {
        globalRoom.memberCount = msg.memberCount;
        if (!globalRoom.otherUsers) globalRoom.otherUsers = [];
        if (!globalRoom.otherUsers.includes(msg.userId)) globalRoom.otherUsers.push(msg.userId);
        saveRoom();
      }
      broadcast({ sw: 'user_joined', userId: msg.userId, memberCount: msg.memberCount });
      break;

    case 'user_left':
      if (globalRoom) {
        globalRoom.memberCount = msg.memberCount;
        if (globalRoom.otherUsers) globalRoom.otherUsers = globalRoom.otherUsers.filter(id => id !== msg.userId);
        saveRoom();
      }
      broadcast({ sw: 'user_left', userId: msg.userId, memberCount: msg.memberCount });
      break;

    case 'chatHistory':
      broadcast({ sw: 'chatHistory', messages: msg.messages });
      break;

    case 'chatMessage':
      broadcast({ sw: 'chatMessage', ...msg });
      break;

    case 'host_only_mode':
      if (globalRoom) { globalRoom.hostOnlyMode = msg.state; saveRoom(); }
      broadcast({ sw: 'host_only_mode', state: msg.state });
      break;

    case 'sync_request':
      // Relay to content so host can push back current video time
      broadcast({ sw: 'sync_request', fromUserId: msg.userId });
      break;

    case 'play':
    case 'pause':
    case 'seek':
    case 'sync':
    case 'signal':
      broadcast({ sw: msg.type, ...msg });
      break;

    // heartbeat_ack / pong: already filtered in offscreen — but guard here too
    case 'heartbeat_ack':
    case 'pong':
      break;

    default:
      broadcast({ sw: msg.type, ...msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message listener — FROM offscreen
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'background') return;

  switch (msg.sw) {
    case 'from_server':
      initPromise.then(() => onServerMessage(msg.payload));
      break;

    case 'ws_closed':
      broadcast({ sw: 'disconnected', msg: 'Connection lost. Reconnecting…' });
      // Auto-reconnect after 3s if still in a room
      initPromise.then(() => {
        if (!globalRoom?.roomId) return;
        setTimeout(() => {
          if (!globalRoom?.roomId) return;
          wsConnect(globalRoom.roomId, globalRoom.hostId || globalRoom.persistentUserId);
        }, 3000);
      });
      break;

    case 'ws_error':
      broadcast({ sw: 'error', msg: msg.msg || 'Connection error' });
      break;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Message listener — FROM content / popup
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'background' || msg.target === 'offscreen') return;

  const senderTabId = sender.tab?.id ?? null;

  switch (msg.action) {

    // ── createRoom ──────────────────────────────────────────────────
    case 'createRoom':
      fetch(`${BACKEND_HTTP}/room/create`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        // hostId is the persistentUserId — server will grant "Host" role when this
        // same value is sent back in the WS 'join' message.
        body: JSON.stringify({ hostId: msg.userId })
      })
        .then(r => r.json())
        .then(({ roomId, hostId }) => {
          globalRoom = {
            roomId,
            hostId,
            persistentUserId: msg.userId,
            isHost:           true,
            memberCount:      1,
            otherUsers:       [],
            hostOnlyMode:     false
          };
          saveRoom();
          wsConnect(roomId, hostId);   // hostId === msg.userId — server matches this
          sendResponse({ ok: true, roomId });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    // ── joinRoom ────────────────────────────────────────────────────
    case 'joinRoom': {
      const rId = (msg.roomId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      fetch(`${BACKEND_HTTP}/room/${rId}`)
        .then(r => r.json())
        .then(data => {
          if (!data.exists) return sendResponse({ ok: false, error: `Room "${rId}" not found.` });
          globalRoom = {
            roomId:           rId,
            persistentUserId: msg.userId,
            isHost:           false,
            memberCount:      0,
            otherUsers:       [],
            hostOnlyMode:     false
          };
          saveRoom();
          wsConnect(rId, msg.userId);
          sendResponse({ ok: true, roomId: rId });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    // ── leaveRoom ───────────────────────────────────────────────────
    case 'leaveRoom':
      wsDisconnect();
      globalRoom = null;
      saveRoom();
      broadcast({ sw: 'left' });
      sendResponse({ ok: true });
      break;

    // ── getStatus ───────────────────────────────────────────────────
    case 'getStatus':
      initPromise.then(() => {
        sendResponse({ room: globalRoom, connected: !!globalRoom });
      });
      return true;

    // ── syncFromWeb (web join page) ──────────────────────────────────
    case 'syncFromWeb':
      initPromise.then(() => {
        globalRoom = {
          roomId:           msg.roomId,
          persistentUserId: msg.userId,
          userId:           'Host',
          isHost:           msg.isHost || false,
          memberCount:      1,
          otherUsers:       [],
          hostOnlyMode:     false
        };
        saveRoom();
        wsConnect(msg.roomId, msg.userId);
        sendResponse({ ok: true });
      });
      return true;

    // ── playbackEvent ────────────────────────────────────────────────
    case 'playbackEvent':
      initPromise.then(() => {
        if (globalRoom) wsSend({ ...msg.event });
      });
      break;

    // ── sendChat ─────────────────────────────────────────────────────
    case 'sendChat':
      initPromise.then(() => {
        if (globalRoom) wsSend({ type: 'chatMessage', text: msg.text });
      });
      break;

    // ── syncRequest ──────────────────────────────────────────────────
    case 'syncRequest':
      initPromise.then(() => {
        if (globalRoom) wsSend({ type: 'sync_request' });
      });
      break;

    // ── hostOnlyToggle ───────────────────────────────────────────────
    case 'hostOnlyToggle':
      initPromise.then(() => {
        if (!globalRoom) return;
        globalRoom.hostOnlyMode = msg.state;
        saveRoom();
        wsSend({ type: 'host_only_mode', state: msg.state });
      });
      break;

    // ── WebRTC signal ────────────────────────────────────────────────
    case 'signal':
      initPromise.then(() => {
        if (globalRoom) wsSend({ type: 'signal', targetId: msg.targetId, signalData: msg.signalData });
      });
      break;

    // ── heartbeat ────────────────────────────────────────────────────
    case 'heartbeat':
      initPromise.then(() => {
        if (globalRoom) wsSend({ type: 'ping' });
      });
      break;

    // ── Screen share prompt ──────────────────────────────────────────
    case 'requestScreenShare':
      if (senderTabId) {
        chrome.windows.create({
          url:    `share-prompt.html?tabId=${senderTabId}`,
          type:   'popup',
          width:  420,
          height: 300
        });
      }
      break;

    // ── Internal (share-prompt → content) ───────────────────────────
    case 'internal':
      if (msg.subAction === 'shareIdCaptured' && msg.tabId) {
        chrome.tabs.sendMessage(msg.tabId, { sw: 'screenShareGranted', streamId: msg.streamId }).catch(() => {});
      }
      break;
  }
});