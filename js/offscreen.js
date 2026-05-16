// Manages one AudioContext per tab.
// Audio chain: source → bass → mid → treble → gain → analyser → destination
// All commands arrive via chrome.runtime.onMessage with target === 'offscreen'.

const contexts = new Map(); // tabId → { ctx, source, bass, mid, treble, gain, analyser }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  handle(msg).then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

async function handle(msg) {
  switch (msg.action) {

    case 'connect': {
      teardown(msg.tabId); // release any existing capture slot first

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
        video: false,
      });

      const ctx = new AudioContext();
      // Resume immediately — AudioContext starts suspended under the autoplay policy.
      await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);

      // Bass: low-shelf at 100 Hz
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf'; bass.frequency.value = 100; bass.gain.value = 0;

      // Mid: peaking at 1 kHz
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 1; mid.gain.value = 0;

      // Treble: high-shelf at 8 kHz
      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf'; treble.frequency.value = 8000; treble.gain.value = 0;

      const gain = ctx.createGain();
      gain.gain.value = 1; // start at native equivalent — set-volume fades to target

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;

      source.connect(bass);
      bass.connect(mid);
      mid.connect(treble);
      treble.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);

      const entry = { ctx, source, bass, mid, treble, gain, analyser };
      contexts.set(msg.tabId, entry);

      // Self-clean when the tab navigates or refreshes — the track's 'ended'
      // event fires when Chrome tears down the captured stream.
      stream.getTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (contexts.get(msg.tabId) === entry) teardown(msg.tabId);
        });
      });

      return { success: true };
    }

    case 'set-volume': {
      const c = contexts.get(msg.tabId);
      if (!c) return { success: false, error: 'no-context' };
      const target   = msg.volume / 100;
      const duration = msg.fadeMs !== undefined ? msg.fadeMs / 1000 : 1.5;
      if (msg.fade) {
        c.gain.gain.cancelScheduledValues(c.ctx.currentTime);
        c.gain.gain.setValueAtTime(c.gain.gain.value, c.ctx.currentTime);
        c.gain.gain.linearRampToValueAtTime(target, c.ctx.currentTime + duration);
      } else {
        c.gain.gain.cancelScheduledValues(c.ctx.currentTime);
        c.gain.gain.value = target;
      }
      return { success: true };
    }

    case 'set-eq': {
      const c = contexts.get(msg.tabId);
      if (!c) return { success: false, error: 'no-context' };
      c.bass.gain.value   = msg.bass   ?? 0;
      c.mid.gain.value    = msg.mid    ?? 0;
      c.treble.gain.value = msg.treble ?? 0;
      return { success: true };
    }

    case 'get-analyser': {
      const c = contexts.get(msg.tabId);
      if (!c) return { success: false, data: null };
      const buf = new Uint8Array(c.analyser.frequencyBinCount);
      c.analyser.getByteFrequencyData(buf);
      return { success: true, data: Array.from(buf) };
    }

    case 'get-captured-tabs':
      return { tabIds: [...contexts.keys()] };

    case 'disconnect': {
      const cd = contexts.get(msg.tabId);
      if (cd && msg.fadeMs) {
        // Fade out before tearing down so the handoff back to native audio is smooth.
        cd.gain.gain.cancelScheduledValues(cd.ctx.currentTime);
        cd.gain.gain.setValueAtTime(cd.gain.gain.value, cd.ctx.currentTime);
        cd.gain.gain.linearRampToValueAtTime(0, cd.ctx.currentTime + msg.fadeMs / 1000);
        await new Promise(r => setTimeout(r, msg.fadeMs));
      }
      teardown(msg.tabId);
      return { success: true };
    }

    case 'ping':
      return { alive: true };

    default:
      return { success: false, error: `unknown action: ${msg.action}` };
  }
}

function teardown(tabId) {
  const c = contexts.get(tabId);
  if (!c) return;
  // Stop media tracks so Chrome releases the tab's capture slot.
  try { c.source.mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { c.ctx.close(); } catch (_) {}
  contexts.delete(tabId);
}
