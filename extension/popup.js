// SyncWatch Popup v2
'use strict';

const API = 'https://syncwatch-o4za.onrender.com';

let activeRoomId = null;

const $ = id => document.getElementById(id);

// ── Tab validation ────────────────────────────────────────
function isInjectableUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

async function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      resolve(tabs?.[0] || null);
    });
  });
}

// ── Flash messages ────────────────────────────────────────
function flash(msg, type = '') {
  const f = $('flash');
  f.textContent = msg;
  f.className = 'flash ' + type;
  clearTimeout(f._t);
  f._t = setTimeout(() => { f.textContent = ''; f.className = 'flash'; }, 4000);
}

// ── View switching ────────────────────────────────────────
function showView(name) {
  $('view-idle').classList.toggle('hidden', name !== 'idle');
  $('view-connected').classList.toggle('hidden', name !== 'connected');
}

function enterConnected(roomId) {
  activeRoomId = roomId;
  $('room-code').textContent = roomId;
  showView('connected');
  chrome.storage.local.set({ sw_room: roomId });
  startStatusPoll();
}

function enterIdle() {
  activeRoomId = null;
  stopStatusPoll();
  showView('idle');
  chrome.storage.local.remove('sw_room');
}

// ── Message relay to background (which now handles JOIN/LEAVE) ──
function relayToBackground(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from background'));
      if (!res.ok) return reject(new Error(res.hint || res.error || 'Unknown error'));
      resolve(res.data);
    });
  });
}

// ── Pre-flight tab check ──────────────────────────────────
async function checkTabReady() {
  const tab = await getActiveTab();
  if (!tab) {
    flash('No active tab found. Open a browser tab first.', 'err');
    return null;
  }
  if (!isInjectableUrl(tab.url)) {
    let pageName = tab.url || 'this page';
    if (!tab.url || tab.url.startsWith('chrome://')) pageName = 'Chrome system page';
    else if (tab.url.startsWith('chrome-extension://')) pageName = 'Extension page';
    else if (tab.url === 'about:blank' || tab.url === 'about:newtab') pageName = 'New Tab';
    flash(`⚠ Go to a webpage with a video first!\n(${pageName} cannot run scripts)`, 'err');
    setTabWarning(true, pageName);
    return null;
  }

  // Strict check requested by user
  const lowUrl = tab.url.toLowerCase();
  if (!lowUrl.includes("youtube.com") && !lowUrl.includes("video") && !lowUrl.includes("watch") && !lowUrl.includes("vimeo")) {
    flash("⚠ Open a video page first (e.g. YouTube)", "err");
    return null;
  }

  setTabWarning(false);
  return tab;
}

function setTabWarning(show, pageName = '') {
  const warn = $('tab-warning');
  if (!warn) return;
  if (show) {
    warn.textContent = `⚠ Navigate to a video page first (currently on: ${pageName})`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}

// ── Server health ─────────────────────────────────────────
async function checkServer() {
  try {
    const r = await fetch(`${API}/`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { $('server-dot').className = 'server-dot online'; return true; }
  } catch {}
  $('server-dot').className = 'server-dot offline';
  return false;
}

// ── Create Room ───────────────────────────────────────────
$('btn-create').addEventListener('click', async () => {
  const tab = await checkTabReady();
  if (!tab) return;

  const btn = $('btn-create');
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    const serverOk = await checkServer();
    if (!serverOk) { flash('Backend offline! Check server.', 'err'); return; }

    const res  = await fetch(`${API}/room/create`, { method: 'POST' });
    const data = await res.json();

    // Background now handles the WebSocket connection directly
    await relayToBackground({ type: 'JOIN_ROOM', roomId: data.roomId });
    enterConnected(data.roomId);
    flash('Room created! Share the ID 🎉', 'ok');
  } catch (e) {
    flash('Error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create New Room';
  }
});

// ── Join Room ─────────────────────────────────────────────
$('btn-join').addEventListener('click', joinRoom);
$('inp-room').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('inp-room').addEventListener('input', function () {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

async function joinRoom() {
  const tab = await checkTabReady();
  if (!tab) return;

  const roomId = $('inp-room').value.trim().toUpperCase();
  if (roomId.length < 4) { flash('Enter a valid Room ID', 'err'); return; }

  const btn = $('btn-join');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const serverOk = await checkServer();
    if (!serverOk) { flash('Backend offline! Check server.', 'err'); return; }

    const r = await fetch(`${API}/room/${roomId}`);
    const { exists } = await r.json();
    if (!exists) { flash('Room not found', 'err'); return; }

    await relayToBackground({ type: 'JOIN_ROOM', roomId });
    enterConnected(roomId);
    flash('Joined successfully! 🎬', 'ok');
  } catch (e) {
    flash('Error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Join';
  }
}

// ── Leave Room ────────────────────────────────────────────
$('btn-leave').addEventListener('click', async () => {
  try { await relayToBackground({ type: 'LEAVE_ROOM' }); } catch {}
  enterIdle();
  flash('Left room');
});

// ── Copy Room ID ──────────────────────────────────────────
$('btn-copy').addEventListener('click', () => {
  if (!activeRoomId) return;
  navigator.clipboard.writeText(activeRoomId)
    .then(() => flash('Room ID copied!', 'ok'))
    .catch(() => flash('Could not copy', 'err'));
});

// ── Share Invite ──────────────────────────────────────────
$('btn-share').addEventListener('click', () => {
  if (!activeRoomId) return;
  const webLink = `https://syncwatch-o4za.onrender.com/join/${activeRoomId}`;
  const message = `SyncWatch - Let's watch together!\n\nJoin my room:\n${webLink}\n\n(No extension required for guests)`;

  navigator.clipboard.writeText(message)
    .then(() => {
      const btn = $('btn-share');
      const orig = btn.innerHTML;
      btn.textContent = 'Invite Link Copied';
      btn.style.color = '#4ade80';
      btn.style.borderColor = '#4ade80';
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = btn.style.borderColor = ''; }, 2500);
      flash('Full invite copied to clipboard!', 'ok');
    })
    .catch(() => flash('Could not copy invite', 'err'));
});

// ── Status poll (video detection via background state) ─────
let pollTimer = null;

function startStatusPoll() {
  stopStatusPoll();
  pollStatus();
  pollTimer = setInterval(pollStatus, 2500);
}

function stopStatusPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollStatus() {
  try {
    const status = await relayToBackground({ type: 'GET_STATUS' });
    if (!status) return;

    const vDot   = document.querySelector('.video-dot');
    const vLabel = $('video-label');

    if (status.hasVideo) {
      if (vDot)   vDot.style.background = '#7c9fff';
      if (vLabel) vLabel.textContent = 'Video detected ✓';
    } else {
      if (vDot)   vDot.style.background = '#334155';
      if (vLabel) vLabel.textContent = 'Searching for video…';
    }

    // Show sharing indicator
    if (status.isSharing) {
      if (vLabel) vLabel.textContent = 'Active: Sharing Screen';
    }
  } catch {}
}

// ── Init ──────────────────────────────────────────────────
(async function init() {
  checkServer();

  const tab = await getActiveTab();
  if (tab && !isInjectableUrl(tab.url)) {
    let pageName = 'Chrome system page';
    if (tab.url === 'about:blank' || !tab.url) pageName = 'Empty / New Tab';
    else if (tab.url.startsWith('chrome-extension://')) pageName = 'Extension page';
    setTabWarning(true, pageName);
  }

  // Try to restore background connection state
  try {
    const status = await relayToBackground({ type: 'GET_STATUS' });
    if (status?.connected && status?.roomId) {
      enterConnected(status.roomId);
      return;
    }
  } catch {}

  // Pre-fill last room ID from storage
  try {
    const { sw_room } = await chrome.storage.local.get('sw_room');
    if (sw_room) $('inp-room').value = sw_room;
  } catch {}
})();
