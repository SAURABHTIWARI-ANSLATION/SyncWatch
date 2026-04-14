// SyncWatch Popup — popup.js
'use strict';

const BACKEND = 'https://syncwatch-64jv.onrender.com';

let currentTabId   = null;
let currentTabUrl  = null;
let currentRoomId  = null;

// ── Init: get current tab info ────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  if (!tabs[0]) return;
  const tab = tabs[0];
  currentTabId  = tab.id;
  currentTabUrl = tab.url || '';

  // Show current page info
  document.getElementById('page-title').textContent = tab.title || tab.url || 'Unknown page';
  const favicon = document.getElementById('page-favicon');
  if (tab.favIconUrl) favicon.src = tab.favIconUrl;

  // Check if already in a room
  chrome.runtime.sendMessage({ action: 'getStatus', tabId: currentTabId }, resp => {
    if (resp && resp.room && resp.connected) {
      showRoomBanner(resp.room.roomId, resp.room.memberCount);
    }
  });
});

// Listen for updates from background while popup is open
chrome.runtime.onMessage.addListener(msg => {
  if (!msg.sw) return;
  switch (msg.sw) {
    case 'joined':
      if (msg.tabId === currentTabId) {
        showRoomBanner(msg.roomId, msg.memberCount);
        setLoading(false, 'btn-create');
        setLoading(false, 'btn-join');
      }
      break;
    case 'user_joined':
    case 'user_left':
      if (msg.tabId === currentTabId && currentRoomId) {
        document.getElementById('banner-members').textContent = msg.memberCount;
      }
      break;
    case 'error':
      if (msg.tabId === currentTabId) {
        showError(msg.msg);
        setLoading(false, 'btn-create');
        setLoading(false, 'btn-join');
      }
      break;
  }
});

// ── Tab switching ─────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panelId = 'panel-' + tab.dataset.tab;
    document.getElementById(panelId).classList.add('active');
    clearError();
  });
});

// ── Create Room ───────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  clearError();
  setLoading(true, 'btn-create', 'Creating...');

  chrome.runtime.sendMessage({ action: 'createRoom', tabId: currentTabId }, resp => {
    if (resp.ok) {
      currentRoomId = resp.roomId;
      showInviteBox(resp.roomId);
      // Auto-trigger screen share prompt for the host
      chrome.tabs.sendMessage(currentTabId, { action: 'autoStartShare' }).catch(() => {});
      // Banner will appear when 'joined' message arrives from background
    } else {
      setLoading(false, 'btn-create');
      showError(resp.error || 'Failed to create room. Is the server running?');
    }
  });
});

// ── Join Room ─────────────────────────────────────────────────────
document.getElementById('btn-join').addEventListener('click', () => {
  const roomId = document.getElementById('inp-room-id').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!roomId || roomId.length < 4) {
    showError('Please enter a valid Room Code.');
    return;
  }
  clearError();
  setLoading(true, 'btn-join', 'Joining...');

  chrome.runtime.sendMessage({ action: 'joinRoom', tabId: currentTabId, roomId }, resp => {
    if (resp.ok) {
      currentRoomId = resp.roomId;
      // Banner will appear on 'joined' message
    } else {
      setLoading(false, 'btn-join');
      showError(resp.error || 'Could not join room.');
    }
  });
});

// ── Room ID input — auto uppercase ───────────────────────────────
document.getElementById('inp-room-id').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ── Leave room ────────────────────────────────────────────────────
document.getElementById('btn-leave-room').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'leaveRoom', tabId: currentTabId }, () => {
    hideRoomBanner();
    currentRoomId = null;
    clearError();
  });
});

// ── Copy invite (from banner) ─────────────────────────────────────
document.getElementById('btn-copy-invite').addEventListener('click', () => {
  if (!currentRoomId) return;
  copyToClipboard(`${BACKEND}/join/${currentRoomId}`);
});

// ── Invite box actions ────────────────────────────────────────────
document.getElementById('btn-copy-link').addEventListener('click', () => {
  if (!currentRoomId) return;
  copyToClipboard(`${BACKEND}/join/${currentRoomId}`);
  document.getElementById('btn-copy-link').textContent = '✓ Copied!';
  setTimeout(() => document.getElementById('btn-copy-link').textContent = '📋 Copy Link', 2000);
});

document.getElementById('btn-open-link').addEventListener('click', () => {
  if (!currentRoomId) return;
  chrome.tabs.create({ url: `${BACKEND}/join/${currentRoomId}` });
});

// ── Helper functions ──────────────────────────────────────────────

function showRoomBanner(roomId, memberCount) {
  currentRoomId = roomId;
  document.getElementById('banner-room-id').textContent = roomId;
  document.getElementById('banner-members').textContent = memberCount || 1;
  document.getElementById('room-banner').classList.add('show');
  document.getElementById('main-content').classList.add('hidden');
}

function hideRoomBanner() {
  document.getElementById('room-banner').classList.remove('show');
  document.getElementById('main-content').classList.remove('hidden');
  document.getElementById('invite-box').classList.remove('show');
  setLoading(false, 'btn-create');
  setLoading(false, 'btn-join');
}

function showInviteBox(roomId) {
  const link = `${BACKEND}/join/${roomId}`;
  document.getElementById('invite-link-text').textContent = link;
  document.getElementById('invite-box').classList.add('show');
}

function setLoading(loading, btnId, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = `<span class="loader"></span>${label || 'Loading...'}`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btnId === 'btn-create' ? 'Create Room' : 'Join Room';
  }
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
}

function clearError() {
  document.getElementById('error-msg').textContent = '';
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}
