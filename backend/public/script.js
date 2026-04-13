// SyncWatch Web Client v2
'use strict';

let socket     = null;
let player     = null;
let roomId     = null;
let userId     = null;
let isSyncing  = false;
let wsUrl      = '';
let streamConnected = false;

// WebRTC State
let rtcPeers = {};
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── 1. Extract Room ID from URL ───────────────────────────
const cleanPath = window.location.pathname.replace(/\/$/, '');
const pathParts = cleanPath.split('/');
roomId = pathParts[pathParts.length - 1].toUpperCase().replace(/[^A-Z0-9]/g, '');

if (roomId) {
  document.getElementById('inp-room-id').value = roomId;
}

// ── 2. YouTube API ────────────────────────────────────────
function onYouTubeIframeAPIReady() {
  player = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    videoId: '',          // No placeholder — start blank
    playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
    events: { onStateChange: onPlayerStateChange }
  });
}

function onPlayerStateChange(event) {
  if (isSyncing) return;
  if (event.data === YT.PlayerState.PLAYING) {
    send({ type: 'play', time: player.getCurrentTime() });
  } else if (event.data === YT.PlayerState.PAUSED) {
    send({ type: 'pause', time: player.getCurrentTime() });
  }
}

// ── 3. Connection ─────────────────────────────────────────
document.getElementById('btn-join').addEventListener('click', startSync);

function startSync() {
  if (!roomId) return alert('No Room ID found!');

  document.getElementById('loading-screen').classList.remove('hidden');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    send({ type: 'join', roomId });
    document.getElementById('status-dot').className = 'status-dot online';
  };

  socket.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch {}
  };

  socket.onclose = () => {
    document.getElementById('status-dot').className = 'status-dot offline';
    addChatMessage('System', 'Disconnected from server');
  };

  socket.onerror = () => {
    document.getElementById('status-dot').className = 'status-dot offline';
  };
}

function send(data) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

// ── 4. Message handler ────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'joined':
      userId = msg.userId;
      // Show player view
      document.getElementById('view-idle').classList.add('hidden');
      document.getElementById('view-player').classList.remove('hidden');
      document.getElementById('room-badge').classList.remove('hidden');
      document.getElementById('room-id-display').textContent = roomId;
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      // Show waiting splash until stream arrives
      showWaitingSplash();
      applySync(msg.state);
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
        if (player) player.seekTo(msg.time);
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
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      addChatMessage('System', `${msg.userId} joined`);
      break;

    case 'user_left':
      if (rtcPeers[msg.userId]) {
        rtcPeers[msg.userId].close();
        delete rtcPeers[msg.userId];
      }
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      addChatMessage('System', `${msg.userId} left`);
      break;

    case 'signal':
      handleSignal(msg.senderId, msg.signalData);
      break;

    case 'error':
      alert(msg.msg);
      window.location.href = '/';
      break;
  }
}

// ── 5. Sync apply (for YouTube fallback) ─────────────────
function applySync(state) {
  if (!player || !state || streamConnected) return;
  isSyncing = true;
  try {
    const diff = Math.abs(player.getCurrentTime() - state.time);
    if (diff > 1.5) player.seekTo(state.time);
    if (state.playing) player.playVideo();
    else player.pauseVideo();
  } catch {}
  setTimeout(() => { isSyncing = false; }, 800);
}

// ── 6. Waiting splash ─────────────────────────────────────
function showWaitingSplash() {
  if (streamConnected) return;
  const wrapper = document.querySelector('.player-wrapper');
  if (!wrapper || document.getElementById('sw-waiting')) return;

  const splash = document.createElement('div');
  splash.id = 'sw-waiting';
  splash.innerHTML = `
    <div style="
      position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:16px;
      background:rgba(5,8,15,0.92);z-index:5;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      color:#f8fafc;text-align:center;padding:32px;
    ">
      <div style="width:48px;height:48px;border:4px solid #1e293b;border-top-color:#7c9fff;border-radius:50%;animation:swspin 1s linear infinite;"></div>
      <div style="font-size:20px;font-weight:700;">Waiting for host to share screen</div>
      <div style="font-size:14px;color:#64748b;max-width:280px;line-height:1.6;">
        The host needs to click 📺 in their SyncWatch extension overlay to start sharing.
        <br><br>
        Video sync is still active while you wait.
      </div>
    </div>
    <style>@keyframes swspin{to{transform:rotate(360deg)}}</style>
  `;
  wrapper.appendChild(splash);
}

function hideWaitingSplash() {
  const el = document.getElementById('sw-waiting');
  if (el) el.remove();
}

// ── 7. WebRTC ─────────────────────────────────────────────
async function handleSignal(senderId, signal) {
  let pc = rtcPeers[senderId];
  if (!pc) {
    pc = new RTCPeerConnection(ICE_SERVERS);
    pc._iceQueue = [];
    rtcPeers[senderId] = pc;

    pc.onicecandidate = e => {
      if (e.candidate) send({ type: 'signal', targetId: senderId, signalData: { candidate: e.candidate } });
    };

    pc.ontrack = e => {
      if (!e.streams[0]) return;
      const remoteVid = document.getElementById('remote-stream');
      const ytPlayer  = document.getElementById('yt-player');

      // Swap out YT iframe for live stream
      if (remoteVid) {
        remoteVid.srcObject = e.streams[0];
        remoteVid.style.display = 'block';
        remoteVid.play().catch(() => {});
      }
      if (ytPlayer) ytPlayer.style.display = 'none';

      streamConnected = true;
      hideWaitingSplash();
      addChatMessage('System', '🎥 Live screen share connected!');
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        // Host stopped sharing — show YT fallback again
        const remoteVid = document.getElementById('remote-stream');
        const ytPlayer  = document.getElementById('yt-player');
        if (remoteVid) { remoteVid.style.display = 'none'; remoteVid.srcObject = null; }
        if (ytPlayer)  ytPlayer.style.display = 'block';
        streamConnected = false;
        showWaitingSplash();
        addChatMessage('System', 'Screen share ended, reverting to sync mode');
        delete rtcPeers[senderId];
      }
    };
  }

  try {
    if (signal.offer) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', targetId: senderId, signalData: { answer } });
      drainIceQueue(pc);

    } else if (signal.answer) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
      drainIceQueue(pc);

    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) {
        pc.addIceCandidate(ice).catch(() => {});
      } else {
        pc._iceQueue.push(ice);
      }
    }
  } catch (e) {
    console.error('[WC] Signal error:', e);
  }
}

function drainIceQueue(pc) {
  if (!pc._iceQueue?.length) return;
  pc._iceQueue.forEach(c => pc.addIceCandidate(c).catch(() => {}));
  pc._iceQueue = [];
}

// ── 8. Chat UI ────────────────────────────────────────────
const chatInput = document.getElementById('chat-input');
const chatSend  = document.getElementById('chat-send');

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  addChatMessage('You', text);
  chatInput.value = '';
}

function addChatMessage(author, text) {
  const box = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = author === 'System' ? 'msg system' : 'msg';

  if (author !== 'System') {
    div.innerHTML = `<span class="author">${esc(author)}:</span> <span class="text"></span>`;
    div.querySelector('.text').textContent = text;
  } else {
    div.textContent = text;
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function esc(str) {
  return String(str).replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── 9. Init ───────────────────────────────────────────────
window.addEventListener('load', () => {
  document.getElementById('loading-screen').classList.add('hidden');
});
