// ─────────────────────────────────────────────────────────────────
// SyncWatch — Content Script  (FIXED v1.3)
// ─────────────────────────────────────────────────────────────────
'use strict';

if (window.__syncwatchInjected) { throw new Error('already injected'); }
window.__syncwatchInjected = true;

// ── State ────────────────────────────────────────────────────────
let video = null;
let isSyncing = false;
let inRoom = false;
let userId = null;
let myRoomId = null;
let overlayFrame = null;
let scanInterval = null;
let heartbeatInterval = null;

let knownPeers = new Set();

// WebRTC state
let rtcPeers = {};
let localStream = null;

// FIX v1.3: Viewer video element (extension user receiving screen share)
let viewerVideoEl = null;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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
  chrome.runtime.sendMessage({ action: 'videoFound', score });
  video.addEventListener('play', handlePlay);
  video.addEventListener('pause', handlePause);
  video.addEventListener('seeked', handleSeeked);
  video.addEventListener('durationchange', handleDuration);
  injectOverlay();
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

function handlePlay() { if (isSyncing || !inRoom) return; chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'play', time: video.currentTime } }); }
function handlePause() { if (isSyncing || !inRoom) return; chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'pause', time: video.currentTime } }); }
function handleSeeked() { if (isSyncing || !inRoom) return; chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'seek', time: video.currentTime } }); }
function handleDuration() { postToOverlay({ type: 'duration', duration: video ? video.duration : 0 }); }

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

// ── Controls overlay (iframe) ─────────────────────────────────────

function injectOverlay() {
  if (overlayFrame) return;

  const host = document.createElement('div');
  host.id = 'sw-overlay-host';
  host.style.cssText = 'position:fixed;bottom:0;left:0;width:100%;height:56px;z-index:2147483647;pointer-events:none;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  overlayFrame = document.createElement('iframe');
  overlayFrame.src = chrome.runtime.getURL('controls.html');
  overlayFrame.style.cssText = 'width:100%;height:100%;border:none;pointer-events:auto;background:transparent;';
  shadow.appendChild(overlayFrame);

  window.addEventListener('message', handleOverlayMessage);
  console.log('[SW Content] Overlay injected');
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
      if (video) { isSyncing = true; video.play().catch(() => { }); setTimeout(() => { isSyncing = false; }, 600); }
      if (inRoom) chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'play', time: video ? video.currentTime : 0 } });
      break;
    case 'pause':
      if (video) { isSyncing = true; video.pause(); setTimeout(() => { isSyncing = false; }, 600); }
      if (inRoom) chrome.runtime.sendMessage({ action: 'playbackEvent', event: { type: 'pause', time: video ? video.currentTime : 0 } });
      break;
    case 'seek':
      if (video) { isSyncing = true; video.currentTime = msg.time; setTimeout(() => { isSyncing = false; }, 600); }
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
      chrome.runtime.sendMessage({ action: 'leaveRoom' });
      break;
  }
}

// ── Messages FROM background ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg.sw) return;

  switch (msg.sw) {
    case 'joined':
      inRoom = true;
      userId = msg.userId;
      myRoomId = msg.roomId;
      knownPeers.clear();
      (msg.otherUsers || []).forEach(id => knownPeers.add(id));

      injectOverlay();
      setTimeout(() => {
        postToOverlay({ type: 'joined', roomId: msg.roomId, userId: msg.userId, memberCount: msg.memberCount });
      }, 800);

      if (msg.state && (msg.state.playing || msg.state.time > 2)) {
        setTimeout(() => applySync(msg.state), 500);
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

    case 'chat':
      postToOverlay({ type: 'chat', text: msg.text, userId: msg.userId });
      break;

    case 'user_joined':
      knownPeers.add(msg.userId);
      postToOverlay({ type: 'user_joined', userId: msg.userId, memberCount: msg.memberCount });
      if (localStream) {
        console.log('[SW Content] New viewer during share, offering:', msg.userId);
        createPeerForViewer(msg.userId);
      }
      break;

    case 'user_left':
      knownPeers.delete(msg.userId);
      postToOverlay({ type: 'user_left', userId: msg.userId, memberCount: msg.memberCount });
      closePeer(msg.userId);
      break;

    case 'signal':
      handleWebRTCSignal(msg.senderId, msg.signalData);
      break;

    case 'left':
      inRoom = false;
      userId = null;
      myRoomId = null;
      knownPeers.clear();
      removeOverlay();
      stopScreenShare();
      removeViewerVideo();
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

// ── Viewer video (extension user receiving a screen share) ────────

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

// ── Screen Share — HOST ───────────────────────────────────────────

async function startScreenShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true
    });

    localStream.getTracks().forEach(track => {
      track.onended = () => stopScreenShare();
    });

    postToOverlay({ type: 'screenShareStarted' });

    const viewers = [...knownPeers].filter(id => id !== userId);
    if (viewers.length === 0) {
      postToOverlay({ type: 'chat', userId: 'System', text: 'Screen share started — viewers will see it when they join.' });
    }
    for (const viewerId of viewers) {
      await createPeerForViewer(viewerId);
    }
  } catch (e) {
    console.error('[SW Content] Screen share error:', e);
    localStream = null;
    postToOverlay({
      type: 'screenShareError',
      msg: e.name === 'NotAllowedError' ? 'Permission denied. Allow screen access and try again.' : e.message
    });
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

// ── createPeerForViewer (HOST) ─────────────────────────────────────
// FIX v1.3: check peer health instead of blindly returning stale peer

async function createPeerForViewer(viewerId) {
  // If peer exists and is healthy, skip
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

  pc.onicecandidate = e => {
    if (e.candidate) {
      chrome.runtime.sendMessage({ action: 'signal', targetId: viewerId, signalData: { candidate: e.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[SW Content] Peer ${viewerId} → ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      // Attempt ICE restart
      try { pc.restartIce(); } catch (_) { }
    }
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setTimeout(() => { if (rtcPeers[viewerId] === pc) delete rtcPeers[viewerId]; }, 3000);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    chrome.runtime.sendMessage({
      action: 'signal',
      targetId: viewerId,
      signalData: { offer: pc.localDescription }
    });
  } catch (e) {
    console.error('[SW Content] createOffer error for', viewerId, ':', e);
    closePeer(viewerId);
    return null;
  }

  return pc;
}

// ── handleWebRTCSignal ─────────────────────────────────────────────

async function handleWebRTCSignal(senderId, signal) {
  if (localStream) {
    // ── HOST: answers/candidates from viewers ──
    let pc = rtcPeers[senderId];
    if (!pc) pc = await createPeerForViewer(senderId);
    if (!pc) return;

    if (signal.answer) {
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
    // ── VIEWER: offers/candidates from host ──
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

      // FIX v1.3: ontrack was COMPLETELY MISSING — viewer never received the stream!
      pc.ontrack = e => {
        if (!e.streams?.[0]) return;
        console.log('[SW Content] ✅ Received screen share stream');
        injectViewerVideo(e.streams[0]);
      };

      pc.onconnectionstatechange = () => {
        console.log(`[SW Content] Viewer peer ${senderId}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') {
          try { pc.restartIce(); } catch (_) { }
        }
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
          removeViewerVideo();
          postToOverlay({ type: 'streamEnded' });
          setTimeout(() => { if (rtcPeers[senderId] === pc) delete rtcPeers[senderId]; }, 2000);
        }
      };
    }

    if (signal.offer) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        chrome.runtime.sendMessage({
          action: 'signal',
          targetId: senderId,
          signalData: { answer: pc.localDescription }
        });
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
    knownPeers.clear();
    (resp.room.otherUsers || []).forEach(id => knownPeers.add(id));
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

startVideoScan();