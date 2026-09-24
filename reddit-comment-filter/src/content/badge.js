// What the extension adds to a scored post/comment:
//  - next to the username, a pill with the model's verdict: "Human" (green),
//    "Maybe AI" (yellow) or "AI" (red), by the bands in CONFIG. No
//    percentages are shown. Clicking it collapses/expands the thread.
//  - beside it, AI / Not AI buttons for the reader's own call, saved on this
//    device (votes.js).
//  - a small disclaimer line above the text.
// Flagged items ("Maybe AI" and "AI") start folded: comments collapse their
// thread, posts get a "Show anyway" mask over the title and text (mask.js).

import { CONFIG } from '../config.js';
import { setMasked } from './mask.js';
import { authorLink, insertNextTo, isCollapsed, setCollapsed } from './sites.js';
import { loadVote, saveVote } from './votes.js';

const DISCLAIMER = 'Sorry, this classifier is very early, it can and will be wrong.';

function placeGroup(item) {
  const link = authorLink(item.el, item);
  if (link) {
    // Step out of Reddit's hover-card wrappers so the buttons aren't part of
    // the profile link or its hover trigger.
    let ref = link;
    while (/^faceplate-(hovercard|tracker)$/.test(ref.parentElement?.localName) && ref.parentElement !== item.el) {
      ref = ref.parentElement;
    }
    insertNextTo(ref, item.group, 'after');
  } else {
    // Cards that don't show a username (e.g. the home feed shows the subreddit).
    insertNextTo(item.textEl, item.group, 'before');
  }
}

// Post cards navigate on click; nothing in the group may trigger that.
function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
}

function createGroup(item) {
  const group = document.createElement('span');
  group.className = 'rcf-group';
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    group.addEventListener(type, (e) => e.stopPropagation());
  }

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'rcf-badge';
  badge.addEventListener('click', (e) => {
    swallow(e);
    if (item.result) collapse(item, !isFolded(item));
  });

  const votes = document.createElement('span');
  votes.className = 'rcf-votes';
  votes.hidden = true;
  for (const [value, text] of [
    ['ai', 'AI'],
    ['human', 'Not AI'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rcf-vote';
    button.dataset.rcfVote = value;
    button.textContent = text;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', (e) => {
      swallow(e);
      vote(item, item.vote === value ? null : value);
    });
    votes.append(button);
  }

  group.append(badge, votes);
  Object.assign(item, { group, badge, votes });
}

function showVote(item, value) {
  item.vote = value;
  for (const button of item.votes.querySelectorAll('.rcf-vote')) {
    button.setAttribute('aria-pressed', String(button.dataset.rcfVote === value));
  }
}

async function vote(item, value) {
  const previous = item.vote ?? null;
  item.voteChanged = true;
  showVote(item, value);
  try {
    await saveVote(item, value);
  } catch (err) {
    // e.g. the extension was reloaded under an open tab: don't show a vote
    // that wasn't kept.
    console.warn('[rcf] could not save the vote:', err);
    if (item.vote === value) showVote(item, previous);
  }
}

// Once per item: press the button the reader chose before, unless they've
// already clicked one here.
async function restoreVote(item) {
  if (item.voteLoaded) return;
  item.voteLoaded = true;
  try {
    const saved = await loadVote(item);
    if (saved && !item.voteChanged) showVote(item, saved);
  } catch (err) {
    console.warn('[rcf] could not read saved votes:', err);
  }
}

function levelFor(score) {
  if (score >= CONFIG.aiAt) return 'high';
  if (score > CONFIG.flagAbove) return 'medium';
  return 'low';
}

function isFolded(item) {
  return item.kind === 'post' ? !!item.masked : isCollapsed(item.el);
}

function collapse(item, collapsed) {
  if (item.kind === 'post') {
    // The disclaimer sits between title and text; keep it out of the mask.
    item.note?.classList.toggle('rcf-hidden', collapsed);
    setMasked(item, collapsed, () => collapse(item, false));
  } else {
    setCollapsed(item.el, collapsed);
  }
  item.badge.setAttribute('aria-pressed', String(collapsed));
}

export function ensureBadge(item) {
  if (!item.group) createGroup(item);
  if (!item.group.isConnected) placeGroup(item);
  if (item.note && !item.note.isConnected) insertNextTo(item.textEl, item.note, 'before');
  // Reddit re-rendered a masked post: mask the new title and text.
  if (item.masked && !item.mask?.isConnected) collapse(item, true);
  return item.badge;
}

export function showPending(item) {
  const badge = ensureBadge(item);
  badge.dataset.rcfLevel = 'pending';
  badge.textContent = '…';
  badge.disabled = true;
  item.votes.hidden = true;
}

export function showError(item, message) {
  const badge = ensureBadge(item);
  badge.dataset.rcfLevel = 'error';
  badge.textContent = '!';
  badge.title = `Reddit Comment Filter could not check this:\n${message}`;
  badge.disabled = true;
  item.votes.hidden = true;
}

export function showResult(item, result, meta) {
  const badge = ensureBadge(item);
  const { score } = result;
  item.meta = meta;
  item.level = levelFor(score);
  badge.disabled = false;
  badge.dataset.rcfLevel = item.level;
  badge.dataset.rcfScore = score.toFixed(4); // for tests/debugging; never displayed
  badge.textContent = CONFIG.pillText[item.level];
  badge.setAttribute('aria-pressed', String(isFolded(item)));
  item.votes.hidden = false;
  restoreVote(item);

  if (!item.note) {
    item.note = document.createElement('div');
    item.note.className = 'rcf-note';
    item.note.textContent = DISCLAIMER;
  }
  if (!item.note.isConnected) insertNextTo(item.textEl, item.note, 'before');

  // Once per item, so a thread the reader expanded stays expanded.
  if (!item.autoCollapsed && CONFIG.collapseFlagged && score > CONFIG.flagAbove) {
    item.autoCollapsed = true;
    collapse(item, true);
  }
}
