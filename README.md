# 🎬 SyncWatch — Synchronized Video Watching Extension

Watch any video in perfect sync with friends. Real-time play/pause/seek + drift correction + chat.

---

## 📁 Project Structure

```
syncwatch/
├── backend/
│   ├── package.json
│   └── server.js          ← Node.js + WebSocket server
└── extension/
    ├── manifest.json
    ├── background.js       ← MV3 service worker
    ├── content.js          ← Video sync + overlay UI
    ├── popup.html
    ├── popup.css
    ├── popup.js
    └── icons/
        ├── icon16.png
        ├── icon48.png
        └── icon128.png
```

---

## 🚀 Setup (5 minutes)

### Step 1 — Start the Backend

```bash
cd backend
npm install
npm start
# Server runs at http://localhost:3000
```

You should see:
```
🎬 SyncWatch Server running at http://localhost:3000
```

### Step 2 — Load the Extension in Chrome

1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer Mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Pin the SyncWatch extension to your toolbar

---

## 🎮 How to Use

### Person A (Host):
1. Open any page with a video (YouTube, Vimeo, self-hosted player, etc.)
2. Click the SyncWatch icon
3. Click **Create Room**
4. Copy the 8-character Room ID (e.g. `AB12CD34`)
5. Share it with friends

### Person B (Guest):
1. Open the **same video URL** in their browser
2. Click the SyncWatch icon
3. Paste the Room ID → click **Join**
4. Video syncs automatically!

---

## ✅ Features

| Feature | Details |
|---|---|
| Room system | Create/join via 8-char Room ID |
| Real-time sync | Play, pause, seek broadcast instantly |
| Drift correction | Auto-sync every 5 seconds |
| Video detection | Finds largest `<video>` on page automatically |
| Chat | Floating overlay with live chat |
| Draggable overlay | Drag the chat panel anywhere on screen |
| Session restore | Remembers room when reopening popup |

---

## 🌐 Supported Sites

Works on any page with an HTML5 `<video>` element:
- YouTube (youtube.com)
- Vimeo
- Self-hosted video files
- Most streaming sites with HTML5 players
- Local HTML files with `<video>` tags

> **Note:** Some sites (Netflix, Disney+) use DRM/EME which blocks external control.

---

## 🔧 Configuration

To change the server URL (e.g. for a deployed server):

Edit `extension/content.js`, lines at the top:
```js
const WS_URL  = 'ws://localhost:3000';   // change to wss://yourdomain.com
const API_URL = 'http://localhost:3000'; // change to https://yourdomain.com
```

Edit `extension/popup.js`, line 4:
```js
const API = 'http://localhost:3000'; // change to https://yourdomain.com
```

---

## 🛠 Troubleshooting

| Problem | Fix |
|---|---|
| "Server offline" | Run `npm start` in the `/backend` folder |
| "Cannot inject on this page" | Chrome blocks extension scripts on `chrome://` pages. Open a normal web page first. |
| "Room not found" | The room may have expired (server restarted). Create a new room. |
| Video not detected | Scroll down / interact with the page so the video renders in DOM |
| Overlay not visible | It may be behind the video player. Click the SyncWatch icon to check status. |

---

## 📡 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Server health check |
| `/room/create` | POST | Create a new room → returns `{ roomId }` |
| `/room/:id` | GET | Check if room exists → returns `{ exists }` |

WebSocket events: `join`, `play`, `pause`, `seek`, `sync_request`, `chat`, `heartbeat`
