// SyncWatch Web Client  (FIXED v1.2)
'use strict';

let socket = null;
let player = null;
let roomId = null;
let userId = null;
let isSyncing = false;
let playerReady = false;
let streamConnected = false;

// Retry state for Render.com cold-start
let retryCount = 0;
const MAX_RETRY = 8;
const RETRY_DELAYS = [2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000];

// WebRTC
let rtcPeers = {};
let knownPeers = new Set();
let localStream = null;
let isWebClientSharing = false;
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// ── 1. Room ID from URL ───────────────────────────────────
const cleanPath = window.location.pathname.replace(/\/$/, '');
roomId = cleanPath.split('/').pop().toUpperCase().replace(/[^A-Z0-9]/g, '');
if (roomId) document.getElementById('inp-room-id').value = roomId;

// ── 2. YouTube API ────────────────────────────────────────
function onYouTubeIframeAPIReady() {
  player = new YT.Player('yt-player', {
    height: '100%', width: '100%', videoId: '',
    playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, origin: window.location.origin },
    events: {
      onReady: () => { playerReady = true; },
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerStateChange(event) {
  if (isSyncing || !playerReady) return;
  if (event.data === YT.PlayerState.PLAYING) send({ type: 'play', time: player.getCurrentTime() });
  else if (event.data === YT.PlayerState.PAUSED) send({ type: 'pause', time: player.getCurrentTime() });
}

// ── 3. Connection with retry ──────────────────────────────
document.getElementById('btn-join').addEventListener('click', () => { retryCount = 0; startSync(); });

function startSync() {
  if (!roomId) return alert('No Room ID found!');

  setStatus('connecting');
  document.getElementById('loading-screen').classList.remove('hidden');
  document.getElementById('btn-join').disabled = true;

  if (retryCount > 0) {
    document.querySelector('#loading-screen p').textContent =
      `Server is waking up… (attempt ${retryCount + 1}/${MAX_RETRY})`;
  } else {
    document.querySelector('#loading-screen p').textContent = 'Connecting to SyncWatch...';
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}`);

  const connectTimeout = setTimeout(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      socket.close();
      handleRetry('Server is taking a while to wake up...');
    }
  }, 15000);

  socket.onopen = () => {
    clearTimeout(connectTimeout);
    retryCount = 0;
    setStatus('online');
    send({ type: 'join', roomId });
  };

  socket.onmessage = e => {
    try { handleMessage(JSON.parse(e.data)); } catch (err) { console.error('[SW] Parse error:', err); }
  };

  socket.onclose = e => {
    clearTimeout(connectTimeout);
    setStatus('offline');
    if (e.code !== 1000 && e.code !== 1001) {
      handleRetry('Connection lost. Reconnecting...');
    } else {
      addChatMessage('System', 'Disconnected. Refresh to reconnect.');
      document.getElementById('btn-join').disabled = false;
    }
  };

  socket.onerror = () => {
    clearTimeout(connectTimeout);
    setStatus('offline');
  };
}

function handleRetry(reason) {
  if (retryCount >= MAX_RETRY) {
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('btn-join').disabled = false;
    addChatMessage('System', `Could not connect after ${MAX_RETRY} attempts. Check your connection and refresh.`);
    return;
  }

  const delay = RETRY_DELAYS[retryCount] || 30000;
  addChatMessage('System', `${reason} Retrying in ${Math.round(delay / 1000)}s...`);

  let remaining = Math.round(delay / 1000);
  const countdownEl = document.querySelector('#loading-screen p');
  const interval = setInterval(() => {
    remaining--;
    if (countdownEl) countdownEl.textContent = `Server waking up… retrying in ${remaining}s (attempt ${retryCount + 1}/${MAX_RETRY})`;
  }, 1000);

  setTimeout(() => {
    clearInterval(interval);
    retryCount++;
    startSync();
  }, delay);
}

function setStatus(state) {
  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot ' + (state === 'online' ? 'online' : 'offline');
}

function send(data) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

// ── 4. Message handler ────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'joined':
      userId = msg.userId;
      document.getElementById('view-idle').classList.add('hidden');
      document.getElementById('view-player').classList.remove('hidden');
      document.getElementById('room-badge').classList.remove('hidden');
      document.getElementById('room-id-display').textContent = roomId;
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      document.getElementById('btn-web-share').classList.remove('hidden');
      knownPeers.clear();
      (msg.otherUsers || []).forEach(id => knownPeers.add(id));
      showWaitingSplash();
      if (msg.state && (msg.state.playing || msg.state.time > 2)) waitForPlayerThenSync(msg.state);
      break;

    case 'play':
      if (msg.userId !== userId && !streamConnected) applySync({ time: msg.time, playing: true });
      break;

    case 'pause':
      if (msg.userId !== userId && !streamConnected) applySync({ time: msg.time, playing: false });
      break;

    case 'seek':
      if (msg.userId !== userId && !streamConnected) {
        isSyncing = true;
        if (player && playerReady) { try { player.seekTo(msg.time, true); } catch (_) { } }
        setTimeout(() => { isSyncing = false; }, 500);
      }
      break;

    case 'sync':
      if (!streamConnected) applySync(msg.state);
      break;

    case 'chat':
      addChatMessage(msg.userId, msg.text);
      break;

    case 'user_joined':
      knownPeers.add(msg.userId);
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      addChatMessage('System', `${msg.userId} joined`);
      if (localStream) createPeerForViewer(msg.userId);
      break;

    case 'user_left':
      knownPeers.delete(msg.userId);
      closePeer(msg.userId);
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      addChatMessage('System', `${msg.userId} left`);
      break;

    case 'signal':
      handleSignal(msg.senderId, msg.signalData);
      break;

    case 'error':
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('btn-join').disabled = false;
      addChatMessage('System', 'Error: ' + msg.msg);
      break;
  }
}

// ── 5. Sync apply ─────────────────────────────────────────

function waitForPlayerThenSync(state) {
  if (playerReady) { applySync(state); return; }
  let attempts = 0;
  const check = setInterval(() => {
    attempts++;
    if (playerReady) { clearInterval(check); applySync(state); }
    if (attempts > 20) clearInterval(check);
  }, 500);
}

function applySync(state) {
  if (!player || !playerReady) return;
  isSyncing = true;
  try {
    const cur = player.getCurrentTime() || 0;
    if (typeof state.time === 'number' && Math.abs(cur - state.time) > 1.5) player.seekTo(state.time, true);
    if (state.playing) player.playVideo();
    else player.pauseVideo();
  } catch (_) { }
  setTimeout(() => { isSyncing = false; }, 800);
}

// ── 6. Waiting splash ─────────────────────────────────────

function showWaitingSplash() {
  if (document.getElementById('sw-waiting')) return;
  const wrapper = document.querySelector('.player-wrapper');
  if (!wrapper) return;
  const splash = document.createElement('div');
  splash.id = 'sw-waiting';
  splash.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(5,8,15,0.85);gap:16px;color:#f8fafc;';
  splash.innerHTML = `
    <div style="width:48px;height:48px;border:4px solid rgba(124,159,255,0.3);border-top-color:#7c9fff;border-radius:50%;animation:swspin 1s linear infinite;"></div>
    <div style="font-size:16px;font-weight:600;">Waiting for host to share screen...</div>
    <div style="font-size:12px;color:#94a3b8;">Or the host can use the extension to sync a video</div>
    <style>@keyframes swspin{to{transform:rotate(360deg)}}</style>
  `;
  wrapper.appendChild(splash);
}

function hideWaitingSplash() {
  const el = document.getElementById('sw-waiting');
  if (el) el.remove();
}

// ── 7. WebRTC helpers ─────────────────────────────────────

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

// Screen share buttons
document.getElementById('btn-web-share').addEventListener('click', () => {
  if (isWebClientSharing) stopLocalScreenShare();
  else startLocalScreenShare();
});

async function startLocalScreenShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false }
    });
    localStream.getTracks().forEach(track => { track.onended = () => stopLocalScreenShare(); });
    
    // Check if audio track is missing
    const hasAudio = localStream.getAudioTracks().length > 0;
    if (!hasAudio) {
      addChatMessage('System', '⚠ Notice: No audio captured! To share audio (e.g. video sound), you MUST select "Share Tab" instead of Window/Entire Screen on Mac/PC.');
    }

    isWebClientSharing = true;
    const btn = document.getElementById('btn-web-share');
    btn.innerHTML = '🔴 Stop Share';
    btn.style.background = 'rgba(244,63,94,0.15)';
    btn.style.color = '#f43f5e';
    btn.style.borderColor = 'rgba(244,63,94,0.3)';

    // Show our own stream locally
    const remoteVid = document.getElementById('remote-stream');
    const ytPlayer = document.getElementById('yt-player');
    if (remoteVid) {
      remoteVid.srcObject = localStream;
      remoteVid.style.display = 'block';
      remoteVid.muted = true;
      remoteVid.play().catch(() => { });
    }
    if (ytPlayer) ytPlayer.style.display = 'none';
    hideWaitingSplash();
    streamConnected = true;

    // FIX v1.2: offer to ALL current peers
    const viewers = [...knownPeers].filter(id => id !== userId);
    for (const viewerId of viewers) {
      await createPeerForViewer(viewerId);
    }
    addChatMessage('System', '📡 You started sharing your screen.');

  } catch (e) {
    console.error('[WC] Screen share error:', e);
    localStream = null;
    addChatMessage('System', e.name === 'NotAllowedError'
      ? 'Screen share cancelled.'
      : 'Error starting screen share: ' + e.message);
  }
}

function stopLocalScreenShare() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  isWebClientSharing = false;

  const btn = document.getElementById('btn-web-share');
  btn.innerHTML = '📡 Share Screen';
  btn.style.background = 'rgba(74,222,128,0.15)';
  btn.style.color = '#4ade80';
  btn.style.borderColor = 'rgba(74,222,128,0.3)';

  const remoteVid = document.getElementById('remote-stream');
  const ytPlayer = document.getElementById('yt-player');
  if (remoteVid) { remoteVid.style.display = 'none'; remoteVid.srcObject = null; remoteVid.muted = false; }
  if (ytPlayer) ytPlayer.style.display = 'block';
  streamConnected = false;
  showWaitingSplash();

  Object.keys(rtcPeers).forEach(id => closePeer(id));
  addChatMessage('System', 'Screen share ended.');
}

// FIX v1.2: close stale peer before creating new one — prevents duplicate / zombie peers
async function createPeerForViewer(viewerId) {
  if (rtcPeers[viewerId]) {
    const state = rtcPeers[viewerId].connectionState;
    if (state === 'connected' || state === 'connecting') {
      return rtcPeers[viewerId];
    }
    closePeer(viewerId);
  }
  if (!localStream) return null;

  const pc = new RTCPeerConnection(ICE_SERVERS);
  rtcPeers[viewerId] = pc;
  pc._iceQueue = [];

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = e => {
    if (e.candidate) send({ type: 'signal', targetId: viewerId, signalData: { candidate: e.candidate } });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      try { pc.restartIce(); } catch (_) { }
    }
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setTimeout(() => { if (rtcPeers[viewerId] === pc) delete rtcPeers[viewerId]; }, 3000);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', targetId: viewerId, signalData: { offer: pc.localDescription } });
  } catch (e) {
    console.error('[WC] createOffer error:', e);
    closePeer(viewerId);
    return null;
  }

  return pc;
}

async function handleSignal(senderId, signal) {
  if (localStream) {
    // HOST side
    let pc = rtcPeers[senderId];
    if (!pc) pc = await createPeerForViewer(senderId);
    if (!pc) return;

    if (signal.answer) {
      try {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
          drainIceQueue(pc);
        }
      } catch (e) { console.error('[WC] answer error:', e); }
    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) pc.addIceCandidate(ice).catch(() => { });
      else pc._iceQueue.push(ice);
    }

  } else {
    // VIEWER side
    let pc = rtcPeers[senderId];
    if (!pc) {
      pc = new RTCPeerConnection(ICE_SERVERS);
      pc._iceQueue = [];
      rtcPeers[senderId] = pc;

      pc.onicecandidate = e => {
        if (e.candidate) send({ type: 'signal', targetId: senderId, signalData: { candidate: e.candidate } });
      };

      pc.ontrack = e => {
        if (!e.streams?.[0]) return;
        const remoteVid = document.getElementById('remote-stream');
        const ytPlayer = document.getElementById('yt-player');
        if (remoteVid) {
          remoteVid.srcObject = e.streams[0];
          remoteVid.style.display = 'block';
          remoteVid.muted = false;
          remoteVid.play().catch(() => {
            // Autoplay blocked — prompt user
            remoteVid.muted = true;
            remoteVid.play().then(() => {
              addChatMessage('System', '🔇 Video muted (autoplay policy). Click the video to unmute.');
              remoteVid.addEventListener('click', () => { remoteVid.muted = false; }, { once: true });
            }).catch(() => { });
          });
        }
        if (ytPlayer) ytPlayer.style.display = 'none';
        streamConnected = true;
        hideWaitingSplash();
        addChatMessage('System', '🎥 Screen share connected!');
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          try { pc.restartIce(); } catch (_) { }
        }
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
          const remoteVid = document.getElementById('remote-stream');
          const ytPlayer = document.getElementById('yt-player');
          if (remoteVid) { remoteVid.style.display = 'none'; remoteVid.srcObject = null; }
          if (ytPlayer) ytPlayer.style.display = 'block';
          streamConnected = false;
          showWaitingSplash();
          addChatMessage('System', 'Screen share ended.');
          setTimeout(() => { if (rtcPeers[senderId] === pc) delete rtcPeers[senderId]; }, 2000);
        }
      };
    }

    if (signal.offer) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'signal', targetId: senderId, signalData: { answer: pc.localDescription } });
        drainIceQueue(pc);
      } catch (e) {
        console.error('[WC] offer error:', e);
        closePeer(senderId);
      }
    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) pc.addIceCandidate(ice).catch(() => { });
      else pc._iceQueue.push(ice);
    }
  }
}

// ── 8. Chat ───────────────────────────────────────────────
document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
  send({ type: 'chat', text });
  addChatMessage('You', text);
  input.value = '';
}

// FIX v1.2: proper chat scroll that doesn't hijack when user is reading old messages,
// and compensates scroll position when old messages are trimmed from top.
function addChatMessage(author, text) {
  const box = document.getElementById('chat-messages');
  if (!box) return;

  // Check if user is already near the bottom BEFORE we add the new message
  const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  const div = document.createElement('div');
  if (author === 'System') {
    div.className = 'msg system';
    div.textContent = text;
  } else {
    div.className = 'msg';
    const authorEl = document.createElement('span');
    authorEl.className = 'author';
    authorEl.textContent = esc(author) + ':';
    const textEl = document.createElement('span');
    textEl.textContent = ' ' + text;
    div.appendChild(authorEl);
    div.appendChild(textEl);
  }

  box.appendChild(div);

  // Trim oldest messages but compensate scroll so view doesn't jump
  const MAX_MSGS = 150;
  while (box.children.length > MAX_MSGS) {
    const removed = box.firstChild;
    const removedH = removed.offsetHeight || 0;
    box.removeChild(removed);
    // If user was NOT near bottom, compensate so their view stays stable
    if (!isNearBottom) {
      box.scrollTop = Math.max(0, box.scrollTop - removedH);
    }
  }

  // Only auto-scroll if the user was already near the bottom
  if (isNearBottom) {
    // Defer to next frame to avoid forced-reflow
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
}

function esc(str) {
  return String(str).replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── 9. Init ───────────────────────────────────────────────
window.addEventListener('load', () => {
  document.getElementById('loading-screen').classList.add('hidden');
  if (roomId) setTimeout(startSync, 300);
});