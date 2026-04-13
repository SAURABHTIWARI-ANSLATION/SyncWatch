# SyncWatch 🎬

> Real-time video sync for friends — watch together with play/pause/seek sync, live chat, and screen sharing.

## Project Structure

```
syncwatch-backend/
├── server.js          ← Node.js + Express + WebSocket server
├── package.json
├── .gitignore
└── public/
    ├── index.html     ← Web client (served for /join/:roomId)
    ├── script.js      ← WebSocket + WebRTC client logic
    └── style.css      ← Dark-themed UI
```

## How It Works

| Component | Tech | Role |
|---|---|---|
| Backend | Node.js + ws | Manages rooms, relays sync events + WebRTC signals |
| Web Client | Vanilla JS | Friends open this in browser to watch together |
| Extension | Chrome MV3 | Host installs this to control sync from any video site |

## API

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Health check — `{ status: "ok", rooms: N }` |
| `/room/create` | POST | Create a new room → `{ roomId: "AB12CD34" }` |
| `/room/:id` | GET | Check if room exists → `{ exists: true/false }` |
| `/join/:id` | GET | Serves web client HTML (SPA) |

## WebSocket Messages

### Client → Server
```json
{ "type": "join",         "roomId": "AB12CD34" }
{ "type": "play",         "time": 42.5 }
{ "type": "pause",        "time": 42.5 }
{ "type": "seek",         "time": 120.0 }
{ "type": "chat",         "text": "Hello!" }
{ "type": "sync_request"                   }
{ "type": "signal",       "targetId": "abc123", "signalData": {...} }
{ "type": "heartbeat"                      }
```

### Server → Client
```json
{ "type": "joined",    "roomId": "...", "userId": "...", "memberCount": 2, "state": {...} }
{ "type": "play",      "time": 42.5,   "userId": "..." }
{ "type": "pause",     "time": 42.5,   "userId": "..." }
{ "type": "seek",      "time": 120.0,  "userId": "..." }
{ "type": "sync",      "state": { "time": 42.5, "playing": true } }
{ "type": "chat",      "text": "...",  "userId": "...", "ts": 1234567890 }
{ "type": "user_joined","userId": "...", "memberCount": 3 }
{ "type": "user_left", "userId": "...", "memberCount": 2 }
{ "type": "signal",    "senderId": "...", "signalData": {...} }
{ "type": "error",     "msg": "Room not found..." }
```

## Deploy on Render.com

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Click **Deploy** — your URL will be `https://your-app.onrender.com`

## Use with Chrome Extension

1. Open `syncwatch-extension/` folder in Chrome → `chrome://extensions` → Load unpacked
2. Go to any video site (YouTube, Netflix, etc.)
3. Click the **▶ SyncWatch** icon → **Create Room**
4. Share the Room Code or Invite Link with friends
5. Friends open `https://your-render-url/join/ROOMCODE` in their browser

## Local Development

```bash
npm install
npm start
# Server running at http://localhost:3000
```

Then open `http://localhost:3000/join/TEST1234` in multiple tabs to test.
