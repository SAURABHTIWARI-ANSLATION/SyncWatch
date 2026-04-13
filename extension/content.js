// SyncWatch Content Script v3.2
// Responsibilities:
//   1. DOM overlay UI
//   2. Video detection & sync
//   3. WebRTC peer connections (screen share HOST side) — moved here from offscreen
//   ALL networking delegated to background.js via chrome.runtime.sendMessage.
"use strict";

(function () {
  // 🚫 Ignore sandboxed / useless frames
  try {
    if (window.location.href === "about:blank" || window.location.href.startsWith("chrome:")) return;
  } catch (e) {
    return;
  }

  if (window.__syncwatch_loaded) return;
  window.__syncwatch_loaded = true;
  console.log("[SW] Injected in frame:", window.location.href);

  // ── State ─────────────────────────────────────────────────
  let video = null;
  let isSyncing = false;
  let overlayReady = false; // Note: UI only renders in top frame
  let chatOpen = true;
  let currentUserId = null;
  let sharingActive = false;

  // ── WebRTC state (host side) ──────────────────────────────
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  let localStream = null;   // captured screen MediaStream
  let rtcPeers = {};     // { userId: RTCPeerConnection }
  let remoteStream = null;  // received screen stream (for guests)
  let isHost = false;      // am I the screen share host?

  // ═══════════════════════════════════════════════════════════
  // VIDEO DETECTION & SYNC
  // ═══════════════════════════════════════════════════════════
  function findVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    // Sort by visible size (width * height) descending
    return vids.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
  }

  const onPlay = () => { if (!isSyncing) relay('CONTENT_PLAY', { time: video.currentTime }); };
  const onPause = () => { if (!isSyncing) relay('CONTENT_PAUSE', { time: video.currentTime }); };
  const onSeeked = () => { if (!isSyncing) relay('CONTENT_SEEK', { time: video.currentTime }); };

  function attachVideo(v) {
    if (video === v) return;
    detachVideo();
    video = v;
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    chrome.storage.local.set({ sw_has_video: true });
    setVideoChip('✓ Video attached');
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('seeked', onSeeked);
    video = null;
  }

  function applySync(state) {
    if (!video || !state) return;
    isSyncing = true;
    const diff = Math.abs(video.currentTime - state.time);
    if (diff > 0.8) video.currentTime = state.time;
    if (state.playing && video.paused) video.play().catch(() => { });
    else if (!state.playing && !video.paused) video.pause();
    setTimeout(() => { isSyncing = false; }, 700);
  }

  // ═══════════════════════════════════════════════════════════
  // WEBRTC — HOST SIDE (runs in content script page context)
  // ═══════════════════════════════════════════════════════════

  // Called by background after desktopCapture gives a streamId
  async function startCapture(streamId, targetIds) {
    try {
      console.log('[SW Content] Starting capture with streamId:', streamId);
      console.log('[SW Content] Target IDs:', targetIds);
      
      // Use getDisplayMedia with the streamId from desktopCapture API
      // This is the modern approach that works in MV3 content scripts
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
            maxWidth: 1920,
            maxHeight: 1080,
            maxFrameRate: 30
          }
        }
      });

      console.log('[SW Content] Stream obtained, tracks:', localStream.getTracks().length);
      
      // Try to add system audio (optional)
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: streamId
            }
          },
          video: false
        });
        const audioTracks = audioStream.getAudioTracks();
        if (audioTracks.length > 0) {
          audioTracks.forEach(t => localStream.addTrack(t));
          console.log('[SW Content] Audio tracks added:', audioTracks.length);
        }
      } catch (audioErr) {
        console.warn('[SW Content] Audio capture failed (non-critical):', audioErr.message);
      }

      // Watch for native "Stop sharing" button
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          console.log('[SW Content] Video track ended by user');
          stopCapture();
          relay('CONTENT_SHARE_ENDED', {});
        };
      }

      addChat('System', 'Screen captured! Connecting to guests…');
      console.log('[SW Content] Creating offers for', (targetIds || []).length, 'targets');

      // Create offers for all existing room members
      for (const id of (targetIds || [])) {
        await createOffer(id);
      }

      addChat('System', `Offer sent to ${(targetIds || []).length} guest(s)`);
      console.log('[SW Content] Capture started successfully');
    } catch (err) {
      console.error('[SW Content] startCapture failed:', err);
      console.error('[SW Content] Error details:', err.name, err.message);
      addChat('Error', 'Screen capture failed: ' + err.message);
      sharingActive = false;
      updateShareBtn();
      relay('CONTENT_SHARE_ENDED', {});
    }
  }

  function stopCapture() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    Object.keys(rtcPeers).forEach(id => closePeer(id));
  }

  async function createOffer(targetId) {
    console.log('[SW Content] Creating offer for:', targetId);
    const pc = getOrCreatePeer(targetId);

    if (localStream) {
      localStream.getTracks().forEach(t => {
        const senders = pc.getSenders().map(s => s.track);
        if (!senders.includes(t)) {
          console.log('[SW Content] Adding track to peer:', t.kind, t.id);
          pc.addTrack(t, localStream);
        }
      });
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('[SW Content] Offer set as local description');
      relay('CONTENT_SIGNAL', { targetId, signalData: { offer } });
      console.log('[SW Content] Offer sent to', targetId);
    } catch (e) {
      console.error('[SW Content] createOffer error:', e);
      addChat('Error', 'Failed to create offer for ' + targetId);
    }
  }

  async function handleSignal(senderId, signalData) {
    console.log('[SW Content] Handling signal from:', senderId, signalData);
    const pc = getOrCreatePeer(senderId);

    try {
      if (signalData.offer) {
        console.log('[SW Content] Received offer from:', senderId);
        // Guest → host: this shouldn't happen normally (host only sends offers)
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.offer));
        if (localStream) {
          localStream.getTracks().forEach(t => {
            const senders = pc.getSenders().map(s => s.track);
            if (!senders.includes(t)) pc.addTrack(t, localStream);
          });
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        relay('CONTENT_SIGNAL', { targetId: senderId, signalData: { answer } });
        drainIceQueue(pc);

      } else if (signalData.answer) {
        console.log('[SW Content] Received answer from:', senderId);
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.answer));
        drainIceQueue(pc);

      } else if (signalData.candidate) {
        const ice = new RTCIceCandidate(signalData.candidate);
        if (pc.remoteDescription?.type) {
          pc.addIceCandidate(ice).catch(() => { });
        } else {
          pc._iceQueue = pc._iceQueue || [];
          pc._iceQueue.push(ice);
        }
      }
    } catch (e) {
      console.error('[SW Content] handleSignal error:', e);
    }
  }

  function getOrCreatePeer(peerId) {
    if (rtcPeers[peerId]) return rtcPeers[peerId];

    console.log('[SW Content] Creating new peer for:', peerId);
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pc._iceQueue = [];
    rtcPeers[peerId] = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        console.log('[SW Content] Sending ICE candidate to:', peerId);
        relay('CONTENT_SIGNAL', { targetId: peerId, signalData: { candidate: e.candidate } });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[SW Content] ICE ${peerId}: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[SW Content] Peer ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        console.log('[SW Content] Peer connected:', peerId);
        addChat('System', `Connected to ${peerId}`);
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        console.warn('[SW Content] Peer connection failed:', peerId);
        addChat('System', `Connection to ${peerId} lost`);
        closePeer(peerId);
      }
    };

    // Handle incoming tracks (for guests receiving screen share)
    pc.ontrack = (e) => {
      console.log('[SW Content] Received remote track from:', peerId);
      if (!e.streams || !e.streams[0]) {
        console.warn('[SW Content] No streams in track event');
        return;
      }
      
      remoteStream = e.streams[0];
      addChat('System', '🎥 Receiving screen share from host!');
      
      // Display the remote stream in a video element
      showRemoteStream(remoteStream);
    };

    return pc;
  }

  function closePeer(peerId) {
    if (!rtcPeers[peerId]) return;
    try { rtcPeers[peerId].close(); } catch { }
    delete rtcPeers[peerId];
    console.log('[SW Content] Closed peer:', peerId);
  }

  function drainIceQueue(pc) {
    if (!pc._iceQueue?.length) return;
    console.log('[SW Content] Draining ICE queue:', pc._iceQueue.length, 'candidates');
    pc._iceQueue.forEach(c => pc.addIceCandidate(c).catch(() => { }));
    pc._iceQueue = [];
  }

  // Show remote stream in a floating video overlay
  function showRemoteStream(stream) {
    // Check if already showing
    let remoteVideo = document.getElementById('_sw_remote_video');
    if (!remoteVideo) {
      // Create video element
      remoteVideo = document.createElement('video');
      remoteVideo.id = '_sw_remote_video';
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      remoteVideo.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        width: 480px;
        max-width: 50vw;
        border-radius: 12px;
        border: 2px solid rgba(124, 159, 255, 0.3);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        z-index: 2147483646;
        background: #000;
      `;
      
      // Add close button
      const closeBtn = document.createElement('button');
      closeBtn.id = '_sw_remote_close';
      closeBtn.innerHTML = '✕';
      closeBtn.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        border: none;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
      `;
      closeBtn.onclick = () => {
        remoteVideo.style.display = 'none';
        addChat('System', 'Screen share hidden. You can still watch synced video.');
      };
      
      remoteVideo.appendChild(closeBtn);
      document.body.appendChild(remoteVideo);
      
      addChat('System', 'Screen share video displayed (top-right corner)');
    }
    
    remoteVideo.srcObject = stream;
    remoteVideo.style.display = 'block';
    remoteVideo.play().catch(err => {
      console.warn('[SW Content] Remote video play error:', err);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // BACKGROUND → CONTENT MESSAGES
  // ═══════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    console.log("[SW Content] Received message:", msg.type, msg);
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
        addChat('System', 'Screen sharing started — guests can see your screen');
        return false;

      case 'BG_SHARE_STOPPED':
        sharingActive = false;
        updateShareBtn();
        addChat('System', 'Screen sharing stopped');
        stopCapture();
        // Hide remote video if showing
        const remoteVid = document.getElementById('_sw_remote_video');
        if (remoteVid) remoteVid.style.display = 'none';
        return false;

      case 'BG_STATUS':
        setDot(msg.connected ? '#4ade80' : '#ef4444');
        return false;

      case 'BG_LEFT_ROOM':
        setDot('#475569');
        setStatus('Idle');
        addChat('System', 'Left room');
        stopCapture();
        sharingActive = false;
        updateShareBtn();
        return false;

      case 'BG_ERROR':
        addChat('Error', msg.msg);
        setDot('#ef4444');
        return false;

      case 'BG_MEMBER_COUNT':
        return false;

      case 'BG_PEER_LEFT':
        closePeer(msg.peerId);
        return false;

      // Background found a desktopCapture streamId for us — start WebRTC capture here
      case 'BG_START_CAPTURE':
        startCapture(msg.streamId, msg.targetIds || []);
        return false;

      // Background tells us to stop capture (e.g., leave room)
      case 'BG_STOP_CAPTURE':
        stopCapture();
        return false;

      // Background relays signal from guest → handle it in our WebRTC code
      case 'BG_SIGNAL':
        handleSignal(msg.senderId, msg.signalData);
        return false;

      // Background tells us to create new offers for new guests
      case 'BG_CREATE_OFFERS':
        if (localStream && msg.targetIds) {
          msg.targetIds.forEach(id => createOffer(id));
        }
        return false;
    }
    return false;
  });

  // ═══════════════════════════════════════════════════════════
  // RELAY HELPER
  // ═══════════════════════════════════════════════════════════
  function relay(type, extra = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...extra }).catch(() => { });
    } catch (e) {
      console.warn("[SW] Extension context invalidated (dead relay)");
    }
  }

  // ═══════════════════════════════════════════════════════════
  // OVERLAY UI
  // ═══════════════════════════════════════════════════════════
  function injectOverlay(roomId) {
    // ⚡ UI logic: Only render overlay in TOP frame
    if (window !== window.top) {
      console.log("[SW] Iframe detected → skipping UI render");
      return;
    }
    if (overlayReady) return;
    overlayReady = true;

    const style = document.createElement('style');
    style.textContent = `
      #_sw_root {
        position:fixed; bottom:24px; right:24px; width:360px;
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
        display:flex; align-items:center; gap:6px;
        padding:8px 10px; cursor:move;
        border-bottom:1px solid rgba(255,255,255,0.07); user-select:none;
      }
      #_sw_dot { width:8px; height:8px; border-radius:50%; background:#475569; flex-shrink:0; transition:background .4s; }
      #_sw_brand { font-size:10px; font-weight:800; letter-spacing:1.5px; color:#fff; text-transform:uppercase; flex-shrink:0; }
      #_sw_status { flex:1; font-size:10px; color:#64748b; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      ._sw_tbtn {
        background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.08);
        color:#94a3b8; cursor:pointer; padding:3px 8px; border-radius:6px;
        font-size:10px; font-weight:600; line-height:1.5; flex-shrink:0; transition:background .2s;
        white-space:nowrap; letter-spacing:0.2px;
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
          <button class="_sw_tbtn" id="_sw_share_btn" title="Share Screen">Share Screen</button>
          <button class="_sw_tbtn" id="_sw_toggle" title="Toggle chat">Chat</button>
          <button class="_sw_tbtn" id="_sw_close_btn" title="Hide overlay">Hide</button>
        </div>
        <div id="_sw_videochip">Searching for video...</div>
        <div id="_sw_body">
          <div id="_sw_msgs"></div>
          <div id="_sw_inputrow">
            <input id="_sw_input" placeholder="Type a message..." autocomplete="off" maxlength="300" />
            <button id="_sw_sendbtn" title="Send">Send</button>
          </div>
        </div>
        <div id="_sw_collapsed">
          <div id="_sw_expand_hint">Click to expand chat</div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

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
    chrome.storage.local.get('chatHistory', ({ chatHistory }) => {
      if (chatHistory?.length) chatHistory.slice(-60).forEach(m => addChat(m.author, m.text, false));
    });
  }

  // ── Share button ──────────────────────────────────────────
  async function handleShareClick() {
    if (sharingActive) {
      console.log('[SW Content] Stopping share');
      relay('CONTENT_STOP_SHARE');
      sharingActive = false;
      updateShareBtn();
      stopCapture();
      return;
    }
    
    console.log('[SW Content] Starting share - checking connection state');
    
    // Check if we're in a room
    const storage = await new Promise(resolve => {
      chrome.storage.local.get(['sw_room', 'wsConnected'], resolve);
    });
    
    if (!storage.sw_room || !storage.wsConnected) {
      addChat('Error', 'You must join a room before sharing your screen');
      return;
    }
    
    addChat('System', 'Opening screen share picker…');
    const res = await chrome.runtime.sendMessage({ type: 'CONTENT_START_SHARE' });
    if (res?.ok) {
      // Background will send BG_START_CAPTURE message with streamId when user picks
      addChat('System', 'Screen picker opened — select what to share…');
      sharingActive = true;
      updateShareBtn();
    } else {
      const errorMsg = res?.error || 'Permission denied';
      console.error('[SW Content] Share failed:', errorMsg);
      addChat('Error', 'Share failed: ' + errorMsg);
      sharingActive = false;
      updateShareBtn();
    }
  }

  function updateShareBtn() {
    const btn = document.getElementById('_sw_share_btn');
    if (!btn) return;
    if (sharingActive) {
      btn.textContent = 'Stop Sharing';
      btn.title = 'Stop Screen Share';
      btn.classList.add('active');
    } else {
      btn.textContent = 'Share Screen';
      btn.title = 'Share your screen with guests';
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
  function setDot(color) { const el = document.getElementById('_sw_dot'); if (el) el.style.background = color; }
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
        el.style.top = (sT + ev.clientY - sY) + 'px';
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
  // AUTO-INIT
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
