// ─────────────────────────────────────────────────────────────────
// SyncWatch — Content Script
// Injected into every page. Detects video, injects overlay bar,
// listens to playback events, applies remote sync commands.
// ─────────────────────────────────────────────────────────────────
'use strict';

// Guard: only run once per frame
if (window.__syncwatchInjected) { throw new Error('already injected'); }
window.__syncwatchInjected = true;

// ── State ────────────────────────────────────────────────────────
let video        = null;   // The detected <video> element
let isSyncing    = false;  // Prevent feedback loop when applying remote sync
let inRoom       = false;
let userId       = null;
let myRoomId     = null;
let overlayFrame = null;   // The injected controls iframe
let scanInterval = null;
let heartbeatInterval = null;

// WebRTC state (host only — screen share)
let rtcPeers   = {};
let localStream = null;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',    username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// ── Video detection ───────────────────────────────────────────────

function getVideoScore(el) {
  if (!el || el.tagName !== 'VIDEO') return 0;
  const area = el.offsetWidth * el.offsetHeight;
  if (area < 10000) return 0; // too small
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
      doc.querySelectorAll('iframe').forEach(f => {
        try { collect(f.contentDocument); } catch (_) {}
      });
    } catch (_) {}
  }
  collect(document);
  let best = null, bestScore = 0;
  all.forEach(v => {
    const s = getVideoScore(v);
    if (s > bestScore) { bestScore = s; best = v; }
  });
  return { video: best, score: bestScore };
}

function startVideoScan() {
  if (scanInterval) return;
  scanInterval = setInterval(() => {
    const { video: v, score } = findBestVideo();
    if (v && v !== video) {
      attachToVideo(v, score);
    }
  }, 1500);
}

function attachToVideo(v, score) {
  if (video) detachFromVideo();
  video = v;

  // Report to background
  chrome.runtime.sendMessage({ action: 'videoFound', score });

  // Attach listeners
  video.addEventListener('play',         handlePlay);
  video.addEventListener('pause',        handlePause);
  video.addEventListener('seeked',       handleSeeked);
  video.addEventListener('durationchange', handleDuration);

  console.log('[SW Content] Attached to video, score:', score);

  // Inject overlay if not present
  injectOverlay();
}

function detachFromVideo() {
  if (!video) return;
  video.removeEventListener('play',         handlePlay);
  video.removeEventListener('pause',        handlePause);
  video.removeEventListener('seeked',       handleSeeked);
  video.removeEventListener('durationchange', handleDuration);
  video = null;
}

// ── Playback event handlers ───────────────────────────────────────

function handlePlay(e) {
  if (isSyncing || !inRoom) return;
  chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'play', time: video.currentTime } });
}

function handlePause(e) {
  if (isSyncing || !inRoom) return;
  chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'pause', time: video.currentTime } });
}

function handleSeeked(e) {
  if (isSyncing || !inRoom) return;
  chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'seek', time: video.currentTime } });
}

function handleDuration() {
  postToOverlay({ type: 'duration', duration: video ? video.duration : 0 });
}

// ── Apply remote sync commands to video ──────────────────────────

function applySync(state) {
  if (!video) return;
  isSyncing = true;
  try {
    if (typeof state.time === 'number') {
      const diff = Math.abs(video.currentTime - state.time);
      if (diff > 1.5) video.currentTime = state.time;
    }
    if (state.playing && video.paused)       video.play().catch(() => {});
    if (!state.playing && !video.paused)     video.pause();
  } catch (e) { console.warn('[SW Content] applySync error:', e); }
  setTimeout(() => { isSyncing = false; }, 800);
}

function applyPlay(time) {
  if (!video) return;
  isSyncing = true;
  try {
    const diff = Math.abs(video.currentTime - time);
    if (diff > 1.5) video.currentTime = time;
    video.play().catch(() => {});
  } catch (_) {}
  setTimeout(() => { isSyncing = false; }, 600);
}

function applyPause(time) {
  if (!video) return;
  isSyncing = true;
  try {
    const diff = Math.abs(video.currentTime - time);
    if (diff > 1.5) video.currentTime = time;
    video.pause();
  } catch (_) {}
  setTimeout(() => { isSyncing = false; }, 600);
}

function applySeek(time) {
  if (!video) return;
  isSyncing = true;
  try { video.currentTime = time; } catch (_) {}
  setTimeout(() => { isSyncing = false; }, 500);
}

// ── Controls overlay (iframe) ────────────────────────────────────

function injectOverlay() {
  if (overlayFrame) return;

  // Shadow host
  const host = document.createElement('div');
  host.id = 'sw-overlay-host';
  host.style.cssText = `
    position: fixed; bottom: 0; left: 0; width: 100%; height: 56px;
    z-index: 2147483647; pointer-events: none;
  `;
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  overlayFrame = document.createElement('iframe');
  overlayFrame.src = chrome.runtime.getURL('controls.html');
  overlayFrame.style.cssText = `
    width: 100%; height: 100%; border: none;
    pointer-events: auto;
    background: transparent;
  `;
  shadow.appendChild(overlayFrame);

  // Listen for messages from overlay iframe
  window.addEventListener('message', handleOverlayMessage);
}

function removeOverlay() {
  const host = document.getElementById('sw-overlay-host');
  if (host) host.remove();
  overlayFrame = null;
  window.removeEventListener('message', handleOverlayMessage);
}

function postToOverlay(data) {
  if (overlayFrame && overlayFrame.contentWindow) {
    overlayFrame.contentWindow.postMessage(data, '*');
  }
}

function handleOverlayMessage(e) {
  const msg = e.data;
  if (!msg || !msg.swOverlay) return;

  switch (msg.swOverlay) {
    case 'play':
      if (video) { isSyncing = true; video.play().catch(() => {}); setTimeout(() => isSyncing = false, 600); }
      if (inRoom) chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'play', time: video ? video.currentTime : 0 } });
      break;
    case 'pause':
      if (video) { isSyncing = true; video.pause(); setTimeout(() => isSyncing = false, 600); }
      if (inRoom) chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'pause', time: video ? video.currentTime : 0 } });
      break;
    case 'seek':
      if (video) { isSyncing = true; video.currentTime = msg.time; setTimeout(() => isSyncing = false, 600); }
      if (inRoom) chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'seek', time: msg.time } });
      break;
    case 'chat':
      chrome.runtime.sendMessage({ action: 'sendChat', text: msg.text });
      break;
    case 'shareScreen':
      startScreenShare();
      break;
    case 'stopShare':
      stopScreenShare();
      break;
    case 'syncNow':
      chrome.runtime.sendMessage({ action: 'syncRequest' });
      break;
    case 'leave':
      chrome.runtime.sendMessage({ action: 'leaveRoom', tabId: chrome.runtime.id });
      break;
  }
}

// ── Messages FROM background ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg.sw) return;

  switch (msg.sw) {
    case 'joined':
      inRoom   = true;
      userId   = msg.userId;
      myRoomId = msg.roomId;
      postToOverlay({ type: 'joined', roomId: msg.roomId, userId: msg.userId, memberCount: msg.memberCount });
      if (msg.state && (msg.state.playing || msg.state.time > 2)) {
        setTimeout(() => applySync(msg.state), 500);
      }
      startHeartbeat();
      break;

    case 'play':
      if (msg.userId !== userId) {
        applyPlay(msg.time);
        postToOverlay({ type: 'play' });
      }
      break;

    case 'pause':
      if (msg.userId !== userId) {
        applyPause(msg.time);
        postToOverlay({ type: 'pause' });
      }
      break;

    case 'seek':
      if (msg.userId !== userId) {
        applySeek(msg.time);
      }
      break;

    case 'sync':
      applySync(msg.state);
      break;

    case 'chat':
      postToOverlay({ type: 'chat', text: msg.text, userId: msg.userId });
      break;

    case 'user_joined':
      postToOverlay({ type: 'user_joined', userId: msg.userId, memberCount: msg.memberCount });
      break;

    case 'user_left':
      postToOverlay({ type: 'user_left', userId: msg.userId, memberCount: msg.memberCount });
      if (rtcPeers[msg.userId]) {
        rtcPeers[msg.userId].close();
        delete rtcPeers[msg.userId];
      }
      break;

    case 'signal':
      handleWebRTCSignal(msg.senderId, msg.signalData);
      break;

    case 'left':
      inRoom   = false;
      userId   = null;
      myRoomId = null;
      removeOverlay();
      stopScreenShare();
      stopHeartbeat();
      break;

    case 'disconnected':
    case 'error':
      postToOverlay({ type: 'error', msg: msg.msg || 'Connection lost' });
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

// ── WebRTC Screen Share ───────────────────────────────────────────

async function startScreenShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true
    });

    localStream.getTracks().forEach(track => {
      track.onended = () => stopScreenShare();
    });

    postToOverlay({ type: 'screenShareStarted' });

    // Create peer for each user in room — signaling via background
    // We'll create offer for any existing peer IDs we know about
    // Background will relay signals via WebSocket
    chrome.runtime.sendMessage({ action: 'getStatus', tabId: null }, status => {
      // Create WebRTC offer to all
      createOfferToAllPeers();
    });

  } catch (e) {
    console.error('[SW Content] Screen share error:', e);
    postToOverlay({ type: 'screenShareError', msg: e.message });
  }
}

function stopScreenShare() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  Object.values(rtcPeers).forEach(pc => { try { pc.close(); } catch (_) {} });
  rtcPeers = {};
  postToOverlay({ type: 'screenShareStopped' });
}

async function createOfferToAllPeers() {
  // Triggered when host starts screen share
  // Peers connect via signal flow
  // We'll create peers lazily when we get 'user_joined' signals or on demand
  // For now, trigger a sync signal so new viewers get our offer
  chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'screen_share_started' } });
}

async function createPeerForViewer(viewerId) {
  if (rtcPeers[viewerId]) return rtcPeers[viewerId];

  const pc = new RTCPeerConnection(ICE_SERVERS);
  rtcPeers[viewerId] = pc;
  pc._iceQueue = [];

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate) {
      chrome.runtime.sendMessage({ action: 'signal', targetId: viewerId, signalData: { candidate: e.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[SW Content] Peer ${viewerId} state: ${pc.connectionState}`);
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      delete rtcPeers[viewerId];
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    chrome.runtime.sendMessage({ action: 'signal', targetId: viewerId, signalData: { offer } });
  } catch (e) {
    console.error('[SW Content] createOffer error:', e);
  }

  return pc;
}

async function handleWebRTCSignal(senderId, signal) {
  if (localStream) {
    // We are host — handle answers from viewers
    let pc = rtcPeers[senderId];
    if (!pc) pc = await createPeerForViewer(senderId);

    if (signal.answer) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
        drainIceQueue(pc);
      } catch (e) { console.error('[SW] setRemoteDescription(answer) error:', e); }
    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) pc.addIceCandidate(ice).catch(() => {});
      else pc._iceQueue.push(ice);
    }
  } else {
    // We are viewer — handle offer from host
    let pc = rtcPeers[senderId];
    if (!pc) {
      pc = new RTCPeerConnection(ICE_SERVERS);
      pc._iceQueue = [];
      rtcPeers[senderId] = pc;

      pc.onicecandidate = e => {
        if (e.candidate) {
          chrome.runtime.sendMessage({ action: 'signal', targetId: senderId, signalData: { candidate: e.candidate } });
        }
      };

      pc.ontrack = e => {
        // Viewer receives stream — send to overlay
        if (e.streams && e.streams[0]) {
          postToOverlay({ type: 'remoteStream', streamId: senderId });
          // We can't pass stream directly; overlay handles via its own WebRTC
        }
      };

      pc.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
          delete rtcPeers[senderId];
          postToOverlay({ type: 'streamEnded' });
        }
      };
    }

    if (signal.offer) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        chrome.runtime.sendMessage({ action: 'signal', targetId: senderId, signalData: { answer } });
        drainIceQueue(pc);
      } catch (e) { console.error('[SW] setRemoteDescription(offer) error:', e); }
    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) pc.addIceCandidate(ice).catch(() => {});
      else pc._iceQueue.push(ice);
    }
  }
}

function drainIceQueue(pc) {
  if (!pc._iceQueue?.length) return;
  pc._iceQueue.forEach(c => pc.addIceCandidate(c).catch(() => {}));
  pc._iceQueue = [];
}

// ── Init ──────────────────────────────────────────────────────────

// Check if we're already in a room (e.g., page refresh)
chrome.runtime.sendMessage({ action: 'getStatus', tabId: null }, resp => {
  if (resp && resp.room && resp.connected) {
    inRoom   = true;
    userId   = resp.room.userId;
    myRoomId = resp.room.roomId;
    injectOverlay();
    setTimeout(() => {
      postToOverlay({
        type: 'joined',
        roomId: resp.room.roomId,
        userId: resp.room.userId,
        memberCount: resp.room.memberCount
      });
    }, 1000);
    startHeartbeat();
  }
});

// Start scanning for video elements
startVideoScan();
