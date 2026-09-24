// Reddit-shaped pages for the browser test. reddit.com is served from these via
// Playwright routing, so the real content script runs on real reddit.com URLs.
//
// The www fixture mirrors the shreddit markup: <shreddit-post>/<shreddit-comment>
// custom elements with open shadow roots whose content is slotted light DOM
// (slot="commentMeta", "comment", "children", "credit-bar", "title",
// "text-body"). Unslotted nodes inside them don't render, like on Reddit.

const AI = [
  'Great question! When it comes to remote work, there are several key factors to consider.',
  'Firstly, it is essential to understand the broader context surrounding remote work.',
  'Furthermore, remote work can significantly enhance overall efficiency and well-being.',
  "Additionally, it's worth noting that individual experiences may vary.",
  'Moreover, leveraging best practices can help you navigate the complexities of remote work.',
  'Ultimately, a balanced and thoughtful approach tends to yield the best outcomes.',
  "Let's delve into the nuances of remote work and explore the various perspectives.",
  'By fostering open communication, stakeholders can collaboratively address these challenges.',
  'In conclusion, remote work offers a wealth of opportunities for growth.',
];
const HUMAN = [
  'lol the finale is such a mess rn', 'tbh i dont get why ppl care about the finale so much',
  'idk man my buddy tried it last year and hated it', 'ok so it broke again and im done',
  'honestly its fine if u ignore the reddit hivemind', 'gonna be real, it made me mad yesterday',
  'my cat walked on the keyboard while i was reading about it lmao', 'nah it was way better back in 2019',
  'ugh again?? we had this exact thread last week', 'yeah no, overhated imo', 'edit: typo', 'anyway',
];

// Exactly n whitespace-separated words in the given style.
export function words(n, style, offset = 0) {
  const pool = style === 'ai' ? AI : HUMAN;
  const out = [];
  for (let i = offset; out.length < n; i++) out.push(...pool[i % pool.length].split(' '));
  return out.slice(0, n).join(' ');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const SHREDDIT_ELEMENTS = `
<script>
  customElements.define('shreddit-post', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<style>:host{display:block;border:1px solid #ccc;border-radius:8px;padding:8px;margin:8px 0;cursor:pointer}</style>' +
        '<div><slot name="credit-bar"></slot></div><h3><slot name="title"></slot></h3><div><slot name="text-body"></slot></div>';
      // Feed cards open the post when clicked anywhere.
      this.addEventListener('click', () => { window.__postNavigations = (window.__postNavigations || 0) + 1; });
    }
  });
  customElements.define('shreddit-comment', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<style>:host{display:block;margin:6px 0 6px 14px;padding-left:8px;border-left:2px solid #ddd}' +
        // Like Reddit's: a collapsed comment keeps only its username row.
        ':host([collapsed]) .fold{display:none}</style>' +
        '<div style="display:flex;gap:4px;align-items:center"><slot name="commentMeta"></slot></div>' +
        '<div class="fold"><slot name="comment"></slot></div><div class="fold"><slot name="actionRow"></slot></div>' +
        '<div class="fold"><slot name="children"></slot></div>';
    }
  });
</script>`;

export function shredditComment({ id, author, text, html, children = '', slot = '' }) {
  const body =
    text == null && html == null
      ? '' // deleted: no body
      : `<div slot="comment"><div id="${id}-comment-rtjson-content" class="md"><p>${html ?? esc(text)}</p></div></div>`;
  return `
<shreddit-comment thingid="${id}" author="${author}" permalink="/r/remotework/comments/post1/comment/${id.slice(3)}/" depth="0" ${slot ? `slot="${slot}"` : ''}>
  <div slot="commentMeta">
    <faceplate-tracker noun="comment_author"><faceplate-hovercard><a href="/user/${author}/">${author}</a></faceplate-hovercard></faceplate-tracker>
    <span>·</span><faceplate-timeago>3h ago</faceplate-timeago>
  </div>
  ${body}
  <div slot="actionRow">▲ 12 ▼ Reply</div>
  ${children}
</shreddit-comment>`;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:760px;margin:16px auto;padding:0 16px}</style>
${SHREDDIT_ELEMENTS}</head><body>${body}</body></html>`;
}

export const EXPECT = {
  // thingid -> expected outcome on the www comments page
  post: { id: 't3_post1', author: 'thoughtful_writer', label: 'ai' },
  c1: { id: 't1_c1', author: 'casual_dan', label: 'human' },
  c1r1: { id: 't1_c1r1', author: 'helpful_assistant_42', label: 'ai' },
  c1r1r1: { id: 't1_c1r1r1', author: 'short_guy', label: null },
  fifty: { id: 't1_fifty', author: 'exactly_fifty', label: null },
  fiftyOne: { id: 't1_fiftyone', author: 'fifty_one', label: 'human' },
  linker: { id: 't1_linker', author: 'linker', label: 'ai' },
  deleted: { id: 't1_deleted', author: '[deleted]', label: null },
  far1: { id: 't1_far1', author: 'far_away_ai', label: 'ai' },
  far2: { id: 't1_far2', author: 'far_away_human', label: 'human' },
};

export function wwwCommentsPage() {
  const fillers = Array.from({ length: 70 }, (_, i) =>
    shredditComment({ id: `t1_fill${i}`, author: `filler_${i}`, text: words(6 + (i % 5), 'human', i) }),
  ).join('');
  const E = EXPECT;
  return page(
    'Fixture: comments',
    `
<shreddit-post id="${E.post.id}" author="${E.post.author}" post-title="What are the long-term effects of remote work?">
  <div slot="credit-bar">
    <a href="/r/remotework/">r/remotework</a> ·
    <span slot="authorName"><faceplate-tracker noun="user_profile"><faceplate-hovercard><a href="/user/${E.post.author}/" class="author-name">${E.post.author}</a></faceplate-hovercard></faceplate-tracker></span>
  </div>
  <h1 slot="title">What are the long-term effects of remote work?</h1>
  <div slot="text-body"><div id="${E.post.id}-post-rtjson-content" class="md"><p>${words(90, 'ai')}</p></div></div>
</shreddit-post>
<shreddit-comment-tree id="comment-tree">
  ${shredditComment({
    ...E.c1,
    text: words(70, 'human'),
    children: shredditComment({
      ...E.c1r1,
      slot: 'children',
      text: words(80, 'ai', 2),
      children: shredditComment({ ...E.c1r1r1, slot: 'children', text: words(12, 'human', 3) }),
    }),
  })}
  ${shredditComment({ ...E.fifty, text: words(50, 'human', 1) })}
  ${shredditComment({ ...E.fiftyOne, text: words(51, 'human', 1) })}
  ${shredditComment({
    ...E.linker,
    html: `As <a href="/user/someone_else/">u/someone_else</a> said, ${esc(words(60, 'ai', 4))}`,
  })}
  ${shredditComment({ ...E.deleted })}
  ${fillers}
  ${shredditComment({ ...E.far1, text: words(70, 'ai', 5) })}
  ${shredditComment({ ...E.far2, text: words(70, 'human', 5) })}
</shreddit-comment-tree>`,
  );
}

// Home feed: cards show the subreddit, not the author, and the whole card is a link.
export function wwwFeedPage() {
  const card = (id, bodyHtml) => `
<shreddit-post id="${id}" author="u_${id}" post-title="Post ${id}">
  <div slot="credit-bar"><a href="/r/test/">r/test</a> · 5h</div>
  <a slot="title" href="/r/test/comments/${id}/">Post ${id}</a>
  ${bodyHtml}
</shreddit-post>`;
  return page(
    'Fixture: feed',
    card('t3_feedai', `<div slot="text-body"><div class="md feed-card-text-preview"><p>${words(75, 'ai', 1)}</p></div></div>`) +
      card('t3_feedhuman', `<div slot="text-body"><div class="md feed-card-text-preview"><p>${words(75, 'human', 2)}</p></div></div>`) +
      card('t3_feedimage', '<img slot="post-media-container" alt="image post" width="200" height="100">'),
  );
}

// old.reddit.com comments page.
export function oldCommentsPage() {
  const thing = (id, author, text, children = '') => `
<div class="thing comment noncollapsed" id="thing_${id}" data-fullname="${id}" data-author="${author}">
  <div class="entry">
    <p class="tagline"><a class="expand">[–]</a><a href="https://old.reddit.com/user/${author}" class="author">${author}</a><span class="userattrs"></span> <span class="score">5 points</span> <time>2 hours ago</time></p>
    <form class="usertext"><div class="usertext-body"><div class="md"><p>${esc(text)}</p></div></div></form>
    <ul class="flat-list buttons"><li>permalink</li><li>reply</li></ul>
  </div>
  <div class="child">${children}</div>
</div>`;
  // old.reddit's own rule for collapsed comments.
  return `<!doctype html><html><head><meta charset="utf-8"><title>old fixture</title>
<style>.comment.collapsed > .entry .usertext, .comment.collapsed > .entry .flat-list, .comment.collapsed > .child { display: none }</style></head><body>
<div class="thing link self" data-fullname="t3_old1" data-author="op_user">
  <div class="entry">
    <p class="title"><a class="title" href="/r/test/comments/old1/">Is remote work here to stay?</a></p>
    <p class="tagline">submitted 3 hours ago by <a href="https://old.reddit.com/user/op_user" class="author">op_user</a></p>
    <div class="expando"><form class="usertext"><div class="usertext-body"><div class="md"><p>${esc(words(80, 'ai', 3))}</p></div></div></form></div>
  </div>
</div>
<div class="commentarea"><div class="sitetable nestedlisting">
  ${thing('t1_o1', 'old_human', words(70, 'human', 4), thing('t1_o1r1', 'old_ai', words(70, 'ai', 6)))}
  ${thing('t1_o2', 'old_short', words(20, 'human', 2))}
</div></div></body></html>`;
}
