// SyncWatch Controls Overlay — controls.js  (FIXED v1.2)
'use strict';

const BACKEND = 'https://syncwatch-64jv.onrender.com';

let chatOpen = false;
let unreadCount = 0;
let isSharing = false;
let myRoomId = null;

// ── Listen for messages FROM content script ───────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'joined':
      myRoomId = msg.roomId;
      document.getElementById('room-id-lbl').textContent = msg.roomId || '--------';
      document.getElementById('member-count').textContent = msg.memberCount || 1;
      setConnected(true);
      addMsg('sys', `Joined room ${msg.roomId} as ${msg.userId}`);
      break;

    case 'play':
      addMsg('sys', '▶ Remote: Play');
      break;

    case 'pause':
      addMsg('sys', '⏸ Remote: Pause');
      break;

    case 'chat':
      addMsg('user', msg.text, msg.userId);
      if (!chatOpen) bumpUnread();
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

document.getElementById('btn-share').addEventListener('click', () => {
  if (isSharing) {
    window.parent.postMessage({ swOverlay: 'stopShare' }, '*');
  } else {
    window.parent.postMessage({ swOverlay: 'shareScreen' }, '*');
    addMsg('sys', 'Starting screen share...');
  }
});

document.getElementById('btn-leave').addEventListener('click', () => {
  if (confirm('Leave this SyncWatch room?')) {
    window.parent.postMessage({ swOverlay: 'leave' }, '*');
  }
});

// Chat toggle
document.getElementById('btn-chat').addEventListener('click', () => {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('open', chatOpen);
  if (chatOpen) {
    unreadCount = 0;
    document.getElementById('chat-badge').textContent = '0';
    document.getElementById('chat-badge').classList.add('hidden');
    document.getElementById('chat-input').focus();
    // Scroll to bottom when opening
    const box = document.getElementById('chat-msgs');
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
});

// Chat send
document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

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

// ── Chat message helper ───────────────────────────────────────────
// FIX v1.2: stable scroll — don't hijack when user is reading history,
//           compensate scroll when trimming old messages from top.

const MAX_CHAT_MSGS = 150;

function addMsg(type, text, author) {
  const box = document.getElementById('chat-msgs');

  // Snapshot scroll position BEFORE adding
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
    const t = document.createElement('span');
    t.textContent = ' ' + text;
    div.appendChild(a);
    div.appendChild(t);
  }

  box.appendChild(div);

  // Trim oldest messages, preserving scroll position for users reading history
  while (box.children.length > MAX_CHAT_MSGS) {
    const removed = box.firstChild;
    const removedH = removed.offsetHeight || 0;
    box.removeChild(removed);
    if (!isNearBottom) {
      box.scrollTop = Math.max(0, box.scrollTop - removedH);
    }
  }

  // Auto-scroll only if user was already at (or near) the bottom
  if (isNearBottom) {
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  } else if (!chatOpen) {
    // Panel closed and unread — bump badge
    // (badge already bumped for type=user in the caller; skip double bump)
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
  return String(str).replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}