// SyncWatch Controls Overlay — controls.js  (FIXED v2.0)
// PRD Fixes:
//  - Quality selector passed with shareScreen message (#4)
//  - Host-only toggle button shown only to host, wires up hostOnlyToggle (#7)
//  - hostOnlyMode message updates banner and button state (#7)
//  - isHost from 'joined' message controls host-only button visibility (#7)
'use strict';

const BACKEND = 'https://syncwatch-64jv.onrender.com';

let chatOpen = false;
let unreadCount = 0;
let isSharing = false;
let myRoomId = null;
let myUserId = null;
let amHost = false;       // PRD Fix #7
let hostOnlyActive = false;    // PRD Fix #7

// ── Listen for messages FROM content script ───────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'joined':
      myRoomId = msg.roomId;
      myUserId = msg.userId;
      amHost = msg.isHost || false;  // PRD Fix #7
      document.getElementById('room-id-lbl').textContent = msg.roomId || '--------';
      document.getElementById('member-count').textContent = msg.memberCount || 1;
      setConnected(true);
      addMsg('sys', `Joined room ${msg.roomId} as ${msg.userId}${amHost ? ' (host)' : ''}`);

      // PRD Fix #7: only reveal the host-only button to the host
      if (amHost) {
        document.getElementById('btn-host-only').style.display = 'flex';
      }
      break;

    case 'play':
      addMsg('sys', '▶ Remote: Play');
      break;

    case 'pause':
      addMsg('sys', '⏸ Remote: Pause');
      break;

    case 'chat':
      if (msg.userId !== myUserId) {
        addMsg('user', msg.text, msg.userId);
        if (!chatOpen) bumpUnread();
      }
      break;

    case 'user_joined':
      document.getElementById('member-count').textContent = msg.memberCount;
      addMsg('sys', `${msg.userId} joined`);
      break;

    case 'user_left':
      document.getElementById('member-count').textContent = msg.memberCount;
      addMsg('sys', `${msg.userId} left`);
      break;

    case 'screenShareStarted': {
      isSharing = true;
      const btn = document.getElementById('btn-share');
      btn.textContent = '🔴 Stop Share';
      btn.classList.add('active');
      addMsg('sys', '📡 Screen share started');
      break;
    }

    case 'screenShareStopped': {
      isSharing = false;
      const btnS = document.getElementById('btn-share');
      btnS.textContent = '📡 Share Screen';
      btnS.classList.remove('active');
      addMsg('sys', 'Screen share ended');
      break;
    }

    case 'screenShareError':
      addMsg('sys', `⚠ Screen share error: ${msg.msg}`);
      break;

    case 'streamEnded':
      addMsg('sys', 'Screen share stream ended');
      break;

    // PRD Fix #7: update host-only UI for all room members
    case 'hostOnlyMode':
      hostOnlyActive = msg.state;
      const banner = document.getElementById('host-only-banner');
      banner.classList.toggle('show', hostOnlyActive);
      const hostBtn = document.getElementById('btn-host-only');
      hostBtn.classList.toggle('active', hostOnlyActive);
      hostBtn.title = hostOnlyActive ? 'Host-Only: ON — click to disable' : 'Toggle Host-Only Controls';
      addMsg('sys', hostOnlyActive ? '🔒 Host-only controls enabled' : '🔓 Host-only controls disabled');
      break;

    case 'error':
      setConnected(false);
      addMsg('sys', `⚠ ${msg.msg}`);
      break;

    case 'timeUpdate':
      break;

    case 'duration':
      break;
  }
});

// ── UI event handlers ─────────────────────────────────────────────

document.getElementById('btn-play').addEventListener('click', () => {
  window.parent.postMessage({ swOverlay: 'play' }, '*');
});

document.getElementById('btn-pause').addEventListener('click', () => {
  window.parent.postMessage({ swOverlay: 'pause' }, '*');
});

document.getElementById('btn-sync').addEventListener('click', () => {
  window.parent.postMessage({ swOverlay: 'syncNow' }, '*');
  addMsg('sys', '⟳ Sync requested...');
  showSyncFlash();
});

// PRD Fix #4: read quality selection before starting share
document.getElementById('btn-share').addEventListener('click', () => {
  if (isSharing) {
    window.parent.postMessage({ swOverlay: 'stopShare' }, '*');
  } else {
    const quality = document.getElementById('quality-select').value;
    window.parent.postMessage({ swOverlay: 'shareScreen', quality }, '*');
    addMsg('sys', `Starting screen share (${quality})...`);
  }
});

// PRD Fix #7: host-only toggle — only the host can toggle; button is hidden for guests
document.getElementById('btn-host-only').addEventListener('click', () => {
  if (!amHost) return;
  hostOnlyActive = !hostOnlyActive;
  window.parent.postMessage({ swOverlay: 'hostOnlyToggle', state: hostOnlyActive }, '*');
});

document.getElementById('btn-leave').addEventListener('click', () => {
  if (confirm('Leave this SyncWatch room?')) {
    window.parent.postMessage({ swOverlay: 'leave' }, '*');
  }
});

// Mic toggle
let isMicOn = false;
document.getElementById('btn-mic').addEventListener('click', () => {
  isMicOn = !isMicOn;
  const btn = document.getElementById('btn-mic');
  btn.style.color = isMicOn ? 'var(--green)' : 'var(--muted)';
  window.parent.postMessage({ swOverlay: 'toggleMic', state: isMicOn }, '*');
});

// Chat toggle
document.getElementById('btn-chat').addEventListener('click', () => {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('open', chatOpen);
  window.parent.postMessage({ swOverlay: 'toggleChatPanel', open: chatOpen }, '*');
  if (chatOpen) {
    unreadCount = 0;
    document.getElementById('chat-badge').textContent = '0';
    document.getElementById('chat-badge').classList.add('hidden');
    document.getElementById('chat-input').focus();
    const box = document.getElementById('chat-msgs');
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
});

document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// Image send logic
document.getElementById('btn-img').addEventListener('click', () => { document.getElementById('file-img').click(); });
document.getElementById('file-img').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      const cvs = document.createElement('canvas');
      const maxW = 500;
      let w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
      cvs.width = w; cvs.height = h;
      cvs.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUri = cvs.toDataURL('image/jpeg', 0.6);
      window.parent.postMessage({ swOverlay: 'chat', text: dataUri }, '*');
      addMsg('user', dataUri, 'You');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  window.parent.postMessage({ swOverlay: 'chat', text }, '*');
  addMsg('user', text, 'You');
  input.value = '';
}

// Room ID click → copy invite link
document.getElementById('room-id-lbl').addEventListener('click', () => {
  if (!myRoomId) return;
  const link = `${BACKEND}/join/${myRoomId}`;
  navigator.clipboard.writeText(link).then(() => {
    showCopyToast();
  }).catch(() => {
    prompt('Copy this invite link:', link);
  });
});

// Send handshake to content script to confirm load
window.parent.postMessage({ swOverlay: 'ready' }, '*');

// ── Chat message helper ───────────────────────────────────────────

const MAX_CHAT_MSGS = 150;

function addMsg(type, text, author) {
  const box = document.getElementById('chat-msgs');
  const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  const div = document.createElement('div');
  if (type === 'sys') {
    div.className = 'msg sys';
    div.textContent = text;
  } else {
    div.className = 'msg';
    const a = document.createElement('span');
    a.className = 'author';
    a.textContent = esc(author || '?') + ':';
    div.appendChild(a);

    if (typeof text === 'string' && text.startsWith('data:image/')) {
      const img = document.createElement('img');
      img.src = text;
      img.style.cssText = 'max-width:100%;border-radius:6px;margin-top:4px;display:block;border:1px solid rgba(255,255,255,0.1);box-shadow:0 4px 12px rgba(0,0,0,0.3);';
      div.appendChild(img);
    } else {
      const t = document.createElement('span');
      t.textContent = ' ' + text;
      div.appendChild(t);
    }
  }

  box.appendChild(div);

  while (box.children.length > MAX_CHAT_MSGS) {
    const removed = box.firstChild;
    const removedH = removed.offsetHeight || 0;
    box.removeChild(removed);
    if (!isNearBottom) box.scrollTop = Math.max(0, box.scrollTop - removedH);
  }

  if (isNearBottom) {
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
}

// ── Other helpers ─────────────────────────────────────────────────

function bumpUnread() {
  unreadCount++;
  const badge = document.getElementById('chat-badge');
  badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
  badge.classList.remove('hidden');
}

function setConnected(ok) {
  document.getElementById('conn-dot').className = 'status-dot' + (ok ? '' : ' red');
  document.getElementById('conn-label').textContent = ok ? 'Connected' : 'Disconnected';
}

function showSyncFlash() {
  const el = document.createElement('span');
  el.className = 'sync-flash';
  el.textContent = '✓ Synced';
  document.getElementById('bar').appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function showCopyToast() {
  const t = document.getElementById('copy-toast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}