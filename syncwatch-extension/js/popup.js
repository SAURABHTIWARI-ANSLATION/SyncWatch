'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SyncWatch — Popup Controller
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND = 'https://syncwatch-64jv.onrender.com';

// ── Persistent user identity ──────────────────────────────────────────────────

const persistentUserId = (() => {
  let id = localStorage.getItem('sw_uid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('sw_uid', id); }
  return id;
})();

// ── Runtime state ─────────────────────────────────────────────────────────────

let currentTabId    = null;
let currentRoomId   = null;
let myDisplayName   = null;           // server-assigned (e.g. "Host", "Guest-ABCD")
const seenMsgIds    = new Set();      // dedup chat messages

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const stripDisc   = $('strip-disconnected');
const stripErr    = $('strip-error');
const roomBanner  = $('room-banner');
const bannerCode  = $('banner-code');
const bannerCount = $('banner-count');
const roomChat    = $('room-chat');
const chatLog     = $('chat-log');
const chatInput   = $('chat-input');
const mainEl      = $('main');
const formError   = $('form-error');
const inviteBox   = $('invite-box');
const inviteLink  = $('invite-link');

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  currentTabId = tab.id;

  $('page-title').textContent = tab.title || tab.url || 'Unknown page';
  if (tab.favIconUrl) $('page-icon').src = tab.favIconUrl;

  // Restore UI if already in a room
  chrome.runtime.sendMessage({ action: 'getStatus', tabId: currentTabId }, resp => {
    if (resp?.room && resp.connected) {
      myDisplayName = resp.room.userId || null;
      enterRoomUI(resp.room.roomId, resp.room.memberCount);
    }
  });
});

// ── Background message handling ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
  if (!msg.sw) return;

  switch (msg.sw) {

    case 'joined':
      myDisplayName = msg.userId || null;
      hideDisconnected();
      clearErr();
      enterRoomUI(msg.roomId, msg.memberCount);
      stopLoading('btn-create');
      stopLoading('btn-join');
      break;

    case 'left':
      exitRoomUI();
      hideDisconnected();
      break;

    case 'disconnected':
      showDisconnected(msg.msg);
      break;

    case 'error':
      showErr(friendlyError(msg.msg));
      stopLoading('btn-create');
      stopLoading('btn-join');
      break;

    case 'usersList':
      if (currentRoomId) bannerCount.textContent = msg.memberCount || (msg.list?.length ?? 1);
      break;

    case 'user_joined':
    case 'user_left':
      if (currentRoomId) bannerCount.textContent = msg.memberCount;
      break;

    case 'chatHistory':
      (msg.messages || []).forEach(m => renderChatMsg(m.user, m.text, m.timestamp, m.id, m.type));
      break;

    case 'chatMessage':
      // Skip echo of own messages — already shown optimistically
      if (myDisplayName && msg.user === myDisplayName) {
        seenMsgIds.add(msg.id);
        break;
      }
      renderChatMsg(msg.user, msg.text, msg.timestamp, msg.id, msg.type);
      break;

    case 'chat': // legacy fallback
      renderChatMsg(msg.userId, msg.text);
      break;
  }
});

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
    tab.classList.add('on');
    $('panel-' + tab.dataset.tab)?.classList.add('on');
    clearFormErr();
  });
});

// ── Create Room ───────────────────────────────────────────────────────────────

$('btn-create').addEventListener('click', () => {
  clearFormErr();
  clearErr();
  startLoading('btn-create', 'Creating…');

  chrome.runtime.sendMessage({ action: 'createRoom', tabId: currentTabId, userId: persistentUserId }, resp => {
    if (resp?.ok) {
      currentRoomId = resp.roomId;
      showInvite(resp.roomId);
      // Auto-share for host (best-effort)
      chrome.tabs.sendMessage(currentTabId, { action: 'autoStartShare' }).catch(() => {});
      // enterRoomUI fires when 'joined' arrives from background
    } else {
      stopLoading('btn-create');
      showFormErr(resp?.error || 'Failed to create room. Is the server running?');
    }
  });
});

// ── Join Room ─────────────────────────────────────────────────────────────────

$('btn-join').addEventListener('click', () => {
  const code = $('inp-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) { showFormErr('Enter a valid room code.'); return; }

  clearFormErr();
  clearErr();
  startLoading('btn-join', 'Joining…');

  chrome.runtime.sendMessage({ action: 'joinRoom', tabId: currentTabId, roomId: code, userId: persistentUserId }, resp => {
    if (resp?.ok) {
      currentRoomId = resp.roomId;
      // enterRoomUI fires when 'joined' arrives
    } else {
      stopLoading('btn-join');
      showFormErr(resp?.error || 'Could not join room.');
    }
  });
});

$('inp-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ── Leave Room ────────────────────────────────────────────────────────────────

$('btn-leave').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'leaveRoom', tabId: currentTabId }, () => {
    exitRoomUI();
    clearErr();
  });
});

// ── Copy invite (banner code click) ───────────────────────────────────────────

bannerCode.addEventListener('click', () => {
  if (!currentRoomId) return;
  copy(`${BACKEND}/join/${currentRoomId}`);
  const orig = bannerCode.textContent;
  bannerCode.textContent = '✓ Copied!';
  bannerCode.style.color = 'var(--green)';
  setTimeout(() => { bannerCode.textContent = orig; bannerCode.style.color = ''; }, 1800);
});

$('btn-copy-invite').addEventListener('click', () => {
  if (!currentRoomId) return;
  copy(`${BACKEND}/join/${currentRoomId}`);
  const b = $('btn-copy-invite');
  b.textContent = '✓ Copied!';
  setTimeout(() => { b.textContent = '📋 Copy Invite'; }, 2000);
});

$('btn-copy-link').addEventListener('click', () => {
  if (!currentRoomId) return;
  copy(`${BACKEND}/join/${currentRoomId}`);
  const b = $('btn-copy-link');
  b.textContent = '✓ Copied!';
  setTimeout(() => { b.textContent = '📋 Copy Link'; }, 2000);
});

$('btn-open-link').addEventListener('click', () => {
  if (!currentRoomId) return;
  chrome.tabs.create({ url: `${BACKEND}/join/${currentRoomId}` });
});

// ── Chat ──────────────────────────────────────────────────────────────────────

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || text.length > 500) return;

  // Optimistic render
  renderChatMsg(myDisplayName || 'You', text, Date.now(), `opt_${Date.now()}_${Math.random()}`);
  chatInput.value = '';

  chrome.runtime.sendMessage({ action: 'sendChat', tabId: currentTabId, text });
}

$('btn-chat-send').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function renderChatMsg(author, text, timestamp, msgId, type) {
  if (msgId && seenMsgIds.has(msgId)) return;
  if (msgId) seenMsgIds.add(msgId);

  const isBot     = (type === 'system') || !author;
  const nearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60;
  const div        = document.createElement('div');

  if (isBot) {
    div.className   = 'cm sys';
    div.textContent = text;
  } else {
    div.className = 'cm';
    const a = document.createElement('span');
    a.className   = 'ca';
    a.textContent = author + ':';
    const t = document.createElement('span');
    t.textContent = ' ' + text;
    div.append(a, t);
    if (timestamp) {
      const ts = document.createElement('span');
      ts.className   = 'ct';
      ts.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      div.append(ts);
    }
  }

  chatLog.appendChild(div);
  if (nearBottom) requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; });
}

// ── Room UI transitions ───────────────────────────────────────────────────────

function enterRoomUI(roomId, memberCount) {
  currentRoomId = roomId;
  bannerCode.textContent  = roomId;
  bannerCount.textContent = memberCount || 1;
  roomBanner.classList.add('on');
  roomChat.classList.add('on');
  mainEl.classList.add('hidden');
}

function exitRoomUI() {
  roomBanner.classList.remove('on');
  roomChat.classList.remove('on');
  mainEl.classList.remove('hidden');
  inviteBox.classList.remove('on');
  // Reset chat
  chatLog.innerHTML = '<div class="cm sys">Welcome to SyncWatch Chat 👋</div>';
  seenMsgIds.clear();
  myDisplayName = null;
  currentRoomId = null;
  stopLoading('btn-create');
  stopLoading('btn-join');
}

function showInvite(roomId) {
  const link = `${BACKEND}/join/${roomId}`;
  inviteLink.textContent = link;
  inviteBox.classList.add('on');
}

// ── Status strips ─────────────────────────────────────────────────────────────

function showDisconnected(msg) {
  stripDisc.textContent = '⚡ ' + (msg || 'Reconnecting…');
  stripDisc.classList.add('on');
}
function hideDisconnected() { stripDisc.classList.remove('on'); }

function showErr(msg)  { stripErr.textContent = msg; stripErr.classList.add('on'); }
function clearErr()    { stripErr.textContent = ''; stripErr.classList.remove('on'); }
function showFormErr(msg) { formError.textContent = msg; }
function clearFormErr()   { formError.textContent = ''; }

// ── Loading states ────────────────────────────────────────────────────────────

function startLoading(id, label) {
  const btn = $(id);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${label}`;
}

function stopLoading(id) {
  const btn = $(id);
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = id === 'btn-create' ? 'Create Room' : 'Join Room';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function copy(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}

function friendlyError(code) {
  return {
    socket_error_rate_limit:       'Slow down — too many messages.',
    socket_error_message_invalid:  'Message is empty or too long (max 500 chars).',
    socket_error_not_in_room:      'Not currently in a room.'
  }[code] || code || 'An error occurred.';
}
