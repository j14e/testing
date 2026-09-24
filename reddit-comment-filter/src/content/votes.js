// The reader's AI / Not AI votes, kept in chrome.storage.local: on this
// device only, never sent anywhere. One record per post/comment under
// "vote:<id>", so a vote survives reloads and shows again wherever the item
// appears. Un-pressing a vote deletes its record.

import { CONFIG } from '../config.js';

const PREFIX = 'vote:';

// FNV-1a, for items Reddit gives no id.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

// Reddit's id for the item (t1_… comment, t3_… post), else a hash of its text.
export function voteKey(item) {
  return PREFIX + (item.id || `text-${hash(item.text)}`);
}

function permalink(el) {
  const path = el.getAttribute('permalink') ?? el.dataset.permalink;
  try {
    return path ? new URL(path, location.origin).href : null;
  } catch {
    return null;
  }
}

function record(item, vote) {
  const url = permalink(item.el);
  const subreddit =
    item.el.dataset.subreddit ?? (url ?? location.href).match(/\/r\/([^/?#]+)/)?.[1] ?? null;
  const { score } = item.result;
  return {
    vote, // 'ai' | 'human'
    id: item.id ?? null,
    kind: item.kind,
    author: item.author ?? null,
    subreddit,
    url,
    page: location.href,
    // What the model read.
    text: item.text.slice(0, CONFIG.maxChars),
    score,
    verdict: CONFIG.pillText[item.level],
    flagged: score > CONFIG.flagAbove,
    model: item.meta?.modelId ?? null,
    votedAt: new Date().toISOString(),
  };
}

export async function saveVote(item, vote) {
  const key = voteKey(item);
  if (vote) await chrome.storage.local.set({ [key]: record(item, vote) });
  else await chrome.storage.local.remove(key);
}

export async function loadVote(item) {
  const key = voteKey(item);
  return (await chrome.storage.local.get(key))[key]?.vote ?? null;
}
