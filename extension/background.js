// SyncWatch - Background Service Worker (MV3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SyncWatch] Installed');
});

// Only these URL schemes can receive content scripts
function isInjectableUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

// Get the real active tab.
// IMPORTANT: Service workers have NO "current window", so currentWindow:true
// returns nothing. We must use lastFocusedWindow:true instead.
async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) return resolve(tabs[0]);
      // Fallback: any active injectable tab
      chrome.tabs.query({ active: true }, (all) => {
        resolve(all?.find(t => isInjectableUrl(t.url)) || null);
      });
    });
  });
}

// Inject content.js if not already running
async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (r?.alive) return { ok: true };
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 400));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'RELAY_TO_CONTENT') return false;

  (async () => {
    const tab = await getActiveTab();

    if (!tab) {
      sendResponse({ ok: false, error: 'no_tab', hint: 'No active tab found' });
      return;
    }

    if (!isInjectableUrl(tab.url)) {
      sendResponse({
        ok: false,
        error: 'bad_page',
        hint: `Open a webpage with a video first.\nCurrent page: ${tab.url || 'unknown'}`
      });
      return;
    }

    const inject = await ensureContentScript(tab.id);
    if (!inject.ok) {
      sendResponse({ ok: false, error: 'inject_failed', hint: inject.error });
      return;
    }

    try {
      const res = await chrome.tabs.sendMessage(tab.id, msg.payload);
      sendResponse({ ok: true, data: res });
    } catch (e) {
      sendResponse({ ok: false, error: 'msg_failed', hint: e.message });
    }
  })();

  return true;
});
