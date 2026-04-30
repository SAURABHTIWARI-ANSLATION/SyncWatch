'use strict';

const express = require('express');
const http    = require('http');
const path    = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CHAT_HISTORY       = 100;   // messages kept per room (FIFO)
const MAX_CHAT_MSG_LEN       = 500;   // characters
const MAX_ROOM_ID_LEN        = 8;
const RATE_LIMIT_PER_SEC     = 10;    // max WS messages/sec per socket
const EMPTY_ROOM_TTL_MS      = 30_000;  // keep empty rooms 30s (host refresh)
const STALE_ROOM_TTL_MS      = 2 * 60 * 60 * 1000; // GC after 2h empty

// ─────────────────────────────────────────────────────────────────────────────
// In-memory store
// ─────────────────────────────────────────────────────────────────────────────
//
// rooms: Map<roomId, {
//   hostId    : string,          — userId who created the room
//   clients   : Set<ws>,
//   createdAt : number,
//   state     : { time, playing, updatedAt },
//   chatHistory: MessageObj[]    — capped at MAX_CHAT_HISTORY (FIFO)
// }>
//
// MessageObj: { id, user, text, timestamp, type: 'user'|'system' }

const rooms = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — send / broadcast
// ─────────────────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomId, obj, exclude = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const raw = JSON.stringify(obj);
  room.clients.forEach(c => {
    if (c !== exclude && c.readyState === c.OPEN) c.send(raw);
  });
}

function broadcastAll(roomId, obj) {
  broadcast(roomId, obj, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — room management
// ─────────────────────────────────────────────────────────────────────────────

function createRoom(hostId) {
  const roomId = uuidv4().replace(/-/g, '').slice(0, MAX_ROOM_ID_LEN).toUpperCase();
  rooms.set(roomId, {
    hostId,
    clients:     new Set(),
    createdAt:   Date.now(),
    state:       { time: 0, playing: false, updatedAt: Date.now() },
    chatHistory: []
  });
  return roomId;
}

function getOrCreateRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  rooms.set(id, {
    hostId:      null,
    clients:     new Set(),
    createdAt:   Date.now(),
    state:       { time: 0, playing: false, updatedAt: Date.now() },
    chatHistory: []
  });
  return rooms.get(id);
}

function getUserList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.clients].filter(c => c.wsUserId).map(c => ({ name: c.wsUserId }));
}

function syncedTime(state) {
  if (!state.playing) return state.time;
  return state.time + (Date.now() - state.updatedAt) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — chat
// ─────────────────────────────────────────────────────────────────────────────

function sanitize(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim();
}

function appendChat(roomId, msgObj) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.chatHistory.push(msgObj);
  if (room.chatHistory.length > MAX_CHAT_HISTORY) room.chatHistory.shift();
}

function systemMsg(roomId, text) {
  const msg = {
    id:        `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    user:      null,
    text,
    timestamp: Date.now(),
    type:      'system'
  };
  appendChat(roomId, msg);
  broadcastAll(roomId, { type: 'chatMessage', ...msg });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — rate limiting (per socket)
// ─────────────────────────────────────────────────────────────────────────────

const rateLimits = new Map(); // socketId → { count, ts }

function checkRate(socketId) {
  const now = Date.now();
  const rec = rateLimits.get(socketId);
  if (!rec || now - rec.ts > 1000) { rateLimits.set(socketId, { count: 1, ts: now }); return true; }
  if (rec.count >= RATE_LIMIT_PER_SEC) return false;
  rec.count++;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-cleanup stale rooms
// ─────────────────────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.clients.size === 0 && (now - room.createdAt) > STALE_ROOM_TTL_MS) {
      rooms.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

app.use((_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_, res) => res.sendStatus(200));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────────────────

// Health — used by uptime monitors & extension status checks
app.get('/health', (_, res) => {
  const totalUsers = [...rooms.values()].reduce((n, r) => n + r.clients.size, 0);
  const totalMsgs  = [...rooms.values()].reduce((n, r) => n + r.chatHistory.length, 0);
  res.json({
    status: 'online',
    activeRooms: rooms.size,
    totalUsers,
    totalChatMessages: totalMsgs,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage()
  });
});

app.get('/', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

// Stats — admin overview
app.get('/stats', (_, res) => {
  const list = [];
  for (const [name, room] of rooms) {
    list.push({
      name,
      users:            [...room.clients].map(c => c.wsUserId).filter(Boolean),
      userCount:        room.clients.size,
      chatMessageCount: room.chatHistory.length,
      createdAt:        new Date(room.createdAt).toISOString()
    });
  }
  res.json({ rooms: list });
});

// Chat history — for late-joiners or web clients
app.get('/room/:roomName/chat', (req, res) => {
  const id = req.params.roomName.toUpperCase();
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ room: id, messages: room.chatHistory, total: room.chatHistory.length });
});

// Create room — returns roomId + hostId (the hostId must be sent back on WS join)
app.post('/room/create', (req, res) => {
  const hostId = req.body?.hostId || uuidv4();
  const roomId = createRoom(hostId);
  console.log(`[Room] Created ${roomId} for host ${hostId}`);
  res.json({ roomId, hostId });
});

// Check / auto-create room — used by extension before joining
app.get('/room/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  const exists = rooms.has(id);
  if (!exists && id.length === MAX_ROOM_ID_LEN) {
    getOrCreateRoom(id);
    console.log(`[Room] Auto-created ${id} via HTTP check`);
  }
  res.json({ exists: rooms.has(id) });
});

// SPA fallback for web join page
app.get('/join/:id', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  let roomId   = null;
  let userId   = `anon_${uuidv4().slice(0, 4)}`;
  const sid    = uuidv4(); // stable per-connection id for rate limiting

  ws.wsUserId = userId;
  console.log(`[WS] Connected from ${req.headers.origin || 'unknown'}`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── join ──────────────────────────────────────────────────────
      case 'join': {
        const id = String(msg.roomId || '').toUpperCase();
        if (!id || id.length !== MAX_ROOM_ID_LEN) {
          send(ws, { type: 'error', msg: 'Invalid room ID format.' });
          return;
        }

        const room = getOrCreateRoom(id);
        roomId = id;
        room.clients.add(ws);

        // Assign display name — hostId match → "Host", else masked
        const cid = String(msg.userId || '');
        userId = (cid && cid === room.hostId) ? 'Host' : `Guest-${cid.slice(0, 4).toUpperCase() || Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        ws.wsUserId = userId;

        // Send joined confirmation with synced playback state
        send(ws, {
          type:        'joined',
          roomId,
          userId,
          memberCount: room.clients.size,
          otherUsers:  [...room.clients].map(c => c.wsUserId).filter(n => n && n !== userId),
          state:       { ...room.state, time: syncedTime(room.state) }
        });

        // Send full chat history to this user
        send(ws, { type: 'chatHistory', messages: room.chatHistory });

        // Broadcast updated user list and system message to all
        broadcastAll(roomId, { type: 'usersList', list: getUserList(roomId), memberCount: room.clients.size });
        systemMsg(roomId, `${userId} joined the room`);
        broadcast(roomId, { type: 'user_joined', userId, memberCount: room.clients.size }, ws);

        console.log(`[Room] ${userId} joined ${roomId} (${room.clients.size} members)`);
        break;
      }

      // ── play ──────────────────────────────────────────────────────
      case 'play': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.state = { time: Number(msg.time) || 0, playing: true, updatedAt: Date.now() };
        broadcast(roomId, { type: 'play', time: room.state.time, userId }, ws);
        break;
      }

      // ── pause ─────────────────────────────────────────────────────
      case 'pause': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.state = { time: Number(msg.time) || 0, playing: false, updatedAt: Date.now() };
        broadcast(roomId, { type: 'pause', time: room.state.time, userId }, ws);
        break;
      }

      // ── seek ──────────────────────────────────────────────────────
      case 'seek': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.state.time      = Number(msg.time) || 0;
        room.state.updatedAt = Date.now();
        broadcast(roomId, { type: 'seek', time: room.state.time, userId }, ws);
        break;
      }

      // ── sync_request (guest asks for current state) ───────────────
      case 'sync_request': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        // Immediately send server-computed time to requesting client
        send(ws, { type: 'sync', state: { ...room.state, time: syncedTime(room.state) } });
        // Also relay to host so it can push its exact currentTime
        broadcast(roomId, { type: 'sync_request', userId }, ws);
        break;
      }

      // ── sync (host responding with exact currentTime) ─────────────
      case 'sync': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room || !msg.state) return;
        // Persist state so late-joiners get correct position
        room.state = {
          time:      Number(msg.state.time) || 0,
          playing:   Boolean(msg.state.playing),
          updatedAt: Date.now()
        };
        broadcast(roomId, { type: 'sync', state: room.state }, ws);
        break;
      }

      // ── chatMessage ───────────────────────────────────────────────
      case 'chat':
      case 'chatMessage': {
        if (!roomId) return;

        if (!checkRate(sid)) {
          send(ws, { type: 'error', msg: 'socket_error_rate_limit' });
          return;
        }

        const raw = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!raw || raw.length > MAX_CHAT_MSG_LEN) {
          send(ws, { type: 'error', msg: 'socket_error_message_invalid' });
          return;
        }

        const msgObj = {
          id:        `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          user:      userId,
          text:      sanitize(raw),
          timestamp: Date.now(),
          type:      'user'
        };

        appendChat(roomId, msgObj);
        broadcastAll(roomId, { type: 'chatMessage', ...msgObj });
        break;
      }

      // ── host_only_mode ────────────────────────────────────────────
      case 'host_only_mode': {
        if (!roomId) return;
        broadcast(roomId, { type: 'host_only_mode', state: Boolean(msg.state), userId }, ws);
        break;
      }

      // ── WebRTC signal ─────────────────────────────────────────────
      case 'signal': {
        if (!roomId || !msg.targetId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const target = [...room.clients].find(c => c.wsUserId === msg.targetId);
        if (target && target.readyState === target.OPEN) {
          target.send(JSON.stringify({ type: 'signal', senderId: userId, signalData: msg.signalData }));
        }
        break;
      }

      // ── heartbeat / ping ──────────────────────────────────────────
      case 'ping':
      case 'heartbeat':
        send(ws, { type: 'heartbeat_ack' });
        break;
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.clients.delete(ws);
    rateLimits.delete(sid);
    console.log(`[Room] ${userId} left ${roomId} (${room.clients.size} members)`);

    if (room.clients.size === 0) {
      // Keep room alive briefly for host page-refresh resilience
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.clients.size === 0) {
          rooms.delete(roomId);
          console.log(`[Room] Deleted empty room ${roomId}`);
        }
      }, EMPTY_ROOM_TTL_MS);
    } else {
      systemMsg(roomId, `${userId} left the room`);
      broadcast(roomId, { type: 'user_left', userId, memberCount: room.clients.size });
      broadcastAll(roomId, { type: 'usersList', list: getUserList(roomId), memberCount: room.clients.size });
    }
  });

  ws.on('error', err => console.error(`[WS] Error (${userId}):`, err.message));
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎬 SyncWatch running on http://localhost:${PORT}\n`));

module.exports = server;