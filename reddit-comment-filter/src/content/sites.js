// Where posts and comments live in Reddit's DOM, for the current front end
// (www / sh.reddit.com: <shreddit-post>, <shreddit-comment> web components with
// slotted light-DOM content) and old.reddit.com (.thing elements).

const SHREDDIT_POST = 'shreddit-post';
const SHREDDIT_COMMENT = 'shreddit-comment';
const OLD_POST = '.thing.link';
const OLD_COMMENT = '.thing.comment';

export const ITEM_SELECTOR = [SHREDDIT_POST, SHREDDIT_COMMENT, OLD_POST, OLD_COMMENT].join(', ');
const USER_LINK = 'a[href*="/user/"], a[href*="/u/"]';

// First descendant matching `selector` that belongs to `item` itself rather
// than to a nested reply.
function own(item, selector) {
  for (const node of item.querySelectorAll(selector)) {
    if (node.closest(ITEM_SELECTOR) === item) return node;
  }
  return null;
}

const ADAPTERS = [
  {
    matches: (el) => el.localName === SHREDDIT_COMMENT,
    read: (el) => ({
      kind: 'comment',
      id: el.getAttribute('thingid'),
      author: el.getAttribute('author'),
      title: '',
      textEl:
        el.querySelector(':scope > [slot="comment"]') ?? own(el, '[id$="-comment-rtjson-content"]'),
      metaEl: el.querySelector(':scope > [slot="commentMeta"]'),
    }),
  },
  {
    matches: (el) => el.localName === SHREDDIT_POST,
    read: (el) => ({
      kind: 'post',
      id: el.getAttribute('id'),
      author: el.getAttribute('author'),
      title: el.getAttribute('post-title') ?? own(el, '[slot="title"]')?.textContent ?? '',
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
        // Self-text; on listing pages it only exists once the post is expanded.
        textEl: entry?.querySelector('.expando .usertext-body .md') ?? null,
        metaEl: entry?.querySelector('.tagline') ?? null,
      };
    },
  },
];

// Returns {kind, id, author, title, textEl, metaEl} or null when the item has
// no text body (link/image posts, bodies not rendered yet).
export function readItem(el) {
  const adapter = ADAPTERS.find((a) => a.matches(el));
  const info = adapter?.read(el);
  return info?.textEl ? info : null;
}

export function itemText(info) {
  const body = (info.textEl.innerText || info.textEl.textContent || '').trim();
  return [info.title.trim(), body].filter(Boolean).join('\n\n');
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
  return (author && links.find(matchesAuthor)) || links[0] || null;
}
