// SyncWatch - Background Service Worker v3 (MV3)
// WebSocket managed here. WebRTC is NOW in content.js (page context) to avoid
// the fragile offscreen→background relay chain.
'use strict';

const WS_URL = 'wss://syncwatch-o4za.onrender.com';

// ── Runtime state ─────────────────────────────────────────
let ws = null;
let roomId = null;
let userId = null;
let connected = false;
let isSharing = false;
let roomUsers = new Set();
let wsReconnectTimer = null;
let heartbeatTimer = null;
let syncTimer = null;

// ═══════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════
function wsConnect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  console.log('[BG] Connecting WS…');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    connected = true;
    console.log('[BG] WS open');
    wsSend({ type: 'join', roomId });
    clearInterval(heartbeatTimer);
    clearInterval(syncTimer);
    heartbeatTimer = setInterval(() => wsSend({ type: 'heartbeat' }), 20000);
    syncTimer = setInterval(() => wsSend({ type: 'sync_request' }), 5000);
    setStorage({ wsConnected: true });
    broadcastTabs({ type: 'BG_STATUS', connected: true });
  };

  ws.onmessage = (e) => {
    try { handleServerMsg(JSON.parse(e.data)); } catch { }
  };

  ws.onclose = () => {
    connected = false;
    clearInterval(heartbeatTimer);
    clearInterval(syncTimer);
    console.log('[BG] WS closed');
    setStorage({ wsConnected: false });
    broadcastTabs({ type: 'BG_STATUS', connected: false });
    if (roomId) {
      wsReconnectTimer = setTimeout(wsConnect, 3000);
    }
  };

  ws.onerror = (e) => console.error('[BG] WS error', e);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function wsDisconnect() {
  clearTimeout(wsReconnectTimer);
  clearInterval(heartbeatTimer);
  clearInterval(syncTimer);
  if (ws) { try { ws.close(); } catch { } ws = null; }
  connected = false;
  roomId = null;
  userId = null;
  roomUsers.clear();
}

// ═══════════════════════════════════════════════════════════
// SERVER MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════
function handleServerMsg(msg) {
  switch (msg.type) {

    case 'joined': {
      userId = msg.userId;
      roomUsers = new Set(msg.otherUsers || []);
      setStorage({ userId, memberCount: msg.memberCount, connected: true });
      broadcastTabs({ type: 'BG_JOINED', state: msg.state, roomId, userId, memberCount: msg.memberCount });
      broadcastTabs({ type: 'BG_CHAT', author: 'System', text: `You joined · ${msg.memberCount} ${msg.memberCount === 1 ? 'person' : 'people'} watching` });
      // If already sharing, tell content script to offer to existing members
      if (isSharing && msg.otherUsers?.length) {
        broadcastToContentScripts({ type: 'BG_CREATE_OFFERS', targetIds: msg.otherUsers });
      }
      break;
    }

    case 'play':
      broadcastTabs({ type: 'BG_PLAY', time: msg.time, fromUserId: msg.userId });
      if (msg.userId !== userId) broadcastTabs({ type: 'BG_CHAT', author: 'Sync', text: `▶ ${msg.userId} played at ${fmt(msg.time)}` });
      break;

    case 'pause':
      broadcastTabs({ type: 'BG_PAUSE', time: msg.time, fromUserId: msg.userId });
      if (msg.userId !== userId) broadcastTabs({ type: 'BG_CHAT', author: 'Sync', text: `⏸ ${msg.userId} paused at ${fmt(msg.time)}` });
      break;

    case 'seek':
      broadcastTabs({ type: 'BG_SEEK', time: msg.time, fromUserId: msg.userId });
      if (msg.userId !== userId) broadcastTabs({ type: 'BG_CHAT', author: 'Sync', text: `⏩ ${msg.userId} seeked to ${fmt(msg.time)}` });
      break;

    case 'sync':
      broadcastTabs({ type: 'BG_SYNC', state: msg.state });
      break;

    case 'chat':
      appendChatHistory({ author: msg.userId, text: msg.text, ts: msg.ts || Date.now() });
      broadcastTabs({ type: 'BG_CHAT', author: msg.userId, text: msg.text });
      break;

    case 'user_joined':
      roomUsers.add(msg.userId);
      setStorage({ memberCount: msg.memberCount });
      broadcastTabs({ type: 'BG_MEMBER_COUNT', count: msg.memberCount });
      broadcastTabs({ type: 'BG_CHAT', author: 'System', text: `${msg.userId} joined · ${msg.memberCount} watching` });
      // If host is sharing, content script should create offer for new user
      if (isSharing) {
        broadcastToContentScripts({ type: 'BG_CREATE_OFFERS', targetIds: [msg.userId] });
      }
      break;

    case 'user_left':
      roomUsers.delete(msg.userId);
      setStorage({ memberCount: msg.memberCount });
      broadcastTabs({ type: 'BG_PEER_LEFT', peerId: msg.userId });
      broadcastTabs({ type: 'BG_MEMBER_COUNT', count: msg.memberCount });
      broadcastTabs({ type: 'BG_CHAT', author: 'System', text: `${msg.userId} left · ${msg.memberCount} watching` });
      break;

    case 'signal':
      // Route WebRTC signal from server → content script (which owns RTCPeerConnection)
      broadcastToContentScripts({ type: 'BG_SIGNAL', senderId: msg.senderId, signalData: msg.signalData });
      break;

    case 'heartbeat_ack':
      break;

    case 'error':
      broadcastTabs({ type: 'BG_ERROR', msg: msg.msg });
      break;
  }
}

// ═══════════════════════════════════════════════════════════
// SCREEN SHARE
// FIX: In MV3 service workers, desktopCapture.chooseDesktopMedia
// REQUIRES a valid Tab object as the second argument. Passing null
// causes Chrome to return an empty streamId silently.
// We get the active tab, verify it's injectable, then pass it.
// ═══════════════════════════════════════════════════════════
async function startScreenShare(requestingTabId) {
  // Resolve the target tab — prefer the requesting tab
  let targetTab = null;

  if (requestingTabId) {
    try { targetTab = await chrome.tabs.get(requestingTabId); } catch { }
  }

  // Fallback: query for the active tab
  if (!targetTab) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTab = tabs?.[0] || null;
  }

  if (!targetTab) {
    return Promise.reject(new Error('No active tab found for screen capture'));
  }

  return new Promise((resolve, reject) => {
    // KEY FIX: Pass the actual tab object (not null).
    // Passing null in MV3 causes chooseDesktopMedia to silently return ''
    // which looks like a cancellation but is actually a Chrome bug.
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'tab'],
      targetTab,
      (streamId) => {
        if (!streamId) {
          // User cancelled — reset state cleanly
          isSharing = false;
          setStorage({ isSharing: false });
          return reject(new Error('Screen share cancelled or permission denied'));
        }

        isSharing = true;
        setStorage({ isSharing: true });

        // Send streamId to the content script of the requesting tab
        const tabId = requestingTabId || targetTab?.id;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'BG_START_CAPTURE',
            streamId,
            targetIds: [...roomUsers]
          }).catch(err => {
            console.error('[BG] Failed to send streamId to content script:', err);
            // If content script isn't ready, reset sharing state
            isSharing = false;
            setStorage({ isSharing: false });
          });
        }

        broadcastTabs({ type: 'BG_SHARE_STARTED' });
        resolve({ ok: true });
      }
    );
  });
}

function stopScreenShare() {
  isSharing = false;
  setStorage({ isSharing: false });
  // Tell content script to stop its WebRTC and media stream
  broadcastToContentScripts({ type: 'BG_STOP_CAPTURE' });
  broadcastTabs({ type: 'BG_SHARE_STOPPED' });
}

// ═══════════════════════════════════════════════════════════
// ROOM OPERATIONS
// ═══════════════════════════════════════════════════════════
async function joinRoom(rId) {
  wsDisconnect();
  stopScreenShare();

  roomId = rId.toUpperCase();
  await chrome.storage.local.set({ sw_room: roomId, chatHistory: [], connected: false, isSharing: false });

  wsConnect();

  const tab = await getActiveTab();
  if (tab && isInjectableUrl(tab.url)) {
    await ensureContentScript(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: 'BG_SHOW_OVERLAY', roomId }).catch(() => { });
  }
}

async function leaveRoom() {
  wsDisconnect();
  stopScreenShare();
  await chrome.storage.local.set({ sw_room: null, chatHistory: [], connected: false, isSharing: false, memberCount: 0 });
  broadcastTabs({ type: 'BG_LEFT_ROOM' });
}

// ═══════════════════════════════════════════════════════════
// MESSAGE ROUTER
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Relay from popup ──
  if (msg.type === 'RELAY_TO_CONTENT') {
    handleRelay(msg.payload, sender, sendResponse);
    return true;
  }

  switch (msg.type) {
    case 'ping':
      sendResponse({ alive: true });
      return false;

    case 'CONTENT_PLAY':
      wsSend({ type: 'play', time: msg.time });
      return false;

    case 'CONTENT_PAUSE':
      wsSend({ type: 'pause', time: msg.time });
      return false;

    case 'CONTENT_SEEK':
      wsSend({ type: 'seek', time: msg.time });
      return false;

    case 'CONTENT_CHAT':
      if (connected) {
        wsSend({ type: 'chat', text: msg.text });
        appendChatHistory({ author: 'You', text: msg.text, ts: Date.now() });
      }
      return false;

    case 'CONTENT_START_SHARE': {
      const tabId = sender.tab?.id;
      startScreenShare(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch(e => {
          console.error('[BG] startScreenShare error:', e.message);
          sendResponse({ ok: false, error: e.message });
        });
      return true; // keep channel open for async response
    }

    case 'CONTENT_STOP_SHARE':
      stopScreenShare();
      sendResponse({ ok: true });
      return false;

    case 'CONTENT_GET_STATUS':
      sendResponse({ connected, roomId, userId, isSharing, hasVideo: true });
      return false;

    // Content script forwards WebRTC signals to server via BG
    case 'CONTENT_SIGNAL':
      wsSend({ type: 'signal', targetId: msg.targetId, signalData: msg.signalData });
      return false;

    case 'CONTENT_SHARE_ENDED':
      isSharing = false;
      setStorage({ isSharing: false });
      broadcastTabs({ type: 'BG_SHARE_STOPPED' });
      return false;
  }

  return false;
});

async function handleRelay(payload, sender, sendResponse) {
  if (!payload) return sendResponse({ ok: false, error: 'no payload' });

  switch (payload.type) {
    case 'GET_STATUS':
      sendResponse({ ok: true, data: { connected, roomId, userId, isSharing, hasVideo: true } });
      break;

    case 'JOIN_ROOM':
      try {
        await joinRoom(payload.roomId);
        sendResponse({ ok: true, data: { ok: true } });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      break;

    case 'LEAVE_ROOM':
      await leaveRoom();
      sendResponse({ ok: true, data: { ok: true } });
      break;

    default:
      await relayToContentScript(payload, sender, sendResponse);
  }
}

async function relayToContentScript(payload, sender, sendResponse) {
  const tab = await getActiveTab();
  if (!tab) return sendResponse({ ok: false, error: 'no_tab' });
  if (!isInjectableUrl(tab.url)) return sendResponse({ ok: false, error: 'bad_page', hint: 'Navigate to a video page first.' });
  const inject = await ensureContentScript(tab.id);
  if (!inject.ok) return sendResponse({ ok: false, error: 'inject_failed', hint: inject.error });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, payload);
    sendResponse({ ok: true, data: res });
  } catch (e) {
    sendResponse({ ok: false, error: 'msg_failed', hint: e.message });
  }
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function isInjectableUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'about:' || u.protocol === 'chrome-extension:') return false;
    return ['http:', 'https:', 'file:'].includes(u.protocol);
  } catch {
    return false;
  }
}

async function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      resolve(tabs?.[0] || null);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    // 1. Check if tab still exists and has an injectable URL
    const tab = await chrome.tabs.get(tabId);
    if (!isInjectableUrl(tab.url)) return { ok: false, error: 'Non-injectable URL: ' + tab.url };

    // 2. Try to ping existing content script
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (r?.alive) return { ok: true };
    } catch { }

    // 3. Inject content script into MAIN FRAME ONLY (frameId: 0)
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['content.js']
    });

    await sleep(400);
    return { ok: true };
  } catch (e) {
    console.error('[BG] Injection failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function broadcastTabs(msg) {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => { }));
  });
}

// Only send to tabs that have our content script loaded
function broadcastToContentScripts(msg) {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      if (tab.id && isInjectableUrl(tab.url)) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => { });
      }
    });
  });
}

function setStorage(data) {
  chrome.storage.local.set(data).catch(() => { });
}

async function appendChatHistory(entry) {
  const { chatHistory = [] } = await chrome.storage.local.get('chatHistory').catch(() => ({}));
  chatHistory.push(entry);
  if (chatHistory.length > 200) chatHistory.splice(0, chatHistory.length - 200);
  chrome.storage.local.set({ chatHistory }).catch(() => { });
}

function fmt(secs) {
  const s = Math.floor(secs), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(() => {
  console.log('[SyncWatch] Installed v3.0');
  chrome.storage.local.set({ connected: false, roomId: null, chatHistory: [], isSharing: false });
});

(async () => {
  const { sw_room, wsConnected } = await chrome.storage.local.get(['sw_room', 'wsConnected']);
  if (sw_room && wsConnected) {
    console.log('[BG] Restoring room:', sw_room);
    roomId = sw_room;
    wsConnect();
  }
})();