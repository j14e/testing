// Content script: finds posts/comments near the viewport, sends the ones longer
// than CONFIG.minWords to the local model, and puts the score next to the
// username.

import { CONFIG } from '../config.js';
import { ensureBadge, showError, showPending, showResult } from './badge.js';
import { ITEM_SELECTOR, itemText, readItem, wordCount } from './sites.js';

const items = new WeakMap(); // item element -> state
const byObserved = new WeakMap(); // observed text element -> state
const resultsByText = new Map(); // text -> {result, meta}; survives Reddit re-rendering an item
const MAX_CACHED = 2000;
const near = new Set(); // unscored states whose text is within rootMargin of the viewport
let pumping = false;
let fatalError = null;

const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const item = byObserved.get(entry.target);
      if (!item) continue;
      if (entry.isIntersecting) near.add(item);
      else near.delete(item);
    }
    pump();
  },
  { rootMargin: CONFIG.rootMargin },
);

function observe(item) {
  byObserved.set(item.textEl, item);
  io.observe(item.textEl);
}

function register(el) {
  let item = items.get(el);
  if (item) {
    // Reddit re-renders parts of items (e.g. after voting or "load more");
    // re-attach to the new text node and put the badge back.
    if (!item.textEl.isConnected) {
      const info = readItem(el);
      if (!info) return;
      io.unobserve(item.textEl);
      near.delete(item);
      Object.assign(item, info);
      if (item.placeholder) item.placeholder.remove();
      if (item.badge) item.badge.remove();
      if (item.status !== 'done') observe(item);
    }
    if (item.result && !item.badge?.isConnected) ensureBadge(item);
    return;
  }
  const info = readItem(el);
  if (!info) return; // no body yet; a later mutation will bring us back
  item = { el, ...info, status: 'new', text: null, result: null };
  items.set(el, item);
  observe(item);
}

// Items in view first (top to bottom), then the ones just outside it.
function distanceFromViewport(item) {
  const r = item.textEl.getBoundingClientRect();
  if (r.bottom < 0) return -r.bottom + 1e6; // above: after everything below at equal distance
  if (r.top > innerHeight) return r.top - innerHeight;
  return 0;
}

function takeBatch() {
  const ready = [];
  for (const item of near) {
    if (item.status === 'done' || item.status === 'pending') {
      near.delete(item);
      continue;
    }
    // Read text lazily: only for items close to the screen.
    const text = itemText(item);
    if (text !== item.text) {
      item.text = text;
      item.words = wordCount(text);
    }
    if (item.words <= CONFIG.minWords) {
      item.status = 'short'; // stays observed in case it's edited/expanded later
      near.delete(item);
      continue;
    }
    const cached = resultsByText.get(item.text);
    if (cached) {
      applyResult(item, cached);
      near.delete(item);
      continue;
    }
    ready.push(item);
  }
  ready.sort((a, b) => distanceFromViewport(a) - distanceFromViewport(b));
  return ready.slice(0, CONFIG.batchSize);
}

function applyResult(item, { result, meta }) {
  item.status = 'done';
  item.result = result;
  showResult(item, result, meta);
  io.unobserve(item.textEl);
}

let offscreenReady = null;
function ensureOffscreen() {
  offscreenReady ??= chrome.runtime
    .sendMessage({ target: 'background', type: 'ensure-offscreen' })
    .then((r) => {
      if (r?.error) throw new Error(r.error);
    })
    .catch((err) => {
      offscreenReady = null;
      throw err;
    });
  return offscreenReady;
}

async function classify(texts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureOffscreen();
    const resp = await chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'classify', texts })
      .catch(() => undefined);
    if (resp) return resp;
    offscreenReady = null; // the offscreen document went away; recreate it once
  }
  throw new Error('The model host did not respond.');
}

async function pump() {
  if (pumping || fatalError) return;
  pumping = true;
  try {
    for (let batch = takeBatch(); batch.length; batch = takeBatch()) {
      for (const item of batch) {
        item.status = 'pending';
        near.delete(item);
        showPending(item);
      }
      let resp;
      try {
        resp = await classify(batch.map((item) => item.text.slice(0, CONFIG.maxChars)));
      } catch (err) {
        resp = { error: String(err?.message || err) };
      }
      if (resp.error) {
        // The model can't load (missing files, no backend): say so on the
        // badges instead of retrying forever.
        fatalError = resp.error;
        console.warn('[rcf]', resp.error);
        for (const item of batch) showError(item, resp.error);
        return;
      }
      const meta = { modelId: resp.modelId, device: resp.device, dtype: resp.dtype };
      batch.forEach((item, i) => {
        const entry = { result: resp.results[i], meta };
        resultsByText.set(item.text, entry);
        if (resultsByText.size > MAX_CACHED) resultsByText.delete(resultsByText.keys().next().value);
        if (item.el.isConnected) applyResult(item, entry);
        else item.status = 'new';
      });
    }
  } finally {
    pumping = false;
  }
}

// Reddit is a single-page app with infinite scroll and lazily loaded replies:
// pick up items as they're added.
const pendingRoots = new Set();
let scanQueued = false;

function scan() {
  scanQueued = false;
  for (const root of pendingRoots) {
    if (!root.isConnected) continue;
    if (root.matches(ITEM_SELECTOR)) register(root);
    for (const el of root.querySelectorAll(ITEM_SELECTOR)) register(el);
    // A body or header rendered into an item that's already on the page.
    const owner = root.parentElement?.closest(ITEM_SELECTOR);
    if (owner) register(owner);
  }
  pendingRoots.clear();
}

new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE || node.classList.contains('rcf-badge') || node.classList.contains('rcf-placeholder')) continue;
      pendingRoots.add(node);
    }
  }
  if (pendingRoots.size && !scanQueued) {
    scanQueued = true;
    setTimeout(scan, 50);
  }
}).observe(document.documentElement, { childList: true, subtree: true });

pendingRoots.add(document.documentElement);
scan();
