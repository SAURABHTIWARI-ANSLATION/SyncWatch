// SyncWatch Content Script
// Guard against double-injection
(function () {
  if (window.__syncwatch_loaded) return;
  window.__syncwatch_loaded = true;

  const WS_URL  = 'wss://syncwatch-o4za.onrender.com';
  const API_URL = 'https://syncwatch-o4za.onrender.com';



  // ── State ────────────────────────────────────────────────
  let ws               = null;
  let video            = null;
  let isSyncing        = false;
  let roomId           = null;
  let userId           = null;
  let connected        = false;
  let syncInterval     = null;
  let heartbeatInterval = null;
  let overlayCreated   = false;
  let chatOpen         = true;

  // ── Video detection ──────────────────────────────────────
  function findVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    // Pick the largest visible video
    return vids
      .filter(v => v.offsetWidth > 0 && v.offsetHeight > 0)
      .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0] || null;
  }

  // ── Video event handlers ─────────────────────────────────
  function onPlay()   { if (!isSyncing) wsend({ type: 'play',  time: video.currentTime }); }
  function onPause()  { if (!isSyncing) wsend({ type: 'pause', time: video.currentTime }); }
  function onSeeked() { if (!isSyncing) wsend({ type: 'seek',  time: video.currentTime }); }

  function attachVideo(v) {
    if (video === v) return;
    detachVideo();
    video = v;
    video.addEventListener('play',   onPlay);
    video.addEventListener('pause',  onPause);
    video.addEventListener('seeked', onSeeked);
    setStatus('Video attached ✓');
    setVideoChip('✓ Video found & attached');
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener('play',   onPlay);
    video.removeEventListener('pause',  onPause);
    video.removeEventListener('seeked', onSeeked);
    video = null;
  }

  // ── Sync apply ───────────────────────────────────────────
  function applySync(state) {
    if (!video || !state) return;
    isSyncing = true;

    const diff = Math.abs(video.currentTime - state.time);
    if (diff > 0.8) {
      video.currentTime = state.time;
    }

    if (state.playing && video.paused) {
      video.play().catch(() => {});
    } else if (!state.playing && !video.paused) {
      video.pause();
    }

    setTimeout(() => { isSyncing = false; }, 700);
  }

  // ── WebSocket helpers ─────────────────────────────────────
  function wsend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function connect(rId) {
    roomId = rId;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      connected = true;
      wsend({ type: 'join', roomId });

      // Periodic drift correction
      syncInterval = setInterval(() => wsend({ type: 'sync_request' }), 5000);
      // Keep connection alive
      heartbeatInterval = setInterval(() => wsend({ type: 'heartbeat' }), 20000);
    };

    ws.onmessage = (e) => {
      try { handleMessage(JSON.parse(e.data)); } catch {}
    };

    ws.onclose = () => {
      connected = false;
      clearInterval(syncInterval);
      clearInterval(heartbeatInterval);
      setStatus('Disconnected');
      setDot('#ef4444');
    };

    ws.onerror = () => {
      setStatus('Connection error');
      setDot('#ef4444');
    };
  }

  function disconnect() {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    clearInterval(syncInterval);
    clearInterval(heartbeatInterval);
    connected = false;
    roomId = null;
    userId = null;
    setStatus('Idle');
    setDot('#475569');
  }

  // ── Message handler ──────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        userId = msg.userId;
        applySync(msg.state);
        setStatus('Room: ' + msg.roomId);
        setDot('#4ade80');
        addChat('System', `You joined · ${msg.memberCount} ${msg.memberCount === 1 ? 'person' : 'people'} watching`);
        break;

      case 'play':
        if (msg.userId !== userId) applySync({ time: msg.time, playing: true });
        addChat('Sync', `▶ ${msg.userId} played at ${fmt(msg.time)}`);
        break;

      case 'pause':
        if (msg.userId !== userId) applySync({ time: msg.time, playing: false });
        addChat('Sync', `⏸ ${msg.userId} paused at ${fmt(msg.time)}`);
        break;

      case 'seek':
        if (msg.userId !== userId) {
          isSyncing = true;
          if (video) video.currentTime = msg.time;
          setTimeout(() => { isSyncing = false; }, 700);
        }
        addChat('Sync', `⏩ ${msg.userId} seeked to ${fmt(msg.time)}`);
        break;

      case 'sync':
        applySync(msg.state);
        break;

      case 'chat':
        addChat(msg.userId, msg.text);
        break;

      case 'user_joined':
        addChat('System', `${msg.userId} joined · ${msg.memberCount} watching`);
        break;

      case 'user_left':
        addChat('System', `${msg.userId} left · ${msg.memberCount} watching`);
        break;

      case 'error':
        addChat('Error', msg.msg);
        setStatus('Error: ' + msg.msg);
        setDot('#ef4444');
        break;
    }
  }

  // ── Overlay UI ───────────────────────────────────────────
  function injectOverlay() {
    if (overlayCreated) return;
    overlayCreated = true;

    // Scoped styles — prefixed with _sw_ to avoid conflicts
    const style = document.createElement('style');
    style.id = '_sw_styles';
    style.textContent = `
      #_sw_root {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 280px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        color: #e2e8f0;
      }
      #_sw_root * { box-sizing: border-box; margin: 0; padding: 0; }
      #_sw_panel {
        background: rgba(8, 11, 20, 0.97);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 16px 48px rgba(0,0,0,0.7), 0 0 0 0.5px rgba(255,255,255,0.04) inset;
      }
      #_sw_titlebar {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 9px 11px;
        cursor: move;
        border-bottom: 1px solid rgba(255,255,255,0.07);
        user-select: none;
      }
      #_sw_dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #475569;
        flex-shrink: 0;
        transition: background 0.4s;
      }
      #_sw_brand {
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 1.5px;
        color: #fff;
        text-transform: uppercase;
        flex-shrink: 0;
      }
      #_sw_status {
        flex: 1;
        font-size: 10px;
        color: #64748b;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      ._sw_tbtn {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
        color: #94a3b8;
        cursor: pointer;
        padding: 3px 8px;
        border-radius: 6px;
        font-size: 11px;
        line-height: 1.5;
        flex-shrink: 0;
        transition: background 0.2s;
      }
      ._sw_tbtn:hover { background: rgba(255,255,255,0.13); color: #e2e8f0; }
      #_sw_body { display: flex; flex-direction: column; }
      #_sw_msgs {
        height: 160px;
        overflow-y: auto;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        scrollbar-width: thin;
        scrollbar-color: #1e293b transparent;
      }
      #_sw_msgs::-webkit-scrollbar { width: 3px; }
      #_sw_msgs::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
      ._sw_msg { font-size: 11.5px; line-height: 1.5; word-break: break-word; }
      ._sw_msg_system { color: #475569; font-style: italic; }
      ._sw_msg_sync   { color: #334155; }
      ._sw_msg_user span.author { color: #7c9fff; font-weight: 600; margin-right: 4px; }
      ._sw_msg_user span.text   { color: #cbd5e1; }
      #_sw_inputrow {
        display: flex;
        gap: 6px;
        padding: 7px 9px;
        border-top: 1px solid rgba(255,255,255,0.07);
      }
      #_sw_input {
        flex: 1;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 8px;
        padding: 6px 9px;
        color: #e2e8f0;
        font-size: 11.5px;
        outline: none;
        transition: border-color 0.2s;
      }
      #_sw_input:focus { border-color: rgba(124,159,255,0.5); }
      #_sw_input::placeholder { color: #334155; }
      #_sw_sendbtn {
        background: rgba(124,159,255,0.15);
        border: 1px solid rgba(124,159,255,0.2);
        color: #7c9fff;
        cursor: pointer;
        padding: 6px 11px;
        border-radius: 8px;
        font-size: 14px;
        transition: background 0.2s;
        flex-shrink: 0;
      }
      #_sw_sendbtn:hover { background: rgba(124,159,255,0.28); }
      #_sw_collapsed { padding: 0 11px 9px; display: none; }
      #_sw_collapsed._sw_show { display: block; }
      #_sw_expand_hint {
        font-size: 10px; color: #334155; cursor: pointer;
        text-align: center; padding: 6px 0 2px;
        transition: color 0.2s;
      }
      #_sw_expand_hint:hover { color: #64748b; }
    `;
    document.head.appendChild(style);

    // Build overlay DOM
    const root = document.createElement('div');
    root.id = '_sw_root';
    root.innerHTML = `
      <div id="_sw_panel">
        <div id="_sw_titlebar">
          <span id="_sw_dot"></span>
          <span id="_sw_brand">SyncWatch</span>
          <span id="_sw_status">Idle</span>
          <button class="_sw_tbtn" id="_sw_toggle" title="Toggle chat">💬</button>
          <button class="_sw_tbtn" id="_sw_close_btn" title="Hide overlay">✕</button>
        </div>
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

    // Wire up buttons
    document.getElementById('_sw_toggle').addEventListener('click', toggleChat);
    document.getElementById('_sw_close_btn').addEventListener('click', () => {
      root.style.display = 'none';
    });
    document.getElementById('_sw_sendbtn').addEventListener('click', sendChat);
    document.getElementById('_sw_input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    document.getElementById('_sw_expand_hint').addEventListener('click', toggleChat);

    // Make draggable
    makeDraggable(root, document.getElementById('_sw_titlebar'));

    // Auto-detect video
    startVideoWatcher();
  }

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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addChat('Error', 'Not connected to a room');
      return;
    }
    wsend({ type: 'chat', text });
    addChat('You', text);
    input.value = '';
  }

  function addChat(user, text) {
    const box = document.getElementById('_sw_msgs');
    if (!box) return;

    const el = document.createElement('div');
    el.className = '_sw_msg';

    if (user === 'System' || user === 'Error') {
      el.classList.add('_sw_msg_system');
      el.textContent = text;
    } else if (user === 'Sync') {
      el.classList.add('_sw_msg_sync');
      el.textContent = text;
    } else {
      el.classList.add('_sw_msg_user');
      el.innerHTML = `<span class="author">${esc(user)}</span><span class="text">${esc(text)}</span>`;
    }

    box.appendChild(el);
    box.scrollTop = box.scrollHeight;

    // Keep max 100 messages
    while (box.children.length > 100) box.removeChild(box.firstChild);
  }

  function setStatus(text) {
    const el = document.getElementById('_sw_status');
    if (el) el.textContent = text;
  }

  function setDot(color) {
    const el = document.getElementById('_sw_dot');
    if (el) el.style.background = color;
  }

  function setVideoChip(text) {
    // Communicates back to popup via storage
    chrome.storage.local.set({ sw_video_status: text });
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function fmt(secs) {
    const s = Math.floor(secs);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
    return `${m}:${String(s % 60).padStart(2,'0')}`;
  }

  // ── Drag ─────────────────────────────────────────────────
  function makeDraggable(el, handle) {
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      startX    = e.clientX;
      startY    = e.clientY;
      startLeft = rect.left;
      startTop  = rect.top;

      const onMove = ev => {
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        el.style.left   = (startLeft + ev.clientX - startX) + 'px';
        el.style.top    = (startTop  + ev.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // ── Video watcher ─────────────────────────────────────────
  function startVideoWatcher() {
    // Poll every 2s
    setInterval(() => {
      if (!video || !document.contains(video)) {
        const v = findVideo();
        if (v) attachVideo(v);
      }
    }, 2000);

    // Also watch for DOM changes (SPAs)
    const obs = new MutationObserver(() => {
      if (!video) {
        const v = findVideo();
        if (v) attachVideo(v);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // Initial attempt
    const v = findVideo();
    if (v) attachVideo(v);
  }

  // ── Message listener (from popup via background) ──────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ alive: true });
      return true;
    }
    if (msg.type === 'JOIN_ROOM') {
      if (!overlayCreated) injectOverlay();
      const rootEl = document.getElementById('_sw_root');
      if (rootEl) rootEl.style.display = '';
      if (ws) { try { ws.close(); } catch {} ws = null; }
      clearInterval(syncInterval);
      clearInterval(heartbeatInterval);
      connect(msg.roomId);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'LEAVE_ROOM') {
      disconnect();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'GET_STATUS') {
      sendResponse({ connected, roomId, userId, hasVideo: !!video });
      return true;
    }
    return false;
  });

  // Auto-inject overlay on load (passive — won't connect until JOIN_ROOM)
  injectOverlay();

})();
