// Service worker: owns the offscreen document that hosts the audio engine.
// Everything else (capture, decoding, separation, playback) happens in the
// offscreen document or in the YouTube tab's content scripts.

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // WORKERS/BLOBS keep the document alive indefinitely (AUDIO_PLAYBACK alone would be
      // closed after 30 s of silence, which would drop the in-memory session cache).
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Runs the on-device vocal separation model and plays the processed audio in sync with the video.',
    }).catch((e) => {
      // Another caller may have created it in the meantime.
      if (!String(e).includes('Only a single offscreen document')) throw e;
    }).finally(() => { creating = null; });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ensure-offscreen') {
    ensureOffscreenDocument().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  if (msg.type === 'close-offscreen') {
    chrome.offscreen.closeDocument().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

// Helper tabs (fallback when the hidden iframe cannot play): opened muted in the background,
// tracked per opener tab so they never outlive the YouTube tab that asked for them.
const helperTabs = new Map(); // helperTabId -> openerTabId

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'open-helper') {
    const opener = sender.tab;
    chrome.tabs.create({ url: msg.url, active: false, index: opener ? opener.index + 1 : undefined, windowId: opener ? opener.windowId : undefined })
      .then(async (tab) => {
        helperTabs.set(tab.id, opener ? opener.id : null);
        try { await chrome.tabs.update(tab.id, { muted: true }); } catch (e) { /* ignore */ }
        sendResponse({ ok: true, tabId: tab.id });
      }, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'close-helper') {
    helperTabs.delete(msg.tabId);
    chrome.tabs.remove(msg.tabId).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (helperTabs.has(tabId)) { helperTabs.delete(tabId); return; }
  for (const [helperId, openerId] of helperTabs) {
    if (openerId === tabId) { helperTabs.delete(helperId); chrome.tabs.remove(helperId).catch(() => {}); }
  }
});

// The offscreen document has no chrome.storage of its own. Hand settings changes over so a
// session whose controller is already gone still hears that the feature was switched off.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  chrome.runtime.sendMessage({ type: 'global-settings', settings: changes.settings.newValue || {} }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('settings').then(({ settings }) => {
    if (!settings) {
      chrome.storage.local.set({ settings: { enabled: false, vocalLevel: 0, semitones: 0, modelId: 'inst_hq_5', quality: 'high' } });
    }
  });
});
