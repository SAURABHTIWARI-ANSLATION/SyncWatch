// ─────────────────────────────────────────────────────────────────
// SyncWatch — Offscreen Document (Persistent WebSocket)
// ─────────────────────────────────────────────────────────────────
'use strict';

const BACKEND_WS = 'wss://syncwatch-64jv.onrender.com';
let sockets = {};

console.log('[SW Offscreen] Offscreen document loaded');

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
        sockets[msg.tabId].close();
        delete sockets[msg.tabId];
      }
      break;
  }
});

function connectWS(tabId, roomId, userId) {
  if (sockets[tabId]) {
    try { sockets[tabId].close(); } catch (_) { }
  }

  console.log(`[SW Offscreen] Connecting to WS: tab=${tabId}, room=${roomId}`);
  const ws = new WebSocket(BACKEND_WS);
  sockets[tabId] = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', roomId, userId }));
  };

  ws.onmessage = e => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    // Dispatch to background script
    chrome.runtime.sendMessage({ 
      target: 'background',
      sw: 'from_server', 
      tabId, 
      payload 
    });
  };

  ws.onclose = () => {
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
    // If it's a playback event, the structure might be different
    if (payload.action === 'playbackEvent' && payload.event) {
        ws.send(JSON.stringify(payload.event));
    } else {
        ws.send(JSON.stringify(payload));
    }
  } else {
    console.warn(`[SW Offscreen] Cannot send: WS not open for tab ${tabId}`);
  }
}
