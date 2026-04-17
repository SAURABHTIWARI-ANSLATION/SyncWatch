// SyncWatch Popup — popup.js
'use strict';

const BACKEND = 'https://syncwatch-64jv.onrender.com';

let currentTabId   = null;
let currentTabUrl  = null;
let currentRoomId  = null;
let persistentUserId = localStorage.getItem('sw_userid') || (()=>{
  const id = crypto.randomUUID();
  localStorage.setItem('sw_userid', id);
  return id;
})();

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
      showChatTab();
    }
  });
});

let unreadCount = 0;
let chatTabActive = false;

// Listen for updates from background while popup is open
chrome.runtime.onMessage.addListener(msg => {
  if (!msg.sw) return;
  switch (msg.sw) {
    case 'joined':
      if (msg.tabId === currentTabId) {
        showRoomBanner(msg.roomId, msg.memberCount);
        showChatTab();
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
    case 'chat':
      if (msg.tabId === currentTabId) {
        addChatMessage(msg.userId, msg.text);
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
    const panel = document.getElementById(panelId);
    if(panel) panel.classList.add('active');
    
    if (tab.dataset.tab === 'chat') {
      chatTabActive = true;
      unreadCount = 0;
      updateChatBadge();
      const box = document.getElementById('chat-msgs');
      setTimeout(() => { box.scrollTop = box.scrollHeight; }, 10);
    } else {
      chatTabActive = false;
    }
    clearError();
  });
});

// ── Chat sending ──────────────────────────────────────────────────
function sendChat() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text) return;

  chrome.runtime.sendMessage({ action: 'sendChat', tabId: currentTabId, text }, () => {
    addChatMessage('You', text);
    inp.value = '';
  });
}

document.getElementById('btn-send-chat').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

function addChatMessage(author, text) {
  const box = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = author === 'System' ? 'msg msg-sys' : 'msg';
  
  if (author !== 'System') {
    const a = document.createElement('span');
    a.className = 'msg-author';
    a.textContent = author + ':';
    div.appendChild(a);
  }
  
  const t = document.createElement('span');
  t.textContent = text;
  div.appendChild(t);
  
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  if (!chatTabActive && author !== 'You' && author !== 'System') {
    unreadCount++;
    updateChatBadge();
  }
}

function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function showChatTab() {
  document.getElementById('tab-chat').classList.remove('hidden');
}

// ── Create Room ───────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  clearError();
  setLoading(true, 'btn-create', 'Creating...');

  chrome.runtime.sendMessage({ action: 'createRoom', tabId: currentTabId, userId: persistentUserId }, resp => {
    if (resp.ok) {
      currentRoomId = resp.roomId;
      showInviteBox(resp.roomId);
      showChatTab();
      // Auto-trigger screen share prompt for the host if they stay in extension
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

  chrome.runtime.sendMessage({ action: 'joinRoom', tabId: currentTabId, roomId, userId: persistentUserId }, resp => {
    if (resp.ok) {
      currentRoomId = resp.roomId;
      showChatTab();
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
    document.getElementById('tab-chat').classList.add('hidden');
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

