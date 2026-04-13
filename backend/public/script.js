// SyncWatch Web Client
let socket = null;
let player = null;
let roomId = null;
let userId = null;
let isSyncing = false;
let wsUrl = '';

// 1. Extract Room ID from URL
const cleanPath = window.location.pathname.replace(/\/$/, '');
const pathParts = cleanPath.split('/');
roomId = pathParts[pathParts.length - 1].toUpperCase().replace(/[^A-Z0-9]/g, '');

if (roomId) {
  document.getElementById('inp-room-id').value = roomId;
}

// 2. YouTube API Loader
function onYouTubeIframeAPIReady() {
  console.log('YT API Ready');
  // Initial player create (will load actual video after joining)
  player = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    videoId: 'dQw4w9WgXcQ', // Placeholder
    playerVars: { 'autoplay': 0, 'controls': 1, 'rel': 0, 'modestbranding': 1 },
    events: {
      'onStateChange': onPlayerStateChange,
    }
  });
}

function onPlayerStateChange(event) {
  if (isSyncing) return;

  // YT.PlayerState.PLAYING = 1, PAUSED = 2
  if (event.data === YT.PlayerState.PLAYING) {
    send({ type: 'play', time: player.getCurrentTime() });
  } else if (event.data === YT.PlayerState.PAUSED) {
    send({ type: 'pause', time: player.getCurrentTime() });
  }
}

// 3. Connection Logic
const btnJoin = document.getElementById('btn-join');
btnJoin.addEventListener('click', startSync);

function startSync() {
  if (!roomId) return alert('No Room ID found!');
  
  // Fade out loading
  const loading = document.getElementById('loading-screen');
  loading.classList.remove('hidden');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    send({ type: 'join', roomId });
    document.getElementById('status-dot').className = 'status-dot online';
  };

  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch(err) {}
  };

  socket.onclose = () => {
    document.getElementById('status-dot').className = 'status-dot offline';
    alert('Disconnected from server');
  };
}

function send(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      userId = msg.userId;
      document.getElementById('view-idle').classList.add('hidden');
      document.getElementById('view-player').classList.remove('hidden');
      document.getElementById('room-badge').classList.remove('hidden');
      document.getElementById('room-id-display').textContent = roomId;
      document.getElementById('loading-screen').classList.add('hidden');
      applySync(msg.state);
      break;

    case 'play':
      if (msg.userId !== userId) applySync({ time: msg.time, playing: true });
      break;

    case 'pause':
      if (msg.userId !== userId) applySync({ time: msg.time, playing: false });
      break;

    case 'seek':
      if (msg.userId !== userId) {
        isSyncing = true;
        player.seekTo(msg.time);
        setTimeout(() => isSyncing = false, 500);
      }
      break;

    case 'sync':
      applySync(msg.state);
      break;

    case 'chat':
      addChatMessage(msg.userId, msg.text);
      break;

    case 'user_joined':
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      addChatMessage('System', `${msg.userId} joined the room`);
      break;

    case 'user_left':
      document.getElementById('member-count').textContent = `${msg.memberCount} watching`;
      addChatMessage('System', `${msg.userId} left the room`);
      break;

    case 'error':
      alert(msg.msg);
      window.location.href = '/';
      break;
  }
}

function applySync(state) {
  if (!player || !state) return;
  isSyncing = true;

  const diff = Math.abs(player.getCurrentTime() - state.time);
  if (diff > 1.5) {
    player.seekTo(state.time);
  }

  if (state.playing) {
    player.playVideo();
  } else {
    player.pauseVideo();
  }

  setTimeout(() => isSyncing = false, 800);
}

// 4. Chat UI
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if(e.key === 'Enter') sendChat(); });

function sendChat() {
  const text = chatInput.value.trim();
  if(!text) return;
  send({ type: 'chat', text });
  addChatMessage('You', text);
  chatInput.value = '';
}

function addChatMessage(author, text) {
  const box = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = author === 'System' ? 'msg system' : 'msg';
  
  if (author !== 'System') {
    div.innerHTML = `<span class="author">${author}:</span> <span class="text"></span>`;
    div.querySelector('.text').textContent = text;
  } else {
    div.textContent = text;
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// Auto-hide loading screen on start
window.addEventListener('load', () => {
  document.getElementById('loading-screen').classList.add('hidden');
});
