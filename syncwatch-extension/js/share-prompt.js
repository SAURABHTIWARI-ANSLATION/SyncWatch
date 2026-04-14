// ─────────────────────────────────────────────────────────────────
// SyncWatch — Share Prompt (User Gesture Handler)
// ─────────────────────────────────────────────────────────────────
'use strict';

document.getElementById('btn-start').addEventListener('click', () => {
  // We need to know which tab requested the share
  const params = new URLSearchParams(window.location.search);
  const tabId = parseInt(params.get('tabId'));

  if (!tabId) {
    alert('Error: No target tab found.');
    window.close();
    return;
  }

  // desktopCapture REQUIRES a user gesture context - this window provide it!
  chrome.desktopCapture.chooseDesktopMedia(
    ['screen', 'window', 'tab', 'audio'],
    (streamId) => {
      if (chrome.runtime.lastError) {
        console.error('[SW Prompt] Capture error:', chrome.runtime.lastError);
      }
      
      // Send the streamId back to the background script
      chrome.runtime.sendMessage({
        sw: 'internal',
        action: 'shareIdCaptured',
        tabId: tabId,
        streamId: streamId
      });

      // Close this transient window
      setTimeout(() => window.close(), 100);
    }
  );
});
