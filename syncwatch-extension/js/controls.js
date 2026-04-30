'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SyncWatch — Controls Overlay (inside iframe, communicates via postMessage)
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND = 'https://syncwatch-64jv.onrender.com';

// ── State ─────────────────────────────────────────────────────────────────────

let roomId         = null;
let myUserId       = null;
let amHost         = false;
let hostOnlyOn     = false;
let sharing        = false;
let micOn          = false;
let chatOpen       = false;
let unread         = 0;
let memberCount    = 1;

// Dedup: track rendered message IDs to prevent double-render of own echoes
const seenIds = new Set();

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ── Message handling — FROM content script ────────────────────────────────────

window.addEventListener('message', ({ data: msg }) => {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {

    case 'joined':
      roomId      = msg.roomId;
      myUserId    = msg.userId;
      amHost      = msg.isHost || false;
      memberCount = msg.memberCount || 1;

      $('room-id').textContent      = msg.roomId;
      $('member-count').textContent = memberCount;
      updateChatCount(memberCount);
      setConn(true);
      appendMsg('sys', `Joined ${msg.roomId} as ${msg.userId}${amHost ? ' 👑' : ''}`);

      if (amHost) $('btn-host').style.display = 'flex';
      break;

    case 'usersList':
      memberCount = msg.memberCount || msg.list?.length || 1;
      $('member-count').textContent = memberCount;
      updateChatCount(memberCount);
      break;

    case 'user_joined':
      memberCount = msg.memberCount;
      $('member-count').textContent = memberCount;
      updateChatCount(memberCount);
      appendMsg('sys', `${msg.userId} joined`);
      break;

    case 'user_left':
      memberCount = msg.memberCount;
      $('member-count').textContent = memberCount;
      updateChatCount(memberCount);
      appendMsg('sys', `${msg.userId} left`);
      break;

    // GRAPHIFY rich format: { id, user, text, timestamp, msgType }
    case 'chatMessage': {
      const isSystem = msg.msgType === 'system' || !msg.user;
      if (isSystem) {
        appendMsg('sys', msg.text, null, msg.timestamp, msg.id);
      } else if (msg.user === myUserId) {
        // Own echo — already shown optimistically; just mark seen
        seenIds.add(msg.id);
      } else {
        appendMsg('user', msg.text, msg.user, msg.timestamp, msg.id);
        if (!chatOpen) bumpUnread();
      }
      break;
    }

    case 'chatHistory':
      (msg.messages || []).forEach(m => {
        if (m.type === 'system' || !m.user) appendMsg('sys',  m.text, null,   m.timestamp, m.id);
        else                                 appendMsg('user', m.text, m.user, m.timestamp, m.id);
      });
      break;

    // Legacy fallback
    case 'chat':
      if (msg.userId === myUserId) break;
      if (msg.userId === 'System') appendMsg('sys',  msg.text);
      else                         appendMsg('user', msg.text, msg.userId);
      if (!chatOpen) bumpUnread();
      break;

    case 'play':  appendMsg('sys', '▶ Play'); break;
    case 'pause': appendMsg('sys', '⏸ Pause'); break;
    case 'seek':  /* silent */ break;

    case 'screenShareStarted':
      sharing = true;
      $('btn-share').textContent = '🔴 Stop';
      $('btn-share').classList.add('on');
      appendMsg('sys', '📡 Screen share started');
      break;

    case 'screenShareStopped':
      sharing = false;
      $('btn-share').textContent = '📡 Share';
      $('btn-share').classList.remove('on');
      appendMsg('sys', 'Screen share ended');
      break;

    case 'screenShareError':
      appendMsg('sys', `⚠ Share error: ${msg.msg}`);
      break;

    case 'streamEnded':
      appendMsg('sys', 'Stream ended');
      break;

    case 'hostOnlyMode': {
      hostOnlyOn = msg.state;
      $('host-banner').classList.toggle('on', hostOnlyOn);
      const hb = $('btn-host');
      hb.classList.toggle('on', hostOnlyOn);
      hb.title = hostOnlyOn ? 'Host-Only ON — click to disable' : 'Toggle Host-Only';
      appendMsg('sys', hostOnlyOn ? '🔒 Host-only enabled' : '🔓 Host-only disabled');
      break;
    }

    case 'error':
      setConn(false);
      appendMsg('sys', `⚠ ${msg.msg}`);
      break;

    case 'timeUpdate':
    case 'duration':
      break;
  }
});

// ── Playback buttons ──────────────────────────────────────────────────────────

$('btn-play').onclick  = () => parent.postMessage({ swOverlay: 'play' }, '*');
$('btn-pause').onclick = () => parent.postMessage({ swOverlay: 'pause' }, '*');
$('btn-sync').onclick  = () => {
  parent.postMessage({ swOverlay: 'syncNow' }, '*');
  appendMsg('sys', '⟳ Sync requested…');
  showFlash();
};

// ── Screen share ──────────────────────────────────────────────────────────────

$('btn-share').onclick = () => {
  if (sharing) {
    parent.postMessage({ swOverlay: 'stopShare' }, '*');
  } else {
    const q = $('quality').value;
    parent.postMessage({ swOverlay: 'shareScreen', quality: q }, '*');
    appendMsg('sys', `Starting share (${q})…`);
  }
};

// ── Host-only ─────────────────────────────────────────────────────────────────

$('btn-host').onclick = () => {
  if (!amHost) return;
  hostOnlyOn = !hostOnlyOn;
  parent.postMessage({ swOverlay: 'hostOnlyToggle', state: hostOnlyOn }, '*');
};

// ── Leave ─────────────────────────────────────────────────────────────────────

$('btn-leave').onclick = () => {
  if (confirm('Leave SyncWatch room?')) parent.postMessage({ swOverlay: 'leave' }, '*');
};

// ── Mic ───────────────────────────────────────────────────────────────────────

$('btn-mic').onclick = () => {
  micOn = !micOn;
  $('btn-mic').style.color = micOn ? 'var(--green)' : 'var(--muted)';
  parent.postMessage({ swOverlay: 'toggleMic', state: micOn }, '*');
  appendMsg('sys', micOn ? '🎤 Mic on' : '🎤 Mic off');
};

// ── Chat toggle ───────────────────────────────────────────────────────────────

$('btn-chat').onclick = () => {
  chatOpen = !chatOpen;
  $('chat').classList.toggle('on', chatOpen);
  parent.postMessage({ swOverlay: 'toggleChatPanel', open: chatOpen }, '*');
  if (chatOpen) {
    unread = 0;
    $('badge').textContent = '0';
    $('badge').classList.add('hidden');
    $('chat-input').focus();
    requestAnimationFrame(() => { $('chat-log').scrollTop = $('chat-log').scrollHeight; });
  }
};

// ── Chat send ─────────────────────────────────────────────────────────────────

$('btn-send').onclick = sendChat;
$('chat-input').onkeydown = e => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
  const input = $('chat-input');
  const text  = input.value.trim();
  if (!text || text.length > 500) return;

  // Optimistic render with a temp id that won't collide with server ids
  const tempId = `opt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  appendMsg('user', text, 'You', Date.now(), tempId);
  parent.postMessage({ swOverlay: 'chat', text }, '*');
  input.value = '';
}

// ── Room ID click → copy invite ───────────────────────────────────────────────

$('room-id').onclick = () => {
  if (!roomId) return;
  navigator.clipboard.writeText(`${BACKEND}/join/${roomId}`)
    .then(showToast)
    .catch(() => prompt('Copy invite link:', `${BACKEND}/join/${roomId}`));
};

// ── Signal ready ──────────────────────────────────────────────────────────────

parent.postMessage({ swOverlay: 'ready' }, '*');

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_MSGS = 150;

function appendMsg(type, text, author, timestamp, msgId) {
  if (msgId && seenIds.has(msgId)) return;
  if (msgId) seenIds.add(msgId);

  const log = $('chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const div = document.createElement('div');

  if (type === 'sys') {
    div.className   = 'cm sys';
    div.textContent = text;
  } else {
    div.className = 'cm';
    const a = Object.assign(document.createElement('span'), { className: 'ca', textContent: esc(author || '?') + ':' });
    const t = Object.assign(document.createElement('span'), { textContent: ' ' + text });
    div.append(a, t);
    if (timestamp) {
      const ts = Object.assign(document.createElement('span'), {
        className:   'ct',
        textContent: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
      div.append(ts);
    }
  }

  log.appendChild(div);

  // Cap message count
  while (log.children.length > MAX_MSGS) {
    const h = log.firstChild.offsetHeight || 0;
    log.removeChild(log.firstChild);
    if (!nearBottom) log.scrollTop = Math.max(0, log.scrollTop - h);
  }

  if (nearBottom) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function updateChatCount(n) {
  const el = $('chat-count');
  if (el) el.textContent = `${n} watching`;
}

function bumpUnread() {
  unread++;
  const b = $('badge');
  b.textContent = unread > 9 ? '9+' : String(unread);
  b.classList.remove('hidden');
}

function setConn(ok) {
  $('sdot').className  = 'sdot' + (ok ? '' : ' off');
  $('slabel').textContent = ok ? 'Connected' : 'Disconnected';
}

function showFlash() {
  const el = Object.assign(document.createElement('span'), { className: 'flash', textContent: '✓ Synced' });
  $('bar').appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function showToast() {
  const t = $('toast');
  t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2000);
}

function esc(str) {
  return String(str || '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}