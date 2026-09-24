// Flagged posts ("Maybe AI" / "AI") are masked rather than collapsed: the
// title and text are blurred and darkened under one overlay reading
// "Show anyway". Clicking it shows the post; the pill masks it again.
//
// The overlay is absolutely positioned over the title and text. It sits in
// Reddit's title slot so it renders inside <shreddit-post>'s shadow layout,
// whose containing block isn't known up front, so its position is measured
// against where it lands and kept in step with a ResizeObserver.

import { insertNextTo } from './sites.js';

const LABEL = 'Show anyway';
const PAD = 6; // px beyond the content, to cover the blur's soft edge

const masked = new Set();
const resize = new ResizeObserver(() => {
  for (const item of masked) place(item);
});

function targets(item) {
  return [item.titleEl, item.textEl].filter((n) => n?.isConnected);
}

function place(item) {
  const { mask } = item;
  if (!mask?.isConnected) return;
  const rects = targets(item)
    .map((n) => n.getBoundingClientRect())
    .filter((r) => r.width || r.height);
  if (!rects.length) return;
  Object.assign(mask.style, { top: '0px', left: '0px', width: '0px', height: '0px' });
  const origin = mask.getBoundingClientRect();
  const top = Math.min(...rects.map((r) => r.top)) - PAD;
  const left = Math.min(...rects.map((r) => r.left)) - PAD;
  const bottom = Math.max(...rects.map((r) => r.bottom)) + PAD;
  const right = Math.max(...rects.map((r) => r.right)) + PAD;
  Object.assign(mask.style, {
    top: `${top - origin.top}px`,
    left: `${left - origin.left}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
  });
  // old.reddit puts the username row between title and text: keep it (and
  // the pill in it) above the mask.
  const meta = item.metaEl?.getBoundingClientRect();
  item.metaEl?.classList.toggle('rcf-above-mask', !!meta && meta.top >= top && meta.bottom <= bottom);
}

function createMask(onShow) {
  const mask = document.createElement('button');
  mask.type = 'button';
  mask.className = 'rcf-mask';
  mask.textContent = LABEL;
  // Post cards navigate on click; the mask must not.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    mask.addEventListener(type, (e) => e.stopPropagation());
  }
  mask.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onShow();
  });
  return mask;
}

export function setMasked(item, on, onShow) {
  item.masked = on;
  const nodes = targets(item);
  for (const n of nodes) n.classList.toggle('rcf-masked', on);
  item.textEl.classList.toggle('rcf-masked-text', on);
  item.el.classList.toggle('rcf-mask-host', on);
  if (on) {
    item.mask ??= createMask(onShow);
    if (!item.mask.isConnected) {
      if (item.titleEl?.isConnected) insertNextTo(item.titleEl, item.mask, 'after');
      else insertNextTo(item.textEl, item.mask, 'before');
    }
    masked.add(item);
    for (const n of [item.el, ...nodes]) resize.observe(n);
    place(item);
  } else {
    item.mask?.remove();
    item.metaEl?.classList.remove('rcf-above-mask');
    masked.delete(item);
    for (const n of [item.el, ...nodes]) resize.unobserve(n);
  }
}
