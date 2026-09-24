// Where posts and comments live in Reddit's DOM, for the current front end
// (www / sh.reddit.com: <shreddit-post>, <shreddit-comment> web components with
// slotted light-DOM content) and old.reddit.com (.thing elements).

const SHREDDIT_POST = 'shreddit-post';
const SHREDDIT_COMMENT = 'shreddit-comment';
const OLD_POST = '.thing.link';
const OLD_COMMENT = '.thing.comment';

export const ITEM_SELECTOR = [SHREDDIT_POST, SHREDDIT_COMMENT, OLD_POST, OLD_COMMENT].join(', ');
// Elements this extension inserts. Some carry Reddit's slot names (so they
// render inside shadow roots) and must never be mistaken for Reddit's own.
export const OURS = '.rcf-group, .rcf-note, .rcf-mask';
const USER_LINK = 'a[href*="/user/"], a[href*="/u/"]';

// First descendant matching `selector` that belongs to `item` itself rather
// than to a nested reply.
function own(item, selector) {
  for (const node of item.querySelectorAll(selector)) {
    if (node.closest(ITEM_SELECTOR) === item && !node.closest(OURS)) return node;
  }
  return null;
}

// Slotted elements only render if they name a slot, so anything inserted next
// to one has to carry the same slot name.
export function insertNextTo(ref, node, where) {
  if (ref.slot) node.slot = ref.slot;
  else node.removeAttribute('slot');
  ref[where](node);
}

const ADAPTERS = [
  {
    matches: (el) => el.localName === SHREDDIT_COMMENT,
    read: (el) => ({
      kind: 'comment',
      id: el.getAttribute('thingid'),
      author: el.getAttribute('author'),
      title: '',
      titleEl: null,
      textEl:
        el.querySelector(`:scope > [slot="comment"]:not(${OURS})`) ?? own(el, '[id$="-comment-rtjson-content"]'),
      // Newer markup nests the header in layout divs rather than slotting it directly.
      metaEl: el.querySelector(':scope > [slot="commentMeta"]') ?? own(el, '[slot="commentMeta"]'),
    }),
  },
  {
    matches: (el) => el.localName === SHREDDIT_POST,
    read: (el) => ({
      kind: 'post',
      id: el.getAttribute('id'),
      author: el.getAttribute('author'),
      title: el.getAttribute('post-title') ?? own(el, '[slot="title"]')?.textContent ?? '',
      // <a> in feeds, <h1> on the post's own page.
      titleEl: own(el, '[slot="title"]'),
      textEl: own(el, '[slot="text-body"]') ?? own(el, '[id$="-post-rtjson-content"]'),
      metaEl: own(el, '[slot="credit-bar"]'),
    }),
  },
  {
    matches: (el) => el.matches(OLD_COMMENT),
    read: (el) => {
      const entry = el.querySelector(':scope > .entry');
      return {
        kind: 'comment',
        id: el.dataset.fullname ?? null,
        author: el.dataset.author ?? null,
        title: '',
        titleEl: null,
        textEl: entry?.querySelector('.usertext-body .md') ?? null,
        metaEl: entry?.querySelector('.tagline') ?? null,
      };
    },
  },
  {
    matches: (el) => el.matches(OLD_POST),
    read: (el) => {
      const entry = el.querySelector(':scope > .entry');
      return {
        kind: 'post',
        id: el.dataset.fullname ?? null,
        author: el.dataset.author ?? null,
        title: entry?.querySelector('a.title')?.textContent ?? '',
        titleEl: entry?.querySelector('p.title') ?? null,
        // Self-text; on listing pages it only exists once the post is expanded.
        textEl: entry?.querySelector('.expando .usertext-body .md') ?? null,
        metaEl: entry?.querySelector('.tagline') ?? null,
      };
    },
  },
];

// Returns {kind, id, author, title, titleEl, textEl, metaEl} or null when the item has
// no text body (link/image posts, bodies not rendered yet).
export function readItem(el) {
  const adapter = ADAPTERS.find((a) => a.matches(el));
  const info = adapter?.read(el);
  return info?.textEl ? info : null;
}

// Quotes, code and tables are left out: the detector was trained on text with
// them stripped (its model card's clean_text), and they aren't the author's
// own prose anyway.
const SKIP = `blockquote, pre, code, table, script, style, ${OURS}`;
const BREAKS = /^(p|div|li|ul|ol|h[1-6]|br|hr|tr)$/;

function proseText(root) {
  const parts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) parts.push(n.data);
    else if (BREAKS.test(n.localName)) parts.push(' ');
  }
  // Same whitespace handling as clean_text: one line, single spaces.
  return parts.join('').replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
}

export function itemText(info) {
  return [info.title.replace(/\s+/g, ' ').trim(), proseText(info.textEl)].filter(Boolean).join(' ');
}

// Words = whitespace-separated runs containing a letter or digit, so emoji,
// bullets and stray punctuation don't count.
export function wordCount(text) {
  let n = 0;
  for (const w of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) n++;
  return n;
}

// The username link in the item's own header (never one inside its text or in
// a nested reply), preferring the one that points at the item's author.
export function authorLink(el, info) {
  const scope = info.metaEl ?? el;
  const links = [...scope.querySelectorAll(USER_LINK)].filter(
    (a) => a.closest(ITEM_SELECTOR) === el && !info.textEl.contains(a),
  );
  const author = info.author?.toLowerCase();
  const matchesAuthor = (a) =>
    a.getAttribute('href').toLowerCase().replace(/\/+$/, '').endsWith(`/${author}`) ||
    a.textContent.trim().replace(/^u\//i, '').toLowerCase() === author;
  // The avatar also links to the profile; prefer the link showing the name.
  const named = links.filter((a) => a.textContent.trim());
  return (author && (named.find(matchesAuthor) ?? links.find(matchesAuthor))) || named[0] || links[0] || null;
}

// "Collapse the thread" for comments: Reddit's own collapse, which hides the
// comment and its replies and keeps the username row. (Posts have no such
// state; badge.js masks them instead.)
//
// <shreddit-comment> has shipped two ways: rendered in the page as a
// <details> whose <summary> is the username row (Sep 2026), or with a shadow
// root holding a ⊖ toggle button (Aug 2026). Without either (Reddit's JS not
// loaded), fall back to its `collapsed` attribute.
function shredditToggle(el) {
  return {
    details: el.querySelector(':scope > details'),
    button: el.shadowRoot?.querySelector('button[aria-expanded]'),
  };
}

export function isCollapsed(el) {
  if (el.localName === SHREDDIT_COMMENT) {
    const { details, button } = shredditToggle(el);
    if (details) return !details.open;
    if (button) return button.getAttribute('aria-expanded') === 'false';
    return el.hasAttribute('collapsed');
  }
  return el.classList.contains('collapsed');
}

export function setCollapsed(el, collapsed) {
  if (el.localName === SHREDDIT_COMMENT) {
    if (isCollapsed(el) === collapsed) return;
    const { details, button } = shredditToggle(el);
    if (details) details.open = !collapsed;
    else if (button) button.click();
    else el.toggleAttribute('collapsed', collapsed);
  } else {
    el.classList.toggle('collapsed', collapsed);
    el.classList.toggle('noncollapsed', !collapsed);
  }
}
