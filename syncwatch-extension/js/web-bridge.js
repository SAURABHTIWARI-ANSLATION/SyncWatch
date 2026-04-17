'use strict';

// This script bridges the web app's connection state to the Chrome Extension
// so that the extension "knows" when a user starts a session via the web UI.

window.addEventListener('message', e => {
  if (e.data && e.data.type === 'SYNCWATCH_WEB_JOIN') {
    chrome.runtime.sendMessage({ 
      action: 'syncFromWeb', 
      roomId: e.data.roomId, 
      userId: e.data.userId 
    }, () => {
      console.log('[SW Bridge] Sent web connection state to extension background.');
    });
  }
});
