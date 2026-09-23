// The score button shown next to the username, and hiding ("blocking") the
// item's text when it is clicked.

import { CONFIG } from '../config.js';
import { authorLink } from './sites.js';

// Slotted elements only render if they name a slot, so anything inserted next
// to one has to carry the same slot name.
function insertNextTo(ref, node, where) {
  if (ref.slot) node.slot = ref.slot;
  else node.removeAttribute('slot');
  ref[where](node);
}

function placeBadge(item) {
  const link = authorLink(item.el, item);
  if (link) {
    // Step out of Reddit's hover-card wrappers so the badge isn't part of the
    // profile link or its hover trigger.
    let ref = link;
    while (/^faceplate-(hovercard|tracker)$/.test(ref.parentElement?.localName) && ref.parentElement !== item.el) {
      ref = ref.parentElement;
    }
    insertNextTo(ref, item.badge, 'after');
  } else {
    // Cards that don't show a username (e.g. the home feed shows the subreddit).
    insertNextTo(item.textEl, item.badge, 'before');
  }
}

function createBadge(item) {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'rcf-badge';
  badge.addEventListener('click', (e) => {
    // Post cards navigate on click; the badge must not.
    e.preventDefault();
    e.stopPropagation();
    if (item.result) setBlocked(item, !item.blocked);
  });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    badge.addEventListener(type, (e) => e.stopPropagation());
  }
  return badge;
}

export function ensureBadge(item) {
  item.badge ??= createBadge(item);
  if (!item.badge.isConnected) placeBadge(item);
  if (item.blocked && !item.placeholder?.isConnected) setBlocked(item, true);
  return item.badge;
}

function pct(score) {
  return `${Math.round(score * 100)}%`;
}

export function showPending(item) {
  const badge = ensureBadge(item);
  badge.dataset.rcfLevel = 'pending';
  badge.textContent = '…';
  badge.title = 'Reddit Comment Filter: scoring…';
  badge.disabled = true;
}

export function showError(item, message) {
  const badge = ensureBadge(item);
  badge.dataset.rcfLevel = 'error';
  badge.textContent = '!';
  badge.title = `Reddit Comment Filter could not score this:\n${message}`;
  badge.disabled = true;
}

export function showResult(item, result, meta) {
  const badge = ensureBadge(item);
  const { label, score } = result;
  badge.disabled = false;
  badge.dataset.rcfLevel = score >= CONFIG.highScore ? 'high' : score >= CONFIG.midScore ? 'mid' : 'low';
  badge.dataset.rcfScore = score.toFixed(4);
  badge.textContent = `${label} ${pct(score)}`;
  badge.title = [
    `${label}: ${(score * 100).toFixed(1)}% confidence`,
    result.scores.map((s) => `${s.label} ${pct(s.score)}`).join(' · '),
    `${meta.modelId} on ${meta.device}/${meta.dtype}`,
    `Click to ${item.blocked ? 'show' : 'hide'} this ${item.kind}.`,
  ].join('\n');
  if (CONFIG.autoBlockThreshold != null && score >= CONFIG.autoBlockThreshold && item.blocked === undefined) {
    setBlocked(item, true);
  }
}

export function setBlocked(item, blocked) {
  item.blocked = blocked;
  item.textEl.classList.toggle('rcf-hidden', blocked);
  item.badge.classList.toggle('rcf-blocked', blocked);
  item.badge.setAttribute('aria-pressed', String(blocked));
  item.badge.title = item.badge.title.replace(/Click to (show|hide)/, `Click to ${blocked ? 'show' : 'hide'}`);
  if (blocked) {
    if (!item.placeholder) {
      item.placeholder = document.createElement('div');
      item.placeholder.className = 'rcf-placeholder';
      item.placeholder.textContent = `${item.kind === 'post' ? 'Post' : 'Comment'} hidden (${item.badge.textContent}). Click to show.`;
      item.placeholder.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBlocked(item, false);
      });
    }
    if (!item.placeholder.isConnected) insertNextTo(item.textEl, item.placeholder, 'after');
  } else {
    item.placeholder?.remove();
  }
}
