// Service worker: owns the offscreen document that hosts the model. Content
// scripts talk to the offscreen document directly (runtime messages reach every
// extension page), so a slow first model load never depends on this worker
// staying alive.

const OFFSCREEN_PATH = 'offscreen.html';
let creating = null;

async function hasOffscreen() {
  // No documentUrls filter: it matches exact URLs and ours carries ?device=.
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = (async () => {
      // 'auto' | 'webgpu' | 'wasm' - lets you pin a backend from the devtools console:
      //   chrome.storage.local.set({ device: 'wasm' })
      const { device = 'auto' } = await chrome.storage.local.get('device');
      try {
        await chrome.offscreen.createDocument({
          url: `${OFFSCREEN_PATH}?device=${encodeURIComponent(device)}`,
          reasons: ['WORKERS'],
          justification: 'Runs the RoBERTa text classifier locally with WebGPU/WASM.',
        });
      } catch (err) {
        // Lost a race with another tab (e.g. across a worker restart): fine.
        if (!(await hasOffscreen())) throw err;
      }
    })().finally(() => {
      creating = null;
    });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  if (msg.type === 'ensure-offscreen') {
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ error: String(err?.message || err) }),
    );
    return true;
  }
});

// A new device preference only takes effect in a fresh offscreen document.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !('device' in changes)) return;
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
});
