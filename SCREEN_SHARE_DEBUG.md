# Screen Share Debugging Guide

## Fixes Applied

### 1. **Enhanced Logging** ✅
- Added detailed console logging throughout the screen sharing flow
- Track streamId generation, WebRTC peer creation, ICE candidates, and connection states
- All logs prefixed with `[SW Content]`, `[BG]`, or `[WC]` for easy filtering

### 2. **WebRTC Guest Implementation** ✅
- Extension users (guests) can now receive screen shares via WebRTC
- Added `ontrack` handler to receive remote streams
- Floating video overlay displays the host's screen share (top-right corner)
- Guests can hide/show the remote video without disconnecting

### 3. **Better Error Handling** ✅
- Pre-flight checks before starting screen share (must be in a room)
- Better error messages displayed in chat overlay
- Audio capture failures are non-critical (warn instead of error)
- Connection state changes trigger user-friendly notifications

### 4. **Improved Signaling** ✅
- ICE candidate queue draining with logging
- Better peer connection state tracking
- Track addition verification before sending offers

## How to Test

### Prerequisites
1. Load the extension in Chrome (Developer Mode → Load unpacked)
2. Start the backend server: `cd backend && npm start`
3. Open console (F12) in all test tabs to view logs

### Test Scenario 1: Extension Host → Web Client Guest

**Host (Extension):**
1. Navigate to YouTube (or any video page)
2. Open extension popup → Create/Join a room
3. Wait for "Video attached ✓" message
4. Click "Share Screen" button in overlay
5. Select "Tab", "Window", or "Screen" in Chrome picker
6. Check console logs:
   ```
   [BG] Starting screen share, requestingTabId: XXX
   [BG] Calling chooseDesktopMedia for tab: XXX
   [BG] chooseDesktopMedia callback, streamId: XXX
   [SW Content] Starting capture with streamId: XXX
   [SW Content] Stream obtained, tracks: 1
   [SW Content] Creating offers for X targets
   ```

**Guest (Web Browser):**
1. Open: `https://syncwatch-o4za.onrender.com/join/{ROOM_ID}`
2. Should see "Waiting for host to share screen"
3. When host starts sharing, should see:
   ```
   [WC] Handling signal from: XXX
   [WC] Creating new peer for: XXX
   [WC] Received remote track from: XXX
   [WC] Live screen share connected!
   ```
4. Remote video should replace YouTube player

### Test Scenario 2: Extension Host → Extension Guest

**Host:** Same as Scenario 1

**Guest (Extension):**
1. Navigate to any webpage (different tab)
2. Join the same room via extension popup
3. When host starts sharing:
   ```
   [SW Content] Handling signal from: XXX
   [SW Content] Creating new peer for: XXX
   [SW Content] Received remote track from: XXX
   [SW Content] 🎥 Receiving screen share from host!
   ```
4. Floating video appears in top-right corner
5. Can click ✕ to hide (doesn't disconnect)

### Test Scenario 3: Video Sync + Screen Share

1. Host starts screen share
2. Play/pause/seek the underlying video
3. Guest should see both:
   - Screen share video (floating or replacing player)
   - Synced video playback controls

## Common Issues & Debugging

### Issue: "Screen share cancelled or permission denied"
**Cause:** User didn't select anything in Chrome picker
**Fix:** Try again and actually click a tab/window/screen to share

### Issue: "No valid tab found for screen sharing"
**Cause:** No active tab or on chrome:// pages
**Fix:** Navigate to a regular webpage (http/https)

### Issue: "You must join a room before sharing"
**Cause:** Tried to share without joining a room
**Fix:** Create or join a room first via extension popup

### Issue: Screen capture starts but guests don't see it
**Check:**
1. Console logs for WebRTC signaling errors
2. ICE connection state (should be "connected")
3. Both host and guest in same room
4. Check if offers/answers are being exchanged:
   ```
   [SW Content] Offer sent to XXX
   [WC] Setting remote description (offer)
   [WC] Sending answer
   ```

### Issue: Video is black or frozen
**Check:**
1. `[SW Content] Stream obtained, tracks: X` (should be ≥1)
2. ICE connection state in console
3. Try sharing a different tab/window
4. Check if video track ended: `[SW Content] Video track ended by user`

### Issue: Audio not working
**Note:** Audio capture is optional and may fail silently
**Check:**
```
[SW Content] Audio tracks added: X
```
If 0, audio capture failed (non-critical)

## Console Log Filters

To debug specific parts of the flow:

**Host-side capture:**
```
filter: [SW Content]
```

**Background service worker:**
```
filter: [BG]
```

**Web client guest:**
```
filter: [WC]
```

**WebRTC signaling:**
```
filter: signal OR offer OR answer OR ICE
```

## Architecture Notes

### Screen Share Flow
1. User clicks "Share Screen" in content script overlay
2. Content script → background: `CONTENT_START_SHARE`
3. Background calls `chrome.desktopCapture.chooseDesktopMedia()`
4. Background → content script: `BG_START_CAPTURE` with streamId
5. Content script calls `getUserMedia()` with streamId
6. Content script creates WebRTC offers for all room members
7. Offers routed through background → server → guests
8. Guests send answers back through same path
9. ICE candidates exchanged
10. Peer connection established, stream received

### Key Components
- **content.js**: Host-side capture + guest-side receive (extension users)
- **background.js**: Desktop capture API + message routing
- **script.js**: Web client guest-side receive (web users)
- **server.js**: WebSocket signaling server

## Next Steps if Issues Persist

1. **Check Chrome permissions:**
   - Extension has `desktopCapture` permission in manifest
   - Tab permission granted when picker appears

2. **Test with localhost:**
   - Change `WS_URL` in background.js to `ws://localhost:3000`
   - Run backend locally for easier debugging

3. **Check TURN servers:**
   - Using openrelay.metered.ca (free, may be unreliable)
   - Consider adding more STUN/TURN servers if behind strict NAT

4. **Browser compatibility:**
   - Works in Chrome/Edge (Chromium-based)
   - Firefox may need different desktopCapture approach

## Files Modified
- `/extension/content.js` - Enhanced capture, guest receive, logging
- `/extension/background.js` - Better logging in startScreenShare
- `/backend/public/script.js` - Improved WebRTC logging
