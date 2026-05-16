// Service worker: routes popup messages, manages offscreen audio doc,
// auto-reconnects on tab navigation, and keeps the service worker alive.

const OFFSCREEN_URL = chrome.runtime.getURL('html/offscreen.html');

// Tabs whose gain has been explicitly zeroed via the per-tab mute button.
// autoConnect skips volume restoration for these so the mute survives tab switches.
const mutedTabs = new Set();

// Tracks the last known URL per tab so we can distinguish a real navigation
// (domain changed or page reloaded) from a SPA URL update (same domain, no reload).
const tabLastUrl = new Map();

// ── Offscreen document lifecycle ──────────────────────────────────────────────

let _creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (_creatingOffscreen) { await _creatingOffscreen; return; }
  _creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Tab audio capture and volume-adjusted playback'
  });
  await _creatingOffscreen;
  _creatingOffscreen = null;
}

// Poll until the offscreen document's message listener is live.
// The stream ID expires in seconds, so we must confirm readiness BEFORE fetching it.
async function waitForOffscreenReady(maxMs = 4000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'ping' });
      if (res?.alive) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Offscreen document did not become ready');
}

async function toOffscreen(payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
}

// ── Service worker keepalive ──────────────────────────────────────────────────

// Create the keepalive alarm on install AND on every browser startup, since
// alarms can be lost if the browser force-terminates the service worker.
chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // ~24 s
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('html/onboarding.html') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
  // Re-apply saved settings for the active tab when the browser starts fresh.
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.url) await autoConnect(active.id, active.url);
  } catch (_) {}
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'keepAlive') return;
  chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(ctxs => {
    if (ctxs.length) chrome.runtime.sendMessage({ target: 'offscreen', action: 'ping' }).catch(() => {});
  });
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // let offscreen handle its own
  dispatch(msg).then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

async function dispatch(msg) {
  switch (msg.action) {

    // Connect tab audio capture.
    // Disconnect any live stream FIRST — Chrome allows only one capture per tab.
    // Ensure offscreen is ready BEFORE fetching stream ID — ID expires in seconds.
    case 'connect': {
      await toOffscreen({ action: 'disconnect', tabId: msg.tabId }).catch(() => {});
      await ensureOffscreen();
      await waitForOffscreenReady();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId });
      return chrome.runtime.sendMessage({ target: 'offscreen', action: 'connect', tabId: msg.tabId, streamId });
    }

    // Apply volume. Badge is set first so it always reflects the slider value
    // even if the offscreen audio context is temporarily unavailable.
    case 'set-volume': {
      await setBadge(msg.tabId, msg.volume).catch(() => {});
      return toOffscreen({ action: 'set-volume', tabId: msg.tabId, volume: msg.volume, fade: msg.fade, fadeMs: msg.fadeMs })
        .catch(err => ({ success: false, error: err.message }));
    }

    case 'set-eq':
      return toOffscreen({
        action: 'set-eq',
        tabId: msg.tabId,
        bass:   msg.bass   ?? 0,
        mid:    msg.mid    ?? 0,
        treble: msg.treble ?? 0,
      }).catch(err => ({ success: false, error: err.message }));

    case 'get-analyser':
      return toOffscreen({ action: 'get-analyser', tabId: msg.tabId })
        .catch(() => ({ success: false, data: null }));

    case 'disconnect':
      await clearBadge(msg.tabId).catch(() => {});
      return toOffscreen({ action: 'disconnect', tabId: msg.tabId, fadeMs: msg.fadeMs }).catch(() => ({ success: true }));

    // ── Storage ──

    case 'get-domain-settings': {
      const store = await chrome.storage.local.get('domains-settings');
      const all = store['domains-settings'] || {};
      return { settings: all[msg.domain] || null };
    }

    case 'save-domain-settings': {
      const store = await chrome.storage.local.get('domains-settings');
      const all = store['domains-settings'] || {};
      all[msg.domain] = msg.settings;
      await chrome.storage.local.set({ 'domains-settings': all });
      return { success: true };
    }

    case 'delete-domain-settings': {
      const store = await chrome.storage.local.get('domains-settings');
      const all = store['domains-settings'] || {};
      delete all[msg.domain];
      await chrome.storage.local.set({ 'domains-settings': all });
      return { success: true };
    }

    case 'get-muted-tabs':
      return { tabIds: [...mutedTabs] };

    case 'get-all-domains': {
      const store = await chrome.storage.local.get('domains-settings');
      return { domains: store['domains-settings'] || {} };
    }

    case 'get-global-settings': {
      const store = await chrome.storage.local.get('global-settings');
      return {
        settings: store['global-settings'] || {
          darkMode: false, defaultVolume: 100, autoApply: true, autoMuteNewTabs: false
        }
      };
    }

    case 'save-global-settings':
      await chrome.storage.local.set({ 'global-settings': msg.settings });
      return { success: true };

    // ── Per-tab mute ──
    // For captured tabs (audio runs through our gain node): zero/restore the gain.
    // For uncaptured tabs: use native browser mute.
    case 'mute-tab': {
      const { tabId: mutTabId, muted } = msg;
      if (muted) {
        mutedTabs.add(mutTabId);
      } else {
        mutedTabs.delete(mutTabId);
      }
      const captured = await toOffscreen({ action: 'get-captured-tabs' }).catch(() => ({ tabIds: [] }));
      if ((captured.tabIds || []).includes(mutTabId)) {
        if (muted) {
          await toOffscreen({ action: 'set-volume', tabId: mutTabId, volume: 0, fade: true, fadeMs: 150 });
        } else {
          const store  = await chrome.storage.local.get(['domains-settings', 'global-settings']);
          const tab    = await chrome.tabs.get(mutTabId).catch(() => null);
          const domain = tab ? getDomain(tab.url) : null;
          const volume = (domain && (store['domains-settings'] || {})[domain]?.volume)
                      ?? store['global-settings']?.defaultVolume ?? 100;
          await toOffscreen({ action: 'set-volume', tabId: mutTabId, volume, fade: true, fadeMs: 150 });
          await setBadge(mutTabId, volume);
        }
      } else {
        await chrome.tabs.update(mutTabId, { muted }).catch(() => {});
      }
      return { success: true };
    }

    // ── Mute / unmute all ──
    // For captured tabs: zero the gain in the audio chain (no audible gap).
    // For all other audible tabs: use native browser mute.

    case 'mute-all': {
      const [capturedRes, audibleTabs] = await Promise.all([
        toOffscreen({ action: 'get-captured-tabs' }).catch(() => ({ tabIds: [] })),
        chrome.tabs.query({ audible: true }),
      ]);
      const capturedIds  = new Set(capturedRes.tabIds || []);
      const audibleIds   = new Set(audibleTabs.map(t => t.id));

      // Only mute captured tabs that are currently audible
      const capturedAudible = [...capturedIds].filter(id => audibleIds.has(id));
      await Promise.all(capturedAudible.map(tabId =>
        toOffscreen({ action: 'set-volume', tabId, volume: 0, fade: true, fadeMs: 150 }).catch(() => {})
      ));

      // Native mute on audible tabs not going through our audio chain
      const nativeMute = audibleTabs.filter(t => !capturedIds.has(t.id));
      await Promise.all(nativeMute.map(t => chrome.tabs.update(t.id, { muted: true })));

      // Track only audible muted tabs so get-muted-tabs reflects them correctly
      for (const tabId of capturedAudible) mutedTabs.add(tabId);
      for (const t of nativeMute) mutedTabs.add(t.id);

      return { success: true, count: capturedAudible.length + nativeMute.length };
    }

    case 'unmute-all': {
      const [capturedRes, nativeMutedTabs] = await Promise.all([
        toOffscreen({ action: 'get-captured-tabs' }).catch(() => ({ tabIds: [] })),
        chrome.tabs.query({ muted: true }),
      ]);
      const capturedIds = new Set(capturedRes.tabIds || []);

      // Restore saved (or default) volume on captured tabs
      const store = await chrome.storage.local.get(['domains-settings', 'global-settings']);
      const domainMap  = store['domains-settings'] || {};
      const defaultVol = store['global-settings']?.defaultVolume ?? 100;

      await Promise.all([...capturedIds].map(async tabId => {
        try {
          const tab = await chrome.tabs.get(tabId);
          const domain = getDomain(tab.url);
          const volume = (domain && domainMap[domain]?.volume) ?? defaultVol;
          await toOffscreen({ action: 'set-volume', tabId, volume, fade: false });
        } catch (_) {}
      }));

      // Native unmute on the rest
      const nativeUnmute = nativeMutedTabs.filter(t => !capturedIds.has(t.id));
      await Promise.all(nativeUnmute.map(t => chrome.tabs.update(t.id, { muted: false })));

      // Clear all tracked muted tabs
      mutedTabs.clear();

      return { success: true };
    }

    default:
      return { success: false, error: `unknown action: ${msg.action}` };
  }
}

// ── Auto-reconnect on tab navigation / tab switch ─────────────────────────────

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return null; }
}

// Apply saved volume/EQ for a tab, reusing the existing audio context when possible.
// Fast-path: if the offscreen already has a context for this tab, just update the
// gain — no disconnect/reconnect, no gap at native volume.
// Full-path: capture the tab and build a fresh audio chain.
async function autoConnect(tabId, url) {
  const domain = getDomain(url);
  if (!domain) return;

  const store = await chrome.storage.local.get(['domains-settings', 'global-settings']);
  const domainSettings = (store['domains-settings'] || {})[domain];
  const globalSettings = store['global-settings'] || {};

  const volume = domainSettings?.volume ?? globalSettings.defaultVolume ?? 100;
  const eq     = domainSettings?.eq;
  const hasEQ  = eq && (eq.bass !== 0 || eq.mid !== 0 || eq.treble !== 0);

  // Nothing non-default to apply — don't bother capturing
  if (volume === 100 && !hasEQ) return;

  // If the user explicitly muted this tab, don't restore volume on tab switch.
  if (mutedTabs.has(tabId)) {
    const existing = await toOffscreen({ action: 'set-volume', tabId, volume: 0, fade: false }).catch(() => null);
    if (existing?.success) return; // already captured and muted — leave it
    // No context yet — fall through to full connect, then re-zero below
  }

  // Fast-path: try to set volume on an existing context for this tab.
  // This avoids a full capture cycle and eliminates the native-volume spike/dip.
  const targetVol = mutedTabs.has(tabId) ? 0 : volume;
  const existing = await toOffscreen({ action: 'set-volume', tabId, volume: targetVol, fade: false }).catch(() => null);
  if (existing?.success) {
    if (!mutedTabs.has(tabId) && hasEQ) await toOffscreen({ action: 'set-eq', tabId, ...eq }).catch(() => {});
    await setBadge(tabId, targetVol);
    return;
  }

  // Full-path: no existing context — capture and build the audio chain.
  try {
    await ensureOffscreen();
    await waitForOffscreenReady();
    const streamId  = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'connect', tabId, streamId });
    const applyVol  = mutedTabs.has(tabId) ? 0 : volume;
    await toOffscreen({ action: 'set-volume', tabId, volume: applyVol, fade: !mutedTabs.has(tabId) });
    if (!mutedTabs.has(tabId) && hasEQ) await toOffscreen({ action: 'set-eq', tabId, ...eq });
    await setBadge(tabId, applyVol);
  } catch (_) { /* tab not capturable, popup already capturing, etc. */ }
}

// When a tab finishes loading, reconnect audio if needed.
// For SPA navigations (same domain, no true reload), the stream is still alive
// so we skip the disconnect to avoid a native-volume spike on every URL change.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const prevUrl    = tabLastUrl.get(tabId);
  const prevDomain = prevUrl ? getDomain(prevUrl) : null;
  const newDomain  = getDomain(tab.url);
  tabLastUrl.set(tabId, tab.url);

  const isSameDomain = prevDomain && prevDomain === newDomain;

  // Only tear down the audio context on a real navigation (domain changed or first load).
  // SPA URL changes within the same domain leave the stream intact.
  if (!isSameDomain) {
    await toOffscreen({ action: 'disconnect', tabId }).catch(() => {});
    await clearBadge(tabId).catch(() => {});
  }

  // Only auto-reconnect the currently active tab
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active || active.id !== tabId) return;
    await autoConnect(tabId, tab.url);
  } catch (_) {}
});

// When the user switches tabs, apply saved settings using the fast-path when possible.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await autoConnect(tabId, tab.url);
  } catch (_) {}
});

// Mute newly created tabs if the user has enabled that setting.
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    const store    = await chrome.storage.local.get('global-settings');
    const settings = store['global-settings'] || {};
    if (!settings.autoMuteNewTabs) return;
    await chrome.tabs.update(tab.id, { muted: true });
    mutedTabs.add(tab.id);
  } catch (_) {}
});

// Keyboard shortcut: toggle mute on the currently active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-mute-tab') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    const isMuted = mutedTabs.has(tab.id);
    if (isMuted) {
      mutedTabs.delete(tab.id);
    } else {
      mutedTabs.add(tab.id);
    }
    const captured = await toOffscreen({ action: 'get-captured-tabs' }).catch(() => ({ tabIds: [] }));
    if ((captured.tabIds || []).includes(tab.id)) {
      if (!isMuted) {
        await toOffscreen({ action: 'set-volume', tabId: tab.id, volume: 0, fade: true, fadeMs: 150 });
      } else {
        const store  = await chrome.storage.local.get(['domains-settings', 'global-settings']);
        const domain = getDomain(tab.url);
        const volume = (domain && (store['domains-settings'] || {})[domain]?.volume)
                    ?? store['global-settings']?.defaultVolume ?? 100;
        await toOffscreen({ action: 'set-volume', tabId: tab.id, volume, fade: true, fadeMs: 150 });
        await setBadge(tab.id, volume);
      }
    } else {
      await chrome.tabs.update(tab.id, { muted: !isMuted }).catch(() => {});
    }
  } catch (_) {}
});

// ── Badge helpers ─────────────────────────────────────────────────────────────

// Mirrors the popup's getVolumeColor() so the badge background matches the number color.
function getBadgeColor(volume) {
  if (volume === 0)   return '#e53935';
  if (volume <= 100)  return '#6c63ff';
  const t   = (volume - 100) / 500;
  const hue = Math.round(38 * (1 - t));
  const sat = Math.round(90 + 10 * t);
  const lig = Math.round(55 - 5 * t);
  return `hsl(${hue}, ${sat}%, ${lig}%)`;
}

async function setBadge(tabId, volume) {
  const rounded = Math.round(volume);
  const text  = rounded === 100 ? '' : `${rounded}%`;
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setBadgeBackgroundColor({ color: getBadgeColor(volume), tabId });
}

async function clearBadge(tabId) {
  await chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
}

// ── Cleanup on tab close ──────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  mutedTabs.delete(tabId);
  toOffscreen({ action: 'disconnect', tabId }).catch(() => {});
});
