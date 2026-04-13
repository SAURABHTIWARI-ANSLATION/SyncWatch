const express = require('express');
const http = require('http');
const path = require('path');

const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// In-memory room store
const rooms = new Map();

// FIX: Auto-cleanup rooms that are empty for > 2 hours to prevent stale rooms
// causing "2 watching" ghost count issues
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.clients.size === 0 && (now - room.createdAt) > 2 * 60 * 60 * 1000) {
      rooms.delete(id);
      console.log(`[Room] Auto-cleaned stale room: ${id}`);
    }
  }
}, 10 * 60 * 1000); // check every 10 minutes

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// Create a new room
app.post('/room/create', (req, res) => {
  const roomId = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
  rooms.set(roomId, {
    clients: new Set(),
    createdAt: Date.now(),
    state: { time: 0, playing: false, updatedAt: Date.now() }
  });
  console.log(`[Room] Created: ${roomId}`);
  res.json({ roomId });
});

// Check if room exists
app.get('/room/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  res.json({ exists: rooms.has(id) });
});

// Join route for web client — serves the SPA
// FIX: This must come BEFORE the static middleware catch-all
app.get('/join/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Utility: send to single client
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Utility: broadcast to all in room except sender
function broadcast(roomId, msg, exclude = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const raw = JSON.stringify(msg);
  room.clients.forEach(client => {
    if (client !== exclude && client.readyState === 1) client.send(raw);
  });
}

wss.on('connection', (ws, req) => {
  let roomId = null;
  const userId = uuidv4().slice(0, 6);
  ws.wsUserId = userId;

  // FIX: Log connection origin for debugging cross-origin WebSocket issues
  const origin = req.headers['origin'] || 'unknown';
  console.log(`[WS] New connection from origin: ${origin}, userId: ${userId}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const id = (msg.roomId || '').toUpperCase();
        const room = rooms.get(id);

        // FIX: If the room doesn't exist, auto-create it for web clients
        // This handles the race condition where a room gets deleted between
        // the HTTP /room/:id check and the WebSocket join
        if (!room) {
          // Check if this looks like a valid room ID attempt (8 chars)
          if (id.length === 8) {
            // Room was deleted or expired — inform the client clearly
            send(ws, { type: 'error', msg: `Room "${id}" not found or has expired. Ask the host to create a new room.` });
          } else {
            send(ws, { type: 'error', msg: 'Invalid Room ID format.' });
          }
          return;
        }

        roomId = id;
        room.clients.add(ws);

        // Calculate elapsed time for live sync
        const elapsed = room.state.playing
          ? (Date.now() - room.state.updatedAt) / 1000
          : 0;
        const syncedTime = room.state.time + elapsed;

        const otherUserIds = [...room.clients]
          .map(c => c.wsUserId)
          .filter(uid => uid && uid !== userId);

        send(ws, {
          type: 'joined',
          roomId,
          userId,
          memberCount: room.clients.size,
          otherUsers: otherUserIds,
          state: { ...room.state, time: syncedTime }
        });

        broadcast(roomId, { type: 'user_joined', userId, memberCount: room.clients.size }, ws);
        console.log(`[Room] ${userId} joined ${roomId} (${room.clients.size} members)`);
        break;
      }

      case 'play': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.state = { time: Number(msg.time) || 0, playing: true, updatedAt: Date.now() };
        broadcast(roomId, { type: 'play', time: room.state.time, userId }, ws);
        break;
      }

      case 'pause': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.state = { time: Number(msg.time) || 0, playing: false, updatedAt: Date.now() };
        broadcast(roomId, { type: 'pause', time: room.state.time, userId }, ws);
        break;
      }

      case 'seek': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.state.time = Number(msg.time) || 0;
        room.state.updatedAt = Date.now();
        broadcast(roomId, { type: 'seek', time: room.state.time, userId }, ws);
        break;
      }

      case 'sync_request': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const elapsed = room.state.playing
          ? (Date.now() - room.state.updatedAt) / 1000
          : 0;
        send(ws, {
          type: 'sync',
          state: { ...room.state, time: room.state.time + elapsed }
        });
        break;
      }

      case 'chat': {
        if (!roomId || typeof msg.text !== 'string') return;
        const text = msg.text.slice(0, 300).trim();
        if (!text) return;
        broadcast(roomId, { type: 'chat', text, userId, ts: Date.now() }, ws);
        break;
      }

      case 'heartbeat':
        send(ws, { type: 'heartbeat_ack' });
        break;

      case 'signal': {
        if (!roomId || !msg.targetId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const targetClient = [...room.clients].find(c => c.wsUserId === msg.targetId);
        if (targetClient && targetClient.readyState === 1) {
          targetClient.send(JSON.stringify({
            type: 'signal',
            senderId: userId,
            signalData: msg.signalData
          }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.clients.delete(ws);
    console.log(`[Room] ${userId} left ${roomId} (${room.clients.size} members)`);
    if (room.clients.size === 0) {
      // FIX: Don't immediately delete the room — keep it for 30 seconds
      // so the host can rejoin if they accidentally disconnect/refresh
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.clients.size === 0) {
          rooms.delete(roomId);
          console.log(`[Room] Deleted empty room: ${roomId}`);
        }
      }, 30000);
    } else {
      broadcast(roomId, { type: 'user_left', userId, memberCount: room.clients.size });
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for ${userId}:`, err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 SyncWatch Server running at http://localhost:${PORT}\n`);
});