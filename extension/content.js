// SyncWatch Content Script v2
// Responsibilities: DOM overlay UI, video detection, sync apply.
// ALL networking is delegated to background.js via chrome.runtime.sendMessage.
// This script is safe to be destroyed and re-injected on navigation —
// it restores its state from chrome.storage.local on each load.
(function () {
  if (window.__syncwatch_loaded) return;
  window.__syncwatch_loaded = true;

  // ── State ─────────────────────────────────────────────────
  let video         = null;
  let isSyncing     = false;
  let overlayReady  = false;
  let chatOpen      = true;
  let currentUserId = null;
  let sharingActive = false;

  // ═══════════════════════════════════════════════════════════
  // VIDEO DETECTION & SYNC
  // ═══════════════════════════════════════════════════════════
  function findVideo() {
    return Array.from(document.querySelectorAll('video'))
      .filter(v => v.offsetWidth > 0 && v.offsetHeight > 0)
      .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0] || null;
  }

  const onPlay   = () => { if (!isSyncing) relay('CONTENT_PLAY',  { time: video.currentTime }); };
  const onPause  = () => { if (!isSyncing) relay('CONTENT_PAUSE', { time: video.currentTime }); };
  const onSeeked = () => { if (!isSyncing) relay('CONTENT_SEEK',  { time: video.currentTime }); };

  function attachVideo(v) {
    if (video === v) return;
    detachVideo();
    video = v;
    video.addEventListener('play',   onPlay);
    video.addEventListener('pause',  onPause);
    video.addEventListener('seeked', onSeeked);
    chrome.storage.local.set({ sw_has_video: true });
    setVideoChip('✓ Video attached');
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener('play',   onPlay);
    video.removeEventListener('pause',  onPause);
    video.removeEventListener('seeked', onSeeked);
    video = null;
  }

  function applySync(state) {
    if (!video || !state) return;
    isSyncing = true;
    const diff = Math.abs(video.currentTime - state.time);
    if (diff > 0.8) video.currentTime = state.time;
    if (state.playing && video.paused)   video.play().catch(() => {});
    else if (!state.playing && !video.paused) video.pause();
    setTimeout(() => { isSyncing = false; }, 700);
  }

  // ═══════════════════════════════════════════════════════════
  // BACKGROUND → CONTENT MESSAGES
  // ═══════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'ping':
        sendResponse({ alive: true });
        return false;

      case 'BG_SHOW_OVERLAY':
        showOverlay(msg.roomId);
        return false;

      case 'BG_JOINED':
        currentUserId = msg.userId;
        setDot('#4ade80');
        setStatus('Room: ' + msg.roomId);
        applySync(msg.state);
        return false;

      case 'BG_PLAY':
        if (msg.fromUserId !== currentUserId) applySync({ time: msg.time, playing: true });
        return false;

      case 'BG_PAUSE':
        if (msg.fromUserId !== currentUserId) applySync({ time: msg.time, playing: false });
        return false;

      case 'BG_SEEK':
        if (msg.fromUserId !== currentUserId && video) {
          isSyncing = true;
          video.currentTime = msg.time;
          setTimeout(() => { isSyncing = false; }, 700);
        }
        return false;

      case 'BG_SYNC':
        applySync(msg.state);
        return false;

      case 'BG_CHAT':
        addChat(msg.author, msg.text, false);
        return false;

      case 'BG_SHARE_STARTED':
        sharingActive = true;
        updateShareBtn();
        addChat('System', '📺 Screen sharing started — guests can see your screen');
        return false;

      case 'BG_SHARE_STOPPED':
        sharingActive = false;
        updateShareBtn();
        addChat('System', 'Screen sharing stopped');
        return false;

      case 'BG_STATUS':
        setDot(msg.connected ? '#4ade80' : '#ef4444');
        return false;

      case 'BG_LEFT_ROOM':
        setDot('#475569');
        setStatus('Idle');
        addChat('System', 'Left room');
        return false;

      case 'BG_ERROR':
        addChat('Error', msg.msg);
        setDot('#ef4444');
        return false;

      case 'BG_MEMBER_COUNT':
        // Could reflect in overlay title — optional enhancement
        return false;
    }
    return false;
  });

  // ═══════════════════════════════════════════════════════════
  // RELAY HELPER
  // ═══════════════════════════════════════════════════════════
  function relay(type, extra = {}) {
    chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════
  // OVERLAY UI
  // ═══════════════════════════════════════════════════════════
  function injectOverlay() {
    if (overlayReady) return;
    overlayReady = true;

    const style = document.createElement('style');
    style.textContent = `
      #_sw_root {
        position:fixed; bottom:24px; right:24px; width:280px;
        z-index:2147483647;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:13px; color:#e2e8f0;
      }
      #_sw_root * { box-sizing:border-box; margin:0; padding:0; }
      #_sw_panel {
        background:rgba(8,11,20,0.97);
        border:1px solid rgba(255,255,255,0.1);
        border-radius:14px; overflow:hidden;
        box-shadow:0 16px 48px rgba(0,0,0,0.7), 0 0 0 .5px rgba(255,255,255,.04) inset;
      }
      #_sw_titlebar {
        display:flex; align-items:center; gap:7px;
        padding:9px 11px; cursor:move;
        border-bottom:1px solid rgba(255,255,255,0.07); user-select:none;
      }
      #_sw_dot { width:8px; height:8px; border-radius:50%; background:#475569; flex-shrink:0; transition:background .4s; }
      #_sw_brand { font-size:10px; font-weight:800; letter-spacing:1.5px; color:#fff; text-transform:uppercase; flex-shrink:0; }
      #_sw_status { flex:1; font-size:10px; color:#64748b; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      ._sw_tbtn {
        background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.08);
        color:#94a3b8; cursor:pointer; padding:3px 8px; border-radius:6px;
        font-size:11px; line-height:1.5; flex-shrink:0; transition:background .2s;
      }
      ._sw_tbtn:hover { background:rgba(255,255,255,.13); color:#e2e8f0; }
      ._sw_tbtn.active { background:rgba(248,113,113,.15); border-color:rgba(248,113,113,.3); color:#f87171; }
      #_sw_body { display:flex; flex-direction:column; }
      #_sw_msgs {
        height:160px; overflow-y:auto; padding:8px 10px;
        display:flex; flex-direction:column; gap:3px;
        scrollbar-width:thin; scrollbar-color:#1e293b transparent;
      }
      #_sw_msgs::-webkit-scrollbar { width:3px; }
      #_sw_msgs::-webkit-scrollbar-thumb { background:#1e293b; border-radius:2px; }
      ._sw_msg { font-size:11.5px; line-height:1.5; word-break:break-word; }
      ._sw_msg_system { color:#475569; font-style:italic; }
      ._sw_msg_sync   { color:#334155; }
      ._sw_msg_user span.author { color:#7c9fff; font-weight:600; margin-right:4px; }
      ._sw_msg_user span.text   { color:#cbd5e1; }
      #_sw_inputrow {
        display:flex; gap:6px; padding:7px 9px;
        border-top:1px solid rgba(255,255,255,.07);
      }
      #_sw_input {
        flex:1; background:rgba(255,255,255,.05);
        border:1px solid rgba(255,255,255,.09); border-radius:8px;
        padding:6px 9px; color:#e2e8f0; font-size:11.5px; outline:none;
        transition:border-color .2s;
      }
      #_sw_input:focus { border-color:rgba(124,159,255,.5); }
      #_sw_input::placeholder { color:#334155; }
      #_sw_sendbtn {
        background:rgba(124,159,255,.15); border:1px solid rgba(124,159,255,.2);
        color:#7c9fff; cursor:pointer; padding:6px 11px;
        border-radius:8px; font-size:14px; transition:background .2s; flex-shrink:0;
      }
      #_sw_sendbtn:hover { background:rgba(124,159,255,.28); }
      #_sw_collapsed { padding:0 11px 9px; display:none; }
      #_sw_collapsed._sw_show { display:block; }
      #_sw_expand_hint { font-size:10px; color:#334155; cursor:pointer; text-align:center; padding:6px 0 2px; transition:color .2s; }
      #_sw_expand_hint:hover { color:#64748b; }
      #_sw_videochip { font-size:10px; color:#334155; padding:3px 10px; text-align:center; border-bottom:1px solid rgba(255,255,255,.04); }
      #_sw_videochip.found { color:#4ade80; }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = '_sw_root';
    root.innerHTML = `
      <div id="_sw_panel">
        <div id="_sw_titlebar">
          <span id="_sw_dot"></span>
          <span id="_sw_brand">SyncWatch</span>
          <span id="_sw_status">Idle</span>
          <button class="_sw_tbtn" id="_sw_share_btn" title="Share Screen">📺</button>
          <button class="_sw_tbtn" id="_sw_toggle" title="Toggle chat">💬</button>
          <button class="_sw_tbtn" id="_sw_close_btn" title="Hide overlay">✕</button>
        </div>
        <div id="_sw_videochip">Searching for video…</div>
        <div id="_sw_body">
          <div id="_sw_msgs"></div>
          <div id="_sw_inputrow">
            <input id="_sw_input" placeholder="Type a message…" autocomplete="off" maxlength="300" />
            <button id="_sw_sendbtn" title="Send">↑</button>
          </div>
        </div>
        <div id="_sw_collapsed">
          <div id="_sw_expand_hint">▲ Click to expand chat</div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    // Wire up UI
    document.getElementById('_sw_toggle').addEventListener('click', toggleChat);
    document.getElementById('_sw_share_btn').addEventListener('click', handleShareClick);
    document.getElementById('_sw_close_btn').addEventListener('click', () => { root.style.display = 'none'; });
    document.getElementById('_sw_sendbtn').addEventListener('click', sendChat);
    document.getElementById('_sw_input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    document.getElementById('_sw_expand_hint').addEventListener('click', toggleChat);
    makeDraggable(root, document.getElementById('_sw_titlebar'));
    startVideoWatcher();
  }

  function showOverlay(rId) {
    if (!overlayReady) injectOverlay();
    const root = document.getElementById('_sw_root');
    if (root) root.style.display = '';
    if (rId) setStatus('Room: ' + rId);
    // Hydrate chat from storage
    chrome.storage.local.get('chatHistory', ({ chatHistory }) => {
      if (chatHistory?.length) chatHistory.slice(-60).forEach(m => addChat(m.author, m.text, false));
    });
  }

  // ── Share button ──────────────────────────────────────────
  async function handleShareClick() {
    if (sharingActive) {
      relay('CONTENT_STOP_SHARE');
      sharingActive = false;
      updateShareBtn();
      return;
    }
    addChat('System', 'Opening screen share picker…');
    const res = await chrome.runtime.sendMessage({ type: 'CONTENT_START_SHARE' });
    if (res?.ok) {
      sharingActive = true;
      updateShareBtn();
    } else {
      addChat('Error', 'Share failed: ' + (res?.error || 'Permission denied'));
    }
  }

  function updateShareBtn() {
    const btn = document.getElementById('_sw_share_btn');
    if (!btn) return;
    if (sharingActive) {
      btn.textContent = '🔴';
      btn.title = 'Stop Screen Share';
      btn.classList.add('active');
    } else {
      btn.textContent = '📺';
      btn.title = 'Share Screen';
      btn.classList.remove('active');
    }
  }

  // ── Chat ──────────────────────────────────────────────────
  function toggleChat() {
    chatOpen = !chatOpen;
    const body = document.getElementById('_sw_body');
    const coll = document.getElementById('_sw_collapsed');
    if (body) body.style.display = chatOpen ? 'flex' : 'none';
    if (coll) coll.classList.toggle('_sw_show', !chatOpen);
  }

  function sendChat() {
    const input = document.getElementById('_sw_input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    relay('CONTENT_CHAT', { text });
    addChat('You', text, false);
    input.value = '';
  }

  function addChat(author, text, _save) {
    const box = document.getElementById('_sw_msgs');
    if (!box) return;
    const el = document.createElement('div');
    el.className = '_sw_msg';
    if (author === 'System' || author === 'Error') {
      el.classList.add('_sw_msg_system');
      el.textContent = text;
    } else if (author === 'Sync') {
      el.classList.add('_sw_msg_sync');
      el.textContent = text;
    } else {
      el.classList.add('_sw_msg_user');
      el.innerHTML = `<span class="author">${esc(author)}</span><span class="text">${esc(text)}</span>`;
    }
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 120) box.removeChild(box.firstChild);
  }

  // ── DOM helpers ───────────────────────────────────────────
  function setStatus(text) { const el = document.getElementById('_sw_status'); if (el) el.textContent = text; }
  function setDot(color)   { const el = document.getElementById('_sw_dot');    if (el) el.style.background = color; }
  function setVideoChip(text) {
    const el = document.getElementById('_sw_videochip');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('found', text.includes('✓'));
  }

  function esc(str) {
    return String(str).replace(/[&<>'"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function makeDraggable(el, handle) {
    let sX, sY, sL, sT;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      sX = e.clientX; sY = e.clientY; sL = r.left; sT = r.top;
      const mv = ev => {
        el.style.right = el.style.bottom = 'auto';
        el.style.left = (sL + ev.clientX - sX) + 'px';
        el.style.top  = (sT + ev.clientY - sY) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  // ── Video watcher ─────────────────────────────────────────
  function startVideoWatcher() {
    const tryAttach = () => {
      if (!video || !document.contains(video)) {
        const v = findVideo();
        if (v) attachVideo(v);
        else setVideoChip('No video found');
      }
    };
    setInterval(tryAttach, 2000);
    new MutationObserver(tryAttach).observe(document.documentElement, { childList: true, subtree: true });
    tryAttach();
  }

  // ═══════════════════════════════════════════════════════════
  // AUTO-INIT: Restore state from storage on every page load
  // ═══════════════════════════════════════════════════════════
  injectOverlay();

  chrome.storage.local.get(['sw_room', 'wsConnected', 'chatHistory', 'isSharing'], (data) => {
    if (data.sw_room && data.wsConnected) {
      showOverlay(data.sw_room);
      setDot('#4ade80');
      sharingActive = !!data.isSharing;
      updateShareBtn();
    }
  });

})();
