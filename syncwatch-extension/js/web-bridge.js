'use strict';

// Bridge to sync web app connection to extension
window.addEventListener('message', e => {
  if (e.data && e.data.type === 'SYNCWATCH_WEB_JOIN') {
    chrome.runtime.sendMessage({ 
      action: 'syncFromWeb', 
      roomId: e.data.roomId, 
      userId: e.data.userId,
      isHost: e.data.isHost
    }).catch(() => {});
  }
});
