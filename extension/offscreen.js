// SyncWatch Offscreen Document - WebRTC Manager
// This document persists independently of any tab, so RTCPeerConnections
// survive page navigation and reloads.
'use strict';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let localStream = null;            // The captured screen stream
let rtcPeers    = {};              // { userId: RTCPeerConnection }

// ── Tell background we are alive ─────────────────────────
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

// ═══════════════════════════════════════════════════════════
// MESSAGE HANDLER (receives from background.js via msgOffscreen)
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only handle messages intended for the offscreen doc
  if (!msg._offscreen) return false;

  switch (msg.type) {

    case 'START_CAPTURE':
      startCapture(msg.streamId, msg.targetIds || [])
        .then(() => sendResponse({ ok: true }))
        .catch(e => {
          console.error('[Offscreen] START_CAPTURE failed:', e);
          sendResponse({ ok: false, error: e.message });
        });
      return true; // keep channel open for async response

    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse({ ok: true });
      return false;

    case 'CREATE_OFFER':
      createOffer(msg.targetId);
      return false;

    case 'SIGNAL':
      handleSignal(msg.senderId, msg.signalData);
      return false;

    case 'PEER_LEFT':
      closePeer(msg.peerId);
      return false;
  }

  return false;
});

// ═══════════════════════════════════════════════════════════
// SCREEN CAPTURE
// ═══════════════════════════════════════════════════════════
async function startCapture(streamId, targetIds) {
  // Use the desktopCapture streamId passed from background
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: false, // audio via system capture can cause echo; toggle if needed
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
        maxWidth:     1920,
        maxHeight:    1080,
        maxFrameRate: 30
      }
    }
  });

  // Try to add audio track separately (not all sources support it)
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
      video: false
    });
    audioStream.getAudioTracks().forEach(t => localStream.addTrack(t));
  } catch { /* audio not available for this source — that's fine */ }

  // Notify background if user clicks browser "Stop sharing" natively
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onended = () => {
      stopCapture();
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_SHARE_ENDED' }).catch(() => {});
    };
  }

  // Offer to all users already in the room
  for (const id of targetIds) {
    await createOffer(id);
  }
}

function stopCapture() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  Object.keys(rtcPeers).forEach(id => closePeer(id));
  console.log('[Offscreen] Capture stopped, all peers closed');
}

// ═══════════════════════════════════════════════════════════
// WEBRTC
// ═══════════════════════════════════════════════════════════
async function createOffer(targetId) {
  const pc = getOrCreatePeer(targetId);

  // Add all local tracks (video / audio)
  if (localStream) {
    localStream.getTracks().forEach(t => {
      // Avoid adding duplicate senders
      const senders = pc.getSenders().map(s => s.track);
      if (!senders.includes(t)) pc.addTrack(t, localStream);
    });
  }

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendToBackground({ type: 'OFFSCREEN_SIGNAL', targetId, signalData: { offer } });
  } catch (e) {
    console.error('[Offscreen] createOffer error:', e);
  }
}

async function handleSignal(senderId, signal) {
  const pc = getOrCreatePeer(senderId);

  try {
    if (signal.offer) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
      // Add tracks before answering
      if (localStream) {
        localStream.getTracks().forEach(t => {
          const senders = pc.getSenders().map(s => s.track);
          if (!senders.includes(t)) pc.addTrack(t, localStream);
        });
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendToBackground({ type: 'OFFSCREEN_SIGNAL', targetId: senderId, signalData: { answer } });
      drainIceQueue(pc);

    } else if (signal.answer) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
      drainIceQueue(pc);

    } else if (signal.candidate) {
      const ice = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription?.type) {
        pc.addIceCandidate(ice).catch(() => {});
      } else {
        pc._iceQueue = pc._iceQueue || [];
        pc._iceQueue.push(ice);
      }
    }
  } catch (e) {
    console.error('[Offscreen] handleSignal error:', e);
  }
}

function getOrCreatePeer(peerId) {
  if (rtcPeers[peerId]) return rtcPeers[peerId];

  const pc = new RTCPeerConnection(ICE_SERVERS);
  pc._iceQueue = [];
  rtcPeers[peerId] = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendToBackground({ type: 'OFFSCREEN_SIGNAL', targetId: peerId, signalData: { candidate: e.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[Offscreen] Peer ${peerId} state: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeer(peerId);
    }
  };

  return pc;
}

function closePeer(peerId) {
  if (!rtcPeers[peerId]) return;
  try { rtcPeers[peerId].close(); } catch {}
  delete rtcPeers[peerId];
}

function drainIceQueue(pc) {
  if (!pc._iceQueue?.length) return;
  pc._iceQueue.forEach(c => pc.addIceCandidate(c).catch(() => {}));
  pc._iceQueue = [];
}

// ── Relay back to background ──────────────────────────────
function sendToBackground(msg) {
  chrome.runtime.sendMessage({ _offscreen_reply: true, ...msg }).catch(() => {});
}

console.log('[Offscreen] SyncWatch offscreen doc loaded');
