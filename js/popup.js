// Popup UI — runs in the extension popup context.

let currentTabId  = null;
let currentDomain = null;
let isConnected   = false;
let currentVolume = 100;
let analyserTimer  = null;
let audioTabsTimer = null;
let globalSettings = { darkMode: false, defaultVolume: 100, autoApply: true, autoMuteNewTabs: false };

// ── Messaging ─────────────────────────────────────────────────────────────────

function msg(action, extra = {}) {
  return chrome.runtime.sendMessage({ action, ...extra });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getDomain(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch (_) { return null; }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function showToast(text) {
  const el = document.querySelector('.toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Volume slider ─────────────────────────────────────────────────────────────

// Smoothly blends from the default text color (≤100) through orange to bright
// red (600) using HSL interpolation across the 100–600 range.
function getVolumeColor(v) {
  if (v <= 100) return '';
  const t   = (v - 100) / 500;           // 0..1
  const hue = Math.round(38 * (1 - t));  // 38 (orange) → 0 (red)
  const sat = Math.round(90 + 10 * t);   // 90% → 100%
  const lig = Math.round(55 - 5 * t);    // 55% → 50%
  return `hsl(${hue}, ${sat}%, ${lig}%)`;
}

function setSlider(value) {
  const v      = clamp(value, 0, 600);
  const slider = document.getElementById('volume-slider');
  slider.value = v;
  slider.style.setProperty('--pct', `${(v / 600) * 100}%`);
  slider.setAttribute('aria-valuetext', `${Math.round(v)} percent`);
  document.getElementById('volume-value').textContent = Math.round(v);
  document.querySelector('.volume-display').style.color = getVolumeColor(v);
  // Easter egg
  document.getElementById('nice-banner')?.classList.toggle('show', Math.round(v) === 69);
}

// ── Domain badge ──────────────────────────────────────────────────────────────

function showDomainBadge(type) {
  const badge = document.getElementById('domain-status');
  badge.className = 'domain-badge';
  if (type === 'saved') { badge.textContent = 'Auto-applied'; badge.classList.add('saved'); }
  else if (type === 'new') { badge.textContent = 'New site'; badge.classList.add('new'); }
  else { badge.textContent = ''; }
}

// ── EQ ───────────────────────────────────────────────────────────────────────

const EQ_PRESETS = {
  flat:  { bass: 0,  mid:  0, treble:  0 },
  bass:  { bass: 8,  mid:  0, treble:  1 },
  vocal: { bass: -2, mid:  6, treble:  2 },
  night: { bass: 2,  mid: -1, treble: -5 },
};

// Live EQ values — source of truth for readEQ() / writeEQ()
const eqValues = { bass: 0, mid: 0, treble: 0 };

const EQ_MIN = -12, EQ_MAX = 12;
const TRACK_H = 200, THUMB_R = 9;

function fmtDB(v) {
  const n = parseFloat(v);
  return (n > 0 ? '+' : '') + n.toFixed(n % 1 === 0 ? 0 : 1) + ' dB';
}

// Convert a dB value to the thumb's CSS top (px). top=0 = max, top=TRACK_H = min.
function valToTopPx(val) {
  const t = 1 - (val - EQ_MIN) / (EQ_MAX - EQ_MIN);
  return t * (TRACK_H - THUMB_R * 2) + THUMB_R;
}

// Convert a raw Y offset (px relative to track top) to a snapped dB value.
function yToVal(relY) {
  const y   = Math.max(THUMB_R, Math.min(TRACK_H - THUMB_R, relY));
  const t   = 1 - (y - THUMB_R) / (TRACK_H - THUMB_R * 2);
  const raw = t * (EQ_MAX - EQ_MIN) + EQ_MIN;
  return Math.round(raw / 0.5) * 0.5; // snap to nearest 0.5 dB
}

function renderEQSlider(band, val) {
  const track = document.getElementById(`eq-${band}`);
  if (!track) return;
  const thumb  = track.querySelector('.eq-thumb');
  const fill   = track.querySelector('.eq-fill');
  const valOut = document.getElementById(`eq-${band}-val`);

  const thumbTop  = valToTopPx(val);
  const centerTop = valToTopPx(0);           // y position of 0 dB
  const fillTop    = Math.min(thumbTop, centerTop);
  const fillHeight = Math.abs(thumbTop - centerTop);

  thumb.style.top    = `${thumbTop}px`;
  fill.style.top     = `${fillTop}px`;
  fill.style.height  = `${Math.max(1, fillHeight)}px`;

  valOut.textContent = fmtDB(val);
  track.setAttribute('aria-valuenow',  val);
  track.setAttribute('aria-valuetext', `${val} decibels`);
}

function readEQ() { return { ...eqValues }; }

function writeEQ(eq) {
  eqValues.bass   = eq.bass   ?? 0;
  eqValues.mid    = eq.mid    ?? 0;
  eqValues.treble = eq.treble ?? 0;
  ['bass', 'mid', 'treble'].forEach(b => renderEQSlider(b, eqValues[b]));
  syncPresetButtons(eq);
}

function syncPresetButtons(eq) {
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    const p = EQ_PRESETS[btn.dataset.preset];
    const matches = p && p.bass === eq.bass && p.mid === eq.mid && p.treble === eq.treble;
    btn.classList.toggle('active', matches);
    btn.setAttribute('aria-pressed', String(matches));
  });
}

// Attach drag + keyboard handlers to all three custom EQ tracks.
function initEQSliders() {
  ['bass', 'mid', 'treble'].forEach(band => {
    const track = document.getElementById(`eq-${band}`);
    if (!track) return;

    function applyClientY(clientY) {
      const rect = track.getBoundingClientRect();
      const val  = yToVal(clientY - rect.top);
      if (val === eqValues[band]) return;
      eqValues[band] = val;
      renderEQSlider(band, val);
      applyEQ();
    }

    track.addEventListener('mousedown', e => {
      e.preventDefault();
      applyClientY(e.clientY);
      const onMove = e => applyClientY(e.clientY);
      const onUp   = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    track.addEventListener('keydown', e => {
      const step = e.shiftKey ? 3 : 0.5;
      let val = eqValues[band];
      if      (e.key === 'ArrowUp')   val = Math.min(EQ_MAX, val + step);
      else if (e.key === 'ArrowDown') val = Math.max(EQ_MIN, val - step);
      else return;
      eqValues[band] = val;
      renderEQSlider(band, val);
      applyEQ();
      e.preventDefault();
    });

    // Scroll anywhere in the band column (value label + track + band label) to
    // adjust the level — much easier to target than the 6 px track alone.
    const bandEl = track.closest('.eq-band');
    (bandEl || track).addEventListener('wheel', e => {
      e.preventDefault();
      const step  = e.shiftKey ? 3 : 0.5;
      const delta = e.deltaY < 0 ? step : -step;
      const val   = Math.max(EQ_MIN, Math.min(EQ_MAX, eqValues[band] + delta));
      if (val === eqValues[band]) return;
      eqValues[band] = val;
      renderEQSlider(band, val);
      applyEQ();
    }, { passive: false });
  });
}

async function applyEQ() {
  const eq = readEQ();
  syncPresetButtons(eq);
  if (await ensureConnected()) await msg('set-eq', { tabId: currentTabId, ...eq });
  await saveDomain();
}

// Reconnect the audio pipeline on demand — called when the user makes an
// adjustment after a disconnect (e.g. after "Reset to 100%" cleared the capture).
async function ensureConnected() {
  if (isConnected) return true;
  try {
    const connectRes = await msg('connect', { tabId: currentTabId });
    if (connectRes?.success === false) return false;
    isConnected = true;
    document.getElementById('analyser-canvas').style.display = 'block';
    return true;
  } catch (_) {
    return false;
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function saveDomain() {
  if (!currentDomain) return;
  await msg('save-domain-settings', {
    domain: currentDomain,
    settings: { volume: currentVolume, eq: readEQ() },
  });
}

// ── Domains tab ───────────────────────────────────────────────────────────────

async function renderDomains() {
  const { domains } = await msg('get-all-domains');
  const list    = document.getElementById('domains-list');
  const entries = Object.entries(domains).sort(([a], [b]) => a.localeCompare(b));

  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">No saved domains yet.<br>Adjust volume on any site to save it.</div>';
    return;
  }

  list.innerHTML = '';
  for (const [domain, settings] of entries) {
    const item = document.createElement('div');
    item.className = 'domain-item';
    item.setAttribute('role', 'listitem');

    const info = document.createElement('div');
    info.className = 'domain-info';
    info.innerHTML = `<div class="domain-item-name">${domain}</div>`;

    const volIn = document.createElement('input');
    volIn.type = 'number'; volIn.className = 'volume-edit';
    volIn.min = 0; volIn.max = 600; volIn.value = Math.round(settings.volume);
    volIn.setAttribute('aria-label', `Volume for ${domain}`);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.setAttribute('aria-label', `Save volume for ${domain}`);
    saveBtn.addEventListener('click', async () => {
      const v = clamp(parseInt(volIn.value) || 100, 0, 600);
      volIn.value = v;
      await msg('save-domain-settings', { domain, settings: { ...settings, volume: v } });
      item.querySelector('.domain-item-vol').textContent = `${v}%`;
      showToast(`Saved ${domain} → ${v}%`);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn'; delBtn.title = 'Remove'; delBtn.textContent = '✕';
    delBtn.setAttribute('aria-label', `Remove saved volume for ${domain}`);
    delBtn.addEventListener('click', async () => {
      await msg('delete-domain-settings', { domain });
      item.remove();
      if (!list.children.length)
        list.innerHTML = '<div class="empty-state">No saved domains yet.<br>Adjust volume on any site to save it.</div>';
    });

    const actions = document.createElement('div');
    actions.className = 'domain-item-actions';
    actions.append(volIn, saveBtn, delBtn);
    item.append(info, actions);
    list.appendChild(item);
  }
}

// ── Analyser visualiser ───────────────────────────────────────────────────────

function startAnalyser() {
  const canvas = document.getElementById('analyser-canvas');
  const ctx    = canvas.getContext('2d');

  analyserTimer = setInterval(async () => {
    if (!isConnected) return;
    const res = await msg('get-analyser', { tabId: currentTabId }).catch(() => null);
    if (!res?.data) return;

    const { data } = res;
    const W = canvas.width, H = canvas.height;
    const isDark = document.body.classList.contains('dark');

    ctx.clearRect(0, 0, W, H);

    const bw = W / data.length;
    data.forEach((v, i) => {
      const h   = (v / 255) * H;
      const hue = 220 + (i / data.length) * 60;
      ctx.fillStyle = `hsl(${hue},70%,58%)`;
      ctx.fillRect(i * bw, H - h, Math.max(1, bw - 1), h);
    });
  }, 80);
}

// ── Audio tabs list ───────────────────────────────────────────────────────

// SVG icons for the per-tab mute button
const SVG_SOUND = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>`;
const SVG_MUTED = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;

// Tracks which tabs we've gain-muted so the button state survives re-renders.
// The service worker never sets tab.mutedInfo for gain-muted tabs, so we must
// keep our own record.
const tabMuteState = new Map();

// Fingerprint of the last rendered state — used to skip re-renders when nothing
// changed, which prevents hover state from blinking on the 2 s poll interval.
let _audioTabsFingerprint = '';

async function renderAudioTabs() {
  const [tabs, mutedRes] = await Promise.all([
    chrome.tabs.query({ audible: true }).catch(() => []),
    msg('get-muted-tabs').catch(() => ({ tabIds: [] })),
  ]);

  // Sync service-worker mute state into our local Map so the icon is correct
  // when the popup is freshly opened (local Map was empty).
  const serverMuted = new Set(mutedRes.tabIds || []);
  for (const [id, isMuted] of tabMuteState) {
    // Remove stale entries — tab was unmuted while popup was closed
    if (isMuted && !serverMuted.has(id)) tabMuteState.delete(id);
  }
  serverMuted.forEach(id => {
    if (!tabMuteState.has(id)) tabMuteState.set(id, true);
  });

  // Build a state fingerprint. If it matches the last render, skip DOM rebuild
  // so hover/focus state on existing rows is never interrupted by the poll timer.
  const fingerprint = tabs.map(t => {
    const muted = tabMuteState.has(t.id) ? tabMuteState.get(t.id) : !!t.mutedInfo?.muted;
    return `${t.id}:${t.title}:${muted}`;
  }).join('|') || 'empty';

  const section = document.getElementById('audio-tabs-section');
  const list    = document.getElementById('audio-tabs-list');

  if (!tabs.length) {
    if (_audioTabsFingerprint !== 'empty') {
      _audioTabsFingerprint = 'empty';
      section.style.display = 'none';
    }
    return;
  }

  if (fingerprint === _audioTabsFingerprint) return; // nothing changed — leave DOM alone
  _audioTabsFingerprint = fingerprint;

  section.style.display = '';
  list.innerHTML = '';

  for (const tab of tabs) {
    const row = document.createElement('div');
    row.className = 'audio-tab-item';
    row.setAttribute('role', 'listitem');

    // Left: favicon + title + arrow — clicking switches to that tab
    const link = document.createElement('button');
    link.setAttribute('aria-label', `Switch to ${tab.title || 'tab'}`);
    link.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;color:inherit;font:inherit;min-width:0;padding:0;text-align:left;overflow:hidden;';
    link.addEventListener('click', () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    });

    if (tab.favIconUrl) {
      const img = document.createElement('img');
      img.className = 'audio-tab-favicon';
      img.src = tab.favIconUrl;
      img.alt = '';
      img.onerror = () => img.remove();
      link.appendChild(img);
    }

    const title = document.createElement('span');
    title.className = 'audio-tab-title';
    title.textContent = tab.title || tab.url || 'Unknown tab';
    link.appendChild(title);

    const arrow = document.createElement('span');
    arrow.className = 'audio-tab-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    link.appendChild(arrow);

    // Right: per-tab mute button.
    // isMuted prefers our tracked state over tab.mutedInfo (which is never set
    // for gain-muted captured tabs), so the button survives re-renders correctly.
    const isMuted = tabMuteState.has(tab.id)
      ? tabMuteState.get(tab.id)
      : !!tab.mutedInfo?.muted;

    const muteBtn = document.createElement('button');
    muteBtn.className = `audio-tab-mute${isMuted ? ' muted' : ''}`;
    muteBtn.innerHTML = isMuted ? SVG_MUTED : SVG_SOUND;
    muteBtn.title     = isMuted ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-label', isMuted ? `Unmute ${tab.title}` : `Mute ${tab.title}`);

    muteBtn.addEventListener('click', async () => {
      const wasMuted = tabMuteState.get(tab.id) ?? !!tab.mutedInfo?.muted;
      const nowMuted = !wasMuted;
      // Update local state immediately so re-renders preserve the new state
      tabMuteState.set(tab.id, nowMuted);
      muteBtn.classList.toggle('muted', nowMuted);
      muteBtn.innerHTML = nowMuted ? SVG_MUTED : SVG_SOUND;
      muteBtn.title     = nowMuted ? 'Unmute' : 'Mute';
      const res = await msg('mute-tab', { tabId: tab.id, muted: nowMuted });
      if (!res?.success) {
        tabMuteState.set(tab.id, wasMuted); // revert on failure
        muteBtn.classList.toggle('muted', wasMuted);
        muteBtn.innerHTML = wasMuted ? SVG_MUTED : SVG_SOUND;
        muteBtn.title     = wasMuted ? 'Unmute' : 'Mute';
      }
    });

    row.append(link, muteBtn);
    list.appendChild(row);
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(targetTab) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === targetTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-content').forEach(panel => {
    const active = panel.id === `tab-${targetTab}`;
    panel.classList.toggle('active', active);
    panel.tabIndex = active ? 0 : -1;
  });
  if (targetTab === 'domains') renderDomains();
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Load global settings
  const { settings } = await msg('get-global-settings');
  globalSettings = settings;
  applyGlobalSettings();

  // Identify current tab / domain
  const [tab]   = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId   = tab.id;
  currentDomain  = getDomain(tab.url);
  document.getElementById('current-domain').textContent = currentDomain || 'No domain';

  // Look up saved settings for this domain
  let saved = null;
  if (currentDomain) {
    const res = await msg('get-domain-settings', { domain: currentDomain });
    saved = res.settings;
  }

  // Determine starting volume and EQ
  const startVol = (saved && globalSettings.autoApply) ? saved.volume : (globalSettings.defaultVolume ?? 100);
  currentVolume  = startVol;
  setSlider(startVol);

  // Validate stored EQ format (old format used filterType; new uses bass/mid/treble)
  const savedEQ = (saved?.eq && typeof saved.eq.bass === 'number') ? saved.eq : null;
  writeEQ(savedEQ ?? EQ_PRESETS.flat);

  // Respect mute state: if the service worker has this tab gain-muted, keep it at 0
  // so reopening the popup doesn't silently restore volume.
  const mutedRes = await msg('get-muted-tabs').catch(() => ({ tabIds: [] }));
  const isTabMuted = (mutedRes.tabIds || []).includes(currentTabId);
  const applyVol = isTabMuted ? 0 : startVol;

  // Only capture when there's something non-default to apply. Skipping capture
  // when volume=100 and EQ is flat prevents the tab capture indicator appearing
  // on popup open when no adjustments have been made (or after "Reset to 100%").
  const eqIsFlat = !savedEQ || (savedEQ.bass === 0 && savedEQ.mid === 0 && savedEQ.treble === 0);
  const needsCapture = isTabMuted || applyVol !== 100 || !eqIsFlat;

  let connected = false;

  // Connect whenever the popup opens on a real page — this keeps the visualizer
  // working at 100%/flat EQ. The capture indicator only shows while the popup is
  // open; we disconnect on popup close if nothing non-default is active.
  if (currentDomain) {
    // Fast-path: reuse an existing audio context if one is already running.
    try {
      const fp = await msg('set-volume', { tabId: currentTabId, volume: applyVol, fade: false });
      if (fp?.success) {
        connected = true;
        if (!isTabMuted && savedEQ) await msg('set-eq', { tabId: currentTabId, ...savedEQ });
      }
    } catch (_) {}

    // Full connect if no existing context.
    if (!connected) {
      try {
        const connectRes = await msg('connect', { tabId: currentTabId });
        if (connectRes?.success === false) throw new Error(connectRes.error || 'connect failed');
        connected = true;
        await msg('set-volume', { tabId: currentTabId, volume: applyVol, fade: true, fadeMs: 80 });
        if (!isTabMuted && savedEQ) await msg('set-eq', { tabId: currentTabId, ...savedEQ });
      } catch (err) {
        console.warn('Audio connect failed:', err.message);
        document.getElementById('current-domain').title = `Audio unavailable: ${err.message}`;
      }
    }
  }

  isConnected = connected;
  if (connected) {
    showDomainBadge(saved ? 'saved' : 'new');
    document.getElementById('analyser-canvas').style.display = 'block';
  }

  setupEvents();
  if (isConnected) startAnalyser();
  renderDomains();
  renderAudioTabs();
  audioTabsTimer = setInterval(renderAudioTabs, 2000);
}

function applyGlobalSettings() {
  document.body.classList.toggle('dark', !!globalSettings.darkMode);
  document.getElementById('dark-mode-toggle').checked      = !!globalSettings.darkMode;
  document.getElementById('auto-apply-toggle').checked     = globalSettings.autoApply !== false;
  document.getElementById('auto-mute-new-tabs').checked    = !!globalSettings.autoMuteNewTabs;
  document.getElementById('default-volume').value          = globalSettings.defaultVolume ?? 100;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function setupEvents() {
  // ── Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Volume slider
  const slider = document.getElementById('volume-slider');
  slider.addEventListener('input', async () => {
    currentVolume = parseFloat(slider.value);
    setSlider(currentVolume);
    const wasConnected = isConnected;
    if (await ensureConnected()) {
      // On first connect, gain starts at 1.0 (native equivalent) and ramps to target
      // over 80ms — smooths the routing handoff from native to captured audio.
      // On subsequent changes, 30ms is short enough to feel instant but removes harsh pops.
      const fadeMs = wasConnected ? 30 : 80;
      await msg('set-volume', { tabId: currentTabId, volume: currentVolume, fade: true, fadeMs });
    }
    await saveDomain();
  });
  slider.addEventListener('wheel', e => {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    slider.value = clamp(parseFloat(slider.value) + (e.deltaY < 0 ? step : -step), 0, 600);
    slider.dispatchEvent(new Event('input'));
  }, { passive: false });

  // ── Reset / clear
  document.getElementById('reset-btn').addEventListener('click', async () => {
    currentVolume = 100;
    setSlider(100);
    if (isConnected) {
      await msg('set-volume', { tabId: currentTabId, volume: 100, fade: true, fadeMs: 150 });
    }
    await saveDomain();
  });

  document.getElementById('clear-domain-btn').addEventListener('click', async () => {
    if (!currentDomain) return;
    await msg('delete-domain-settings', { domain: currentDomain });

    // Reset live volume and EQ to defaults
    const defaultVol = globalSettings.defaultVolume ?? 100;
    currentVolume = defaultVol;
    setSlider(defaultVol);
    writeEQ(EQ_PRESETS.flat);

    if (isConnected) {
      await msg('set-volume', { tabId: currentTabId, volume: defaultVol, fade: true, fadeMs: 150 });
      await msg('set-eq', { tabId: currentTabId, bass: 0, mid: 0, treble: 0 });
    }

    showDomainBadge('new');
    showToast('Cleared saved settings for this site');
  });

  // ── EQ sliders (custom drag-based, set up here so DOM is guaranteed ready)
  initEQSliders();

  // ── EQ presets
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      writeEQ(EQ_PRESETS[btn.dataset.preset]);
      applyEQ();
    });
  });

  // ── Mute-all toggle
  let allMuted = false;
  const muteBtn      = document.getElementById('mute-all-btn');
  const muteFeedback = document.getElementById('mute-feedback');
  let muteFeedbackTimer = null;

  function showMuteFeedback(text) {
    muteFeedback.textContent = text;
    muteFeedback.classList.add('show');
    clearTimeout(muteFeedbackTimer);
    muteFeedbackTimer = setTimeout(() => muteFeedback.classList.remove('show'), 2200);
  }

  muteBtn.addEventListener('click', async () => {
    if (!allMuted) {
      const res   = await msg('mute-all');
      const count = res.count ?? 0;
      showMuteFeedback(count ? `Muted ${count} tab${count > 1 ? 's' : ''}` : 'No audible tabs');
      allMuted = true;
      muteBtn.setAttribute('aria-label', 'Unmute all tabs');
      muteBtn.classList.add('active');
      // Sync individual tab buttons to show muted state
      const audibleTabs = await chrome.tabs.query({ audible: true }).catch(() => []);
      for (const tab of audibleTabs) tabMuteState.set(tab.id, true);
      _audioTabsFingerprint = '';
      renderAudioTabs();
    } else {
      await msg('unmute-all');
      showMuteFeedback('Unmuted all');
      allMuted = false;
      muteBtn.setAttribute('aria-label', 'Mute all audible tabs');
      muteBtn.classList.remove('active');
      // Explicitly mark all audible tabs as unmuted so renderAudioTabs never
      // falls back to the (potentially stale) mutedInfo from the browser tab API.
      const audibleTabs = await chrome.tabs.query({ audible: true }).catch(() => []);
      tabMuteState.clear();
      for (const tab of audibleTabs) tabMuteState.set(tab.id, false);
      _audioTabsFingerprint = '';
      renderAudioTabs();
    }
  });

  // ── Settings
  document.getElementById('dark-mode-toggle').addEventListener('change', async e => {
    globalSettings.darkMode = e.target.checked;
    document.body.classList.toggle('dark', globalSettings.darkMode);
    await msg('save-global-settings', { settings: globalSettings });
  });

  document.getElementById('auto-apply-toggle').addEventListener('change', async e => {
    globalSettings.autoApply = e.target.checked;
    await msg('save-global-settings', { settings: globalSettings });
  });

  document.getElementById('auto-mute-new-tabs').addEventListener('change', async e => {
    globalSettings.autoMuteNewTabs = e.target.checked;
    await msg('save-global-settings', { settings: globalSettings });
  });

  document.getElementById('default-volume').addEventListener('change', async e => {
    globalSettings.defaultVolume = clamp(parseInt(e.target.value) || 100, 0, 600);
    e.target.value = globalSettings.defaultVolume;
    await msg('save-global-settings', { settings: globalSettings });
  });

  // ── Export / import
  document.getElementById('export-btn').addEventListener('click', async () => {
    const [{ domains }, { settings: savedGlobal }] = await Promise.all([
      msg('get-all-domains'),
      msg('get-global-settings'),
    ]);
    const exportData = {
      version:        1,
      globalSettings: savedGlobal,
      domains,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: 'volumehub-settings.json'
    });
    a.click(); URL.revokeObjectURL(a.href);
    const dc = Object.keys(domains).length;
    showToast(`Exported ${dc} domain${dc !== 1 ? 's' : ''} + global settings`);
  });

  document.getElementById('import-btn').addEventListener('click', () =>
    document.getElementById('import-file').click()
  );

  document.getElementById('import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());

      // New format: { version, globalSettings, domains }
      // Legacy format: flat object of domain → settings (no version key)
      const isNewFormat   = parsed.version !== undefined;
      const domains       = isNewFormat ? (parsed.domains       || {}) : parsed;
      const importedGlobal = isNewFormat ? (parsed.globalSettings || null) : null;

      // Merge domains into existing
      const { domains: existing } = await msg('get-all-domains');
      await chrome.storage.local.set({ 'domains-settings': { ...existing, ...domains } });

      // Restore global settings if present, then re-apply to UI
      if (importedGlobal) {
        globalSettings = { ...globalSettings, ...importedGlobal };
        await msg('save-global-settings', { settings: globalSettings });
        applyGlobalSettings();
      }

      renderDomains();
      const dc = Object.keys(domains).length;
      const parts = [`${dc} domain${dc !== 1 ? 's' : ''}`];
      if (importedGlobal) parts.push('global settings');
      showToast(`Imported ${parts.join(' + ')}`);
    } catch (_) { showToast('Invalid JSON file'); }
    e.target.value = '';
  });

  // ── Keyboard shortcuts (when focus is not inside an input/select)
  document.addEventListener('keydown', e => {
    if (['SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const slider = document.getElementById('volume-slider');
    const step   = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight':
        slider.value = clamp(parseFloat(slider.value) + step, 0, 600);
        slider.dispatchEvent(new Event('input')); e.preventDefault(); break;
      case 'ArrowDown': case 'ArrowLeft':
        slider.value = clamp(parseFloat(slider.value) - step, 0, 600);
        slider.dispatchEvent(new Event('input')); e.preventDefault(); break;
      case '0': slider.value = 0;   slider.dispatchEvent(new Event('input')); break;
      case '1': slider.value = 100; slider.dispatchEvent(new Event('input')); break;
      case '2': slider.value = 200; slider.dispatchEvent(new Event('input')); break;
      case '3': slider.value = 300; slider.dispatchEvent(new Event('input')); break;
      case '4': slider.value = 400; slider.dispatchEvent(new Event('input')); break;
      case '5': slider.value = 500; slider.dispatchEvent(new Event('input')); break;
      case '6': slider.value = 600; slider.dispatchEvent(new Event('input')); break;
    }
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

window.addEventListener('unload', () => {
  clearInterval(analyserTimer);
  clearInterval(audioTabsTimer);
  // If nothing non-default is active, disconnect on popup close so the tab
  // capture indicator doesn't linger after the popup is gone.
  if (isConnected && currentVolume === 100) {
    const eq = readEQ();
    const eqIsFlat = eq.bass === 0 && eq.mid === 0 && eq.treble === 0;
    if (eqIsFlat) {
      chrome.runtime.sendMessage({ action: 'disconnect', tabId: currentTabId }).catch(() => {});
    }
  }
});

init().catch(console.error);
