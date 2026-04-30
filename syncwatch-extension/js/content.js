// ─────────────────────────────────────────────────────────────────
// SyncWatch — Content Script  (FIXED v2.0)
// PRD Fixes:
//  - IS_TOP_FRAME guard: overlay never injected in cross-origin sub-frames
//  - isHost + hostOnlyMode RBAC: guests cannot send play/pause in host-only mode
//  - Guest Sync Race: auto-sends syncRequest after join so host responds
//  - sync_request handler: host sends back current state when guest asks
//  - host_only_mode handler: all peers update local mode flag
//  - Stream quality: startScreenShare accepts quality constraint param
//  - ICE_SERVERS: documented config with premium TURN upgrade path
// ─────────────────────────────────────────────────────────────────
'use strict';

if (window.__syncwatchInjected) { throw new Error('already injected'); }
window.__syncwatchInjected = true;

// PRD Fix #6: Only inject the UI overlay in the top-level frame.
// With all_frames:true, this script runs in every sub-frame — without
// this guard every nested iframe would inject a duplicate overlay.
const IS_TOP_FRAME = window === window.top;

// ── State ────────────────────────────────────────────────────────
let video = null;
let isSyncing = false;
let inRoom = false;
let userId = null;
let myRoomId = null;
let overlayFrame = null;
let scanInterval = null;
let heartbeatInterval = null;

// PRD Fix #7: RBAC — Host-Only Controls
let isHost = false;
let hostOnlyMode = false;

let knownPeers = new Set();

// WebRTC state
let rtcPeers = {};
let localStream = null;
let localMicStream = null;
let viewerVideoEl = null;

// ── ICE Server Configuration ──────────────────────────────────────
// PRD Fix #1: Current free openrelay TURN servers may be rate-limited.
// To upgrade: replace openrelay entries with credentials from a
// dedicated provider (Twilio / Metered.ca) and set ICE_SERVERS below.
// Example with Twilio:
//   { urls: 'turn:global.turn.twilio.com:3478', username: '<user>', credential: '<pass>' }
//
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Free fallback TURN — replace with dedicated premium TURN for production
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// ── Video detection ───────────────────────────────────────────────

function getVideoScore(el) {
  if (!el || el.tagName !== 'VIDEO') return 0;
  const area = el.offsetWidth * el.offsetHeight;
  if (area < 10000) return 0;
  let score = area;
  if (!el.paused) score += 500000;
  if (el.duration > 0) score += 200000;
  return score;
}

function findBestVideo() {
  const all = [];
  function collect(doc) {
    try {
      doc.querySelectorAll('video').forEach(v => all.push(v));
      // PRD Fix #6: try to reach same-origin iframes; cross-origin will throw (caught below)
      doc.querySelectorAll('iframe').forEach(f => { try { collect(f.contentDocument); } catch (_) { } });
    } catch (_) { }
  }
  collect(document);
  let best = null, bestScore = 0;
  all.forEach(v => { const s = getVideoScore(v); if (s > bestScore) { bestScore = s; best = v; } });
  return { video: best, score: bestScore };
}

function startVideoScan() {
  if (scanInterval) return;
  scanInterval = setInterval(() => {
    const { video: v, score } = findBestVideo();
    if (v && v !== video) attachToVideo(v, score);
  }, 1500);
}

function attachToVideo(v, score) {
  if (video) detachFromVideo();
  video = v;
  // Report to background; include whether this is the top frame so background
  // can prioritize the best video source across all frames for this tab.
  chrome.runtime.sendMessage({ action: 'videoFound', score, isTopFrame: IS_TOP_FRAME });
  video.addEventListener('play', handlePlay);
  video.addEventListener('pause', handlePause);
  video.addEventListener('seeked', handleSeeked);
  video.addEventListener('durationchange', handleDuration);
  // Only inject overlay from the top-level frame (PRD Fix #6)
  if (IS_TOP_FRAME) injectOverlay();
}

function detachFromVideo() {
  if (!video) return;
  video.removeEventListener('play', handlePlay);
  video.removeEventListener('pause', handlePause);
  video.removeEventListener('seeked', handleSeeked);
  video.removeEventListener('durationchange', handleDuration);
  video = null;
}

// ── Playback event handlers ───────────────────────────────────────

function handlePlay() {
  if (isSyncing || !inRoom) return;
  // PRD Fix #7: In host-only mode only the host may broadcast play events
  if (hostOnlyMode && !isHost) return;
  chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'play', time: video.currentTime } });
}
function handlePause() {
  if (isSyncing || !inRoom) return;
  // PRD Fix #7: In host-only mode only the host may broadcast pause events
  if (hostOnlyMode && !isHost) return;
  chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'pause', time: video.currentTime } });
}
function handleSeeked() {
  if (isSyncing || !inRoom) return;
  // PRD Fix #7: In host-only mode only the host may seek for the room
  if (hostOnlyMode && !isHost) return;
  chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'seek', time: video.currentTime } });
}
function handleDuration() {
  postToOverlay({ type: 'duration', duration: video ? video.duration : 0 });
}

// ── Apply remote sync ─────────────────────────────────────────────

function applySync(state) {
  if (!video) return;
  isSyncing = true;
  try {
    if (typeof state.time === 'number' && Math.abs(video.currentTime - state.time) > 1.5) video.currentTime = state.time;
    if (state.playing && video.paused) video.play().catch(() => { });
    if (!state.playing && !video.paused) video.pause();
  } catch (e) { console.warn('[SW Content] applySync error:', e); }
  setTimeout(() => { isSyncing = false; }, 800);
}

function applyPlay(time) {
  if (!video) return;
  isSyncing = true;
  try { if (Math.abs(video.currentTime - time) > 1.5) video.currentTime = time; video.play().catch(() => { }); } catch (_) { }
  setTimeout(() => { isSyncing = false; }, 600);
}

function applyPause(time) {
  if (!video) return;
  isSyncing = true;
  try { if (Math.abs(video.currentTime - time) > 1.5) video.currentTime = time; video.pause(); } catch (_) { }
  setTimeout(() => { isSyncing = false; }, 600);
}

function applySeek(time) {
  if (!video) return;
  isSyncing = true;
  try { video.currentTime = time; } catch (_) { }
  setTimeout(() => { isSyncing = false; }, 500);
}

// ── Controls overlay (iframe inside Shadow DOM) ───────────────────

let fallbackTimeout = null;
let overlayHandshakeReceived = false;

function injectOverlay() {
  // PRD Fix #6: Never inject overlay in sub-frames
  if (!IS_TOP_FRAME) return;
  
  if (document.getElementById('sw-overlay-host')) return;

  const host = document.createElement('div');
  host.id = 'sw-overlay-host';
  host.style.cssText = 'position:fixed !important; bottom:0 !important; left:0 !important; right:0 !important; top:auto !important; width:100% !important; height:56px; z-index:2147483647 !important; pointer-events:none; transition:height 0.2s; visibility:visible !important; display:block !important;';
  document.body.appendChild(host);

  // Shadow DOM encapsulates the entire overlay, defeating page-level CSP style rules
  const shadow = host.attachShadow({ mode: 'open' });
  overlayFrame = document.createElement('iframe');
  overlayFrame.id = 'sw-iframe';
  overlayFrame.src = chrome.runtime.getURL('controls.html');
  overlayFrame.style.cssText = 'width:100%;height:100%;border:none;pointer-events:auto;background:transparent;';
  shadow.appendChild(overlayFrame);

  window.addEventListener('message', handleOverlayMessage);

  // CSP Check: if iframe doesn't confirm 'ready' within 2.5s it was blocked by CSP
  fallbackTimeout = setTimeout(() => {
    if (!overlayHandshakeReceived) {
      console.warn('[SW Content] Overlay iframe blocked (CSP). Switching to Shadow DOM fallback UI...');
      injectFallbackUI(shadow);
    }
  }, 2500);

  console.log('[SW Content] Overlay attempt injected');
}

// PRD Fix #5: Enhanced fallback UI using native Shadow DOM — bypasses
// CSP entirely and now includes a basic live chat panel.
function injectFallbackUI(shadow) {
  if (overlayFrame) { overlayFrame.remove(); overlayFrame = null; }

  const bar = document.createElement('div');
  bar.id = 'sw-fallback-bar';
  bar.innerHTML = `
    <style>
      :host-context(#sw-overlay-host) { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
      #fb-bar {
        width: 100%; height: 56px;
        background: #0f172a !important;
        border-top: 1px solid rgba(124,159,255,0.3) !important;
        display: flex !important; align-items: center !important; gap: 8px !important;
        padding: 0 16px !important; pointer-events: auto !important;
        color: #f8fafc !important; font-size: 13px !important;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.6) !important;
      }
      .logo { background: #7c9fff; color: #000; font-weight: 900; font-size: 11px;
              padding: 4px 10px; border-radius: 20px; flex-shrink: 0; }
      .room-id { font-size: 12px; font-weight: 700; color: #7c9fff; letter-spacing: 2px;
                 background: rgba(124,159,255,0.1); padding: 3px 8px; border-radius: 6px; }
      .members { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #4ade80;
                 background: rgba(74,222,128,0.08); padding: 3px 8px; border-radius: 6px; }
      .dot { width: 6px; height: 6px; background: #4ade80; border-radius: 50%;
             animation: pulse 2s infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      .btn { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
             color: #f8fafc; padding: 5px 12px; border-radius: 7px; cursor: pointer;
             font-size: 12px; font-weight: 600; transition: all 0.15s; }
      .btn:hover { background: rgba(255,255,255,0.12); transform: translateY(-1px); }
      .btn.accent { background: #7c9fff; color: #000; border-color: transparent; }
      .btn.red    { color: #f43f5e; border-color: rgba(244,63,94,0.2);
                    background: rgba(244,63,94,0.1); }
      .btn.green  { color: #4ade80; border-color: rgba(74,222,128,0.2);
                    background: rgba(74,222,128,0.1); }
      .btn.active { background: rgba(74,222,128,0.25); border-color: #4ade80; }
      .spacer { flex: 1; }
      .div { width: 1px; height: 24px; background: rgba(255,255,255,0.07); flex-shrink: 0; }
      #fb-status { font-size: 10px; color: #94a3b8; }
      /* Chat panel */
      #fb-chat {
        position: fixed; bottom: 56px; right: 16px;
        width: 300px; height: 340px;
        background: #0f172a; border: 1px solid rgba(255,255,255,0.07);
        border-radius: 12px; display: none; flex-direction: column;
        overflow: hidden; box-shadow: 0 -8px 32px rgba(0,0,0,0.5);
      }
      #fb-chat.open { display: flex; }
      #fb-chat-hdr { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.05);
                     font-size: 12px; font-weight: 700; color: #64748b;
                     text-transform: uppercase; letter-spacing: 1px; }
      #fb-chat-msgs { flex: 1; overflow-y: auto; padding: 10px 14px;
                      display: flex; flex-direction: column; gap: 6px; scroll-behavior: smooth; }
      .fb-msg { font-size: 13px; line-height: 1.4; word-break: break-word; color: #f8fafc; }
      .fb-msg.sys { color: #64748b; font-style: italic; font-size: 11px; text-align: center; }
      .fb-msg .au { color: #7c9fff; font-weight: 700; margin-right: 4px; }
      #fb-chat-row { display: flex; gap: 6px; padding: 10px;
                     border-top: 1px solid rgba(255,255,255,0.05); }
      #fb-chat-row input { flex: 1; background: rgba(255,255,255,0.06);
                           border: 1px solid rgba(255,255,255,0.1);
                           border-radius: 8px; padding: 8px 10px;
                           color: #f8fafc; font-size: 12px; outline: none; }
      #fb-chat-row input:focus { border-color: #7c9fff; }
      #fb-chat-row button { background: #7c9fff; border: none; border-radius: 8px;
                            padding: 0 12px; color: #000; font-weight: 700;
                            font-size: 12px; cursor: pointer; }
    </style>

    <div id="fb-bar">
      <div class="logo">▶ SW</div>
      <div class="div"></div>
      <span class="room-id" id="fb-room-id">--------</span>
      <div class="members"><div class="dot"></div>
        <span id="fb-members">1</span>
        <span style="font-size:10px;color:#64748b">watching</span>
      </div>
      <div class="div"></div>
      <button class="btn" id="fb-play">▶</button>
      <button class="btn" id="fb-pause">⏸</button>
      <button class="btn accent" id="fb-sync">⟳ Sync</button>
      <div class="div"></div>
      <button class="btn green" id="fb-share">📡 Share</button>
      <div class="spacer"></div>
      <button class="btn" id="fb-chat-btn">💬</button>
      <span id="fb-status" style="color:#94a3b8;font-size:10px">Fallback Mode</span>
      <div class="div"></div>
      <button class="btn red" id="fb-leave">✕ Leave</button>
    </div>

    <div id="fb-chat">
      <div id="fb-chat-hdr">💬 Live Chat</div>
      <div id="fb-chat-msgs"><div class="fb-msg sys">SyncWatch Fallback Mode — CSP active on this site.</div></div>
      <div id="fb-chat-row">
        <input type="text" id="fb-chat-input" placeholder="Type a message..." maxlength="300">
        <button id="fb-chat-send">→</button>
      </div>
    </div>
  `;

  shadow.appendChild(bar);

  // Wire up buttons — they call the shared handleOverlayMessage shim
  const fire = (swOverlay, extra = {}) => handleOverlayMessage({ data: { swOverlay, ...extra } });

  bar.querySelector('#fb-play').onclick = () => fire('play');
  bar.querySelector('#fb-pause').onclick = () => fire('pause');
  bar.querySelector('#fb-sync').onclick = () => fire('syncNow');
  bar.querySelector('#fb-share').onclick = () => fire('shareScreen', { quality: '720p' });
  bar.querySelector('#fb-leave').onclick = () => { if (confirm('Leave SyncWatch room?')) fire('leave'); };

  let fbChatOpen = false;
  bar.querySelector('#fb-chat-btn').onclick = () => {
    fbChatOpen = !fbChatOpen;
    bar.querySelector('#fb-chat').classList.toggle('open', fbChatOpen);
    const host = document.getElementById('sw-overlay-host');
    if (host) host.style.height = fbChatOpen ? '400px' : '56px';
  };

  const fbSendChat = () => {
    const inp = bar.querySelector('#fb-chat-input');
    const text = inp.value.trim();
    if (!text) return;
    fire('chat', { text });
    addFbMsg('user', text, 'You');
    inp.value = '';
  };
  bar.querySelector('#fb-chat-send').onclick = fbSendChat;
  bar.querySelector('#fb-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') fbSendChat(); });

  // Helper so background messages can update the fallback UI
  window.__swFallbackUI = {
    setRoom: (id, count) => {
      bar.querySelector('#fb-room-id').textContent = id || '--------';
      bar.querySelector('#fb-members').textContent = count || 1;
    },
    setMembers: count => { bar.querySelector('#fb-members').textContent = count; },
    addMsg: addFbMsg
  };

  function addFbMsg(type, text, author) {
    const box = bar.querySelector('#fb-chat-msgs');
    const div = document.createElement('div');
    if (type === 'sys') {
      div.className = 'fb-msg sys';
      div.textContent = text;
    } else {
      div.className = 'fb-msg';
      const a = document.createElement('span'); a.className = 'au'; a.textContent = (author || '?') + ':';
      div.appendChild(a);
      const t = document.createElement('span'); t.textContent = ' ' + text;
      div.appendChild(t);
    }
    box.appendChild(div);
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
}

function removeOverlay() {
  const host = document.getElementById('sw-overlay-host');
  if (host) host.remove();
  overlayFrame = null;
  overlayHandshakeReceived = false;
  if (fallbackTimeout) clearTimeout(fallbackTimeout);
  window.removeEventListener('message', handleOverlayMessage);
  window.__swFallbackUI = null;
}

function postToOverlay(data) {
  if (overlayFrame && overlayFrame.contentWindow) {
    overlayFrame.contentWindow.postMessage(data, '*');
  } else if (window.__swFallbackUI) {
    // Route relevant messages to the fallback UI
    const fb = window.__swFallbackUI;
    if (data.type === 'joined') fb.setRoom(data.roomId, data.memberCount);
    if (data.type === 'user_joined') fb.setMembers(data.memberCount);
    if (data.type === 'user_left') fb.setMembers(data.memberCount);
    if (data.type === 'chat') fb.addMsg('user', data.text, data.userId);
  }
}

// ── Overlay message handler ───────────────────────────────────────

function handleOverlayMessage(e) {
  const msg = e.data;
  if (!msg || !msg.swOverlay) return;

  if (msg.swOverlay === 'ready') {
    overlayHandshakeReceived = true;
    if (fallbackTimeout) clearTimeout(fallbackTimeout);
    console.log('[SW Content] Overlay iframe confirmed ready');
    return;
  }

  switch (msg.swOverlay) {
    case 'play':
      if (video) { isSyncing = true; video.play().catch(() => { }); setTimeout(() => { isSyncing = false; }, 600); }
      if (inRoom && !(hostOnlyMode && !isHost))
        chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'play', time: video ? video.currentTime : 0 } });
      break;

    case 'pause':
      if (video) { isSyncing = true; video.pause(); setTimeout(() => { isSyncing = false; }, 600); }
      if (inRoom && !(hostOnlyMode && !isHost))
        chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'pause', time: video ? video.currentTime : 0 } });
      break;

    case 'seek':
      if (video) { isSyncing = true; video.currentTime = msg.time; setTimeout(() => { isSyncing = false; }, 600); }
      if (inRoom && !(hostOnlyMode && !isHost))
        chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'seek', time: msg.time } });
      break;

    case 'chat':
      chrome.runtime.sendMessage({ action: 'sendChat', text: msg.text });
      break;

    case 'shareScreen':
      // PRD Fix #4: pass quality constraint from the controls UI
      startScreenShare(msg.quality || '720p');
      break;

    case 'stopShare':
      stopScreenShare();
      break;

    case 'syncNow':
      chrome.runtime.sendMessage({ action: 'syncRequest' });
      break;

    case 'leave':
      chrome.runtime.sendMessage({ action: 'leaveRoom' });
      break;

    case 'toggleMic':
      handleToggleMic(msg.state);
      break;

    // PRD Fix #7: host toggles host-only mode from the overlay button
    case 'hostOnlyToggle':
      if (!isHost) return; // Only the host can toggle this
      hostOnlyMode = msg.state;
      chrome.runtime.sendMessage({ action: 'hostOnlyToggle', state: hostOnlyMode });
      break;

    case 'toggleChatPanel': {
      const host = document.getElementById('sw-overlay-host');
      if (host) host.style.height = msg.open ? '400px' : '56px';
      break;
    }
  }
}

// ── Messages FROM background ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'autoStartShare') {
    startScreenShare('720p');
    return;
  }

  if (!msg.sw) return;

  switch (msg.sw) {
    case 'joined':
      inRoom = true;
      userId = msg.userId;
      myRoomId = msg.roomId;
      // PRD Fix #7: store host status for RBAC checks
      isHost = msg.isHost || false;
      knownPeers.clear();
      (msg.otherUsers || []).forEach(id => knownPeers.add(id));

      if (IS_TOP_FRAME) {
        injectOverlay();
        setTimeout(() => {
          postToOverlay({ type: 'joined', roomId: msg.roomId, userId: msg.userId, memberCount: msg.memberCount, isHost });
        }, 800);
      }

      if (msg.state && (msg.state.playing || msg.state.time > 2)) {
        setTimeout(() => applySync(msg.state), 500);
      }

      // PRD Fix #3: Guest Sync Race — send READY/syncRequest after WS settles
      // so the host responds with the current video state before the first event.
      if (!isHost) {
        setTimeout(() => {
          if (inRoom) chrome.runtime.sendMessage({ action: 'syncRequest' });
        }, 1500);
      }

      startHeartbeat();
      break;

    case 'play':
      if (msg.userId !== userId) { applyPlay(msg.time); postToOverlay({ type: 'play' }); }
      break;

    case 'pause':
      if (msg.userId !== userId) { applyPause(msg.time); postToOverlay({ type: 'pause' }); }
      break;

    case 'seek':
      if (msg.userId !== userId) applySeek(msg.time);
      break;

    case 'sync':
      applySync(msg.state);
      break;

    // PRD Fix #3: Host responds to a guest's sync_request by broadcasting current state
    case 'sync_request':
      if (video && inRoom) {
        chrome.runtime.sendMessage({
          action: 'playbackEvent',
          event: { type: 'sync', time: video.currentTime, playing: !video.paused }
        });
      }
      break;

    case 'chat':
      if (msg.userId !== userId) {
        postToOverlay({ type: 'chat', text: msg.text, userId: msg.userId });
      }
      break;

    // GRAPHIFY: rich chatMessage — forward full object to overlay for dedup + timestamps
    case 'chatMessage':
      // Always forward to overlay; controls.js handles own-message dedup via myUserId
      postToOverlay({
        type: 'chatMessage',
        id: msg.id,
        user: msg.user || null,
        text: msg.text,
        timestamp: msg.timestamp,
        msgType: msg.type   // 'user' | 'system' (renamed to avoid collision with postMessage 'type')
      });
      break;

    // GRAPHIFY: chat history replay — forward full list to overlay
    case 'chatHistory':
      postToOverlay({
        type: 'chatHistory',
        messages: (msg.messages || []).map(m => ({
          id: m.id,
          user: m.user || null,
          text: m.text,
          timestamp: m.timestamp,
          type: m.type
        }))
      });
      break;

    case 'user_joined':
      knownPeers.add(msg.userId);
      postToOverlay({ type: 'usersList', memberCount: msg.memberCount, list: [] });
      postToOverlay({ type: 'user_joined', userId: msg.userId, memberCount: msg.memberCount });
      if (localStream) {
        console.log('[SW Content] New viewer during share, offering:', msg.userId);
        createPeerForViewer(msg.userId);
      }
      break;

    case 'user_left':
      knownPeers.delete(msg.userId);
      postToOverlay({ type: 'usersList', memberCount: msg.memberCount, list: [] });
      postToOverlay({ type: 'user_left', userId: msg.userId, memberCount: msg.memberCount });
      closePeer(msg.userId);
      break;

    case 'signal':
      handleWebRTCSignal(msg.senderId, msg.signalData);
      break;

    // PRD Fix #7: handle host_only_mode broadcast from server
    case 'host_only_mode':
      hostOnlyMode = msg.state;
      postToOverlay({ type: 'hostOnlyMode', state: hostOnlyMode, isHost });
      break;

    case 'left':
      inRoom = false;
      userId = null;
      myRoomId = null;
      isHost = false;
      hostOnlyMode = false;
      knownPeers.clear();
      if (IS_TOP_FRAME) removeOverlay();
      stopScreenShare();
      removeViewerVideo();
      stopHeartbeat();
      break;

    case 'disconnected':
    case 'error':
      postToOverlay({ type: 'error', msg: msg.msg || 'Connection lost' });
      break;

    case 'screenShareGranted':
      if (!msg.streamId) {
        postToOverlay({ type: 'screenShareError', msg: 'Screen share cancelled.' });
        return;
      }
      handleScreenShareGranted(msg.streamId);
      break;
  }
});

// ── Heartbeat ─────────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'heartbeat' });
    if (video) postToOverlay({ type: 'timeUpdate', time: video.currentTime, paused: video.paused });
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ── WebRTC helpers ────────────────────────────────────────────────

function closePeer(peerId) {
  if (!rtcPeers[peerId]) return;
  try { rtcPeers[peerId].close(); } catch (_) { }
  delete rtcPeers[peerId];
}

function drainIceQueue(pc) {
  if (!pc._iceQueue?.length) return;
  pc._iceQueue.forEach(c => pc.addIceCandidate(c).catch(() => { }));
  pc._iceQueue = [];
}

// ── Viewer video ──────────────────────────────────────────────────

function injectViewerVideo(stream) {
  removeViewerVideo();
  viewerVideoEl = document.createElement('video');
  viewerVideoEl.id = 'sw-viewer-video';
  viewerVideoEl.autoplay = true;
  viewerVideoEl.playsInline = true;
  viewerVideoEl.muted = false;
  viewerVideoEl.style.cssText = [
    'position:fixed', 'top:0', 'left:0',
    'width:100%', 'height:calc(100% - 56px)',
    'z-index:2147483640', 'background:#000',
    'object-fit:contain', 'pointer-events:none'
  ].join(';');
  viewerVideoEl.srcObject = stream;
  document.body.appendChild(viewerVideoEl);
  viewerVideoEl.play().catch(() => {
    viewerVideoEl.muted = true;
    viewerVideoEl.play().catch(console.warn);
  });
  postToOverlay({ type: 'screenShareStarted' });
  console.log('[SW Content] Viewer video injected');
}

function removeViewerVideo() {
  if (!viewerVideoEl) return;
  try { viewerVideoEl.srcObject = null; } catch (_) { }
  viewerVideoEl.remove();
  viewerVideoEl = null;
}

// ── Mic (Voice Chat) ──────────────────────────────────────────────

async function handleToggleMic(state) {
  if (state) {
    try {
      localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      postToOverlay({ type: 'chat', userId: 'System', text: '🎤 Microphone enabled.' });
      for (const [viewerId, pc] of Object.entries(rtcPeers)) {
        if (pc && pc.signalingState !== 'closed') {
          localMicStream.getTracks().forEach(t => pc.addTrack(t, localMicStream));
          pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
              chrome.runtime.sendMessage({ action: 'signal', targetId: viewerId, signalData: { offer: pc.localDescription } });
            })
            .catch(console.error);
        }
      }
    } catch (e) {
      console.error('[SW Content] Mic error:', e);
      postToOverlay({ type: 'chat', userId: 'System', text: '⚠ Mic error: Could not access microphone.' });
    }
  } else {
    if (localMicStream) {
      localMicStream.getTracks().forEach(t => t.stop());
      localMicStream = null;
      postToOverlay({ type: 'chat', userId: 'System', text: '🎤 Microphone disabled.' });
    }
  }
}

// ── Screen Share — HOST ───────────────────────────────────────────

// PRD Fix #4: Quality constraints map. Host can select desired resolution
// and frame rate from the controls overlay before starting a share.
const SHARE_QUALITY = {
  '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  '720p': { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  '480p': { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 24 } },
  '360p': { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 20 } },
};

async function startScreenShare(quality = '720p') {
  const videoConstraints = SHARE_QUALITY[quality] || SHARE_QUALITY['720p'];
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true
    });
    handleScreenShareStream(stream);
  } catch (err) {
    console.warn('[SW Content] getDisplayMedia failed, falling back to background capture:', err);
    chrome.runtime.sendMessage({ action: 'requestScreenShare' });
  }
}

async function handleScreenShareStream(stream) {
  localStream = stream;
  localStream.getTracks().forEach(track => { track.onended = () => stopScreenShare(); });
  postToOverlay({ type: 'screenShareStarted' });
  const viewers = [...knownPeers].filter(id => id !== userId);
  if (viewers.length === 0) {
    postToOverlay({ type: 'chat', userId: 'System', text: 'Screen share started — viewers will see it when they join.' });
  }
  for (const viewerId of viewers) {
    await createPeerForViewer(viewerId);
  }
}

async function handleScreenShareGranted(streamId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId }
      },
      video: {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId }
      }
    });
    handleScreenShareStream(stream);
  } catch (err) {
    console.warn('[SW Content] Capture with audio failed, retrying video only...', err);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } }
      });
      handleScreenShareStream(stream);
      postToOverlay({ type: 'chat', userId: 'System', text: '⚠ No audio captured — select "Share Tab" to include audio.' });
    } catch (fallbackErr) {
      console.error('[SW Content] Fallback screen share error:', fallbackErr);
      postToOverlay({ type: 'screenShareError', msg: 'Capture permission denied or failed.' });
    }
  }
}

function stopScreenShare() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  Object.keys(rtcPeers).forEach(id => closePeer(id));
  postToOverlay({ type: 'screenShareStopped' });
}

// ── createPeerForViewer (HOST) ────────────────────────────────────

async function createPeerForViewer(viewerId) {
  if (rtcPeers[viewerId]) {
    const state = rtcPeers[viewerId].connectionState;
    if (state === 'connected' || state === 'connecting') {
      console.log(`[SW Content] Peer ${viewerId} already ${state}`);
      return rtcPeers[viewerId];
    }
    console.log(`[SW Content] Replacing stale peer for ${viewerId} (was: ${state})`);
    closePeer(viewerId);
  }

  if (!localStream) return null;

  const pc = new RTCPeerConnection(ICE_SERVERS);
  rtcPeers[viewerId] = pc;
  pc._iceQueue = [];

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  if (localMicStream) localMicStream.getTracks().forEach(track => pc.addTrack(track, localMicStream));

  pc.ontrack = e => {
    if (!e.streams?.[0]) return;
    let aEl = document.getElementById(`sw-audio-${viewerId}`);
    if (!aEl) {
      aEl = document.createElement('audio');
      aEl.id = `sw-audio-${viewerId}`;
      aEl.autoplay = true;
      document.body.appendChild(aEl);
    }
    aEl.srcObject = e.streams[0];
  };

  pc.onicecandidate = e => {
    if (e.candidate)
      chrome.runtime.sendMessage({ action: 'signal', targetId: viewerId, signalData: { candidate: e.candidate } });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[SW Content] Peer ${viewerId} → ${pc.connectionState}`);
    if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch (_) { } }
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setTimeout(() => { if (rtcPeers[viewerId] === pc) delete rtcPeers[viewerId]; }, 3000);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    chrome.runtime.sendMessage({ action: 'signal', targetId: viewerId, signalData: { offer: pc.localDescription } });
  } catch (e) {
    console.error('[SW Content] createOffer error for', viewerId, ':', e);
    closePeer(viewerId);
    return null;
  }

  return pc;
}

// ── handleWebRTCSignal ────────────────────────────────────────────

async function handleWebRTCSignal(senderId, signal) {
  if (localStream) {
    // HOST: answers/candidates from viewers
    let pc = rtcPeers[senderId];
    if (!pc) pc = await createPeerForViewer(senderId);
    if (!pc) return;

    if (signal.offer) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        chrome.runtime.sendMessage({ action: 'signal', targetId: senderId, signalData: { answer: pc.localDescription } });
        drainIceQueue(pc);
      } catch (e) { console.error('[SW] HOST offer setRemoteDesc error:', e); }
    } else if (signal.answer) {
      try {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
          drainIceQueue(pc);
        }
      } catch (e) { console.error('[SW] answer setRemoteDesc error:', e); }
    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) pc.addIceCandidate(ice).catch(() => { });
      else pc._iceQueue.push(ice);
    }

  } else {
    // VIEWER: offers/candidates from host
    let pc = rtcPeers[senderId];

    if (!pc) {
      pc = new RTCPeerConnection(ICE_SERVERS);
      pc._iceQueue = [];
      rtcPeers[senderId] = pc;

      pc.onicecandidate = e => {
        if (e.candidate)
          chrome.runtime.sendMessage({ action: 'signal', targetId: senderId, signalData: { candidate: e.candidate } });
      };

      pc.ontrack = e => {
        if (!e.streams?.[0]) return;
        console.log('[SW Content] ✅ Received screen share stream');
        injectViewerVideo(e.streams[0]);
      };

      pc.onconnectionstatechange = () => {
        console.log(`[SW Content] Viewer peer ${senderId}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch (_) { } }
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
          removeViewerVideo();
          postToOverlay({ type: 'streamEnded' });
          setTimeout(() => { if (rtcPeers[senderId] === pc) delete rtcPeers[senderId]; }, 2000);
        }
      };
    }

    if (localMicStream && !pc.localTracksAddedForViewer) {
      localMicStream.getTracks().forEach(track => pc.addTrack(track, localMicStream));
      pc.localTracksAddedForViewer = true;
    }

    if (signal.offer) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        chrome.runtime.sendMessage({ action: 'signal', targetId: senderId, signalData: { answer: pc.localDescription } });
        drainIceQueue(pc);
      } catch (e) {
        console.error('[SW] offer setRemoteDesc error:', e);
        closePeer(senderId);
      }
    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) pc.addIceCandidate(ice).catch(() => { });
      else pc._iceQueue.push(ice);
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ action: 'getStatus' }, resp => {
  if (resp && resp.room && resp.connected) {
    inRoom = true;
    userId = resp.room.userId;
    myRoomId = resp.room.roomId;
    isHost = resp.room.isHost || false;
    hostOnlyMode = resp.room.hostOnlyMode || false;
    knownPeers.clear();
    (resp.room.otherUsers || []).forEach(id => knownPeers.add(id));

    if (IS_TOP_FRAME) {
      injectOverlay();
      setTimeout(() => {
        postToOverlay({ type: 'joined', roomId: resp.room.roomId, userId: resp.room.userId, memberCount: resp.room.memberCount, isHost });
      }, 1000);
    }
    startHeartbeat();
  }
});

startVideoScan();