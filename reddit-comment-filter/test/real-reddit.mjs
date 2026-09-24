// Runs the production build (dist/, with the real model from
// scripts/prepare_model.py --dtypes fp16,fp32) against real Reddit markup:
// the latest Wayback Machine captures of r/antiai and r/SaaS (feeds and
// threads), served at their original www.reddit.com URLs. Reddit's own JS/CSS
// still load from redditstatic.com, so the shreddit web components render and
// collapse exactly as they do live.
//
//   node test/real-reddit.mjs [webgpu] [wasm] [--parity-only]
//
// --parity-only: load the model and compare a few scores, skip the pages.
// Useful for WebGPU on machines without a GPU, where SwiftShader runs
// roberta-base far too slowly for whole pages.
//
// Captures are downloaded into test/.cache on first run (nothing from Reddit
// is committed). Model accuracy is checked separately against labelled data;
// here we check that the extension finds, scores, badges and collapses real
// posts and comments.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { AutoTokenizer, env as hfEnv } from '@huggingface/transformers';
import { chromium } from 'playwright';
import { encodeBatch } from '../src/encode.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(root, 'dist');
const CACHE = path.join(root, 'test', '.cache');
const ARTIFACTS = path.join(root, 'test', '.artifacts');
const MIN_WORDS = 50;
const COLLAPSE_ABOVE = 0.3;
const args = process.argv.slice(2);
const parityOnly = args.includes('--parity-only');
const named = args.filter((a) => !a.startsWith('--'));
const devices = named.length ? named : ['webgpu', 'wasm'];

// Reddit's JS challenge redirected the crawler; the solved URLs hold the real pages.
const PAGES = [
  {
    name: 'antiai-thread',
    kind: 'thread',
    captured: '2026-09-21',
    url: 'https://www.reddit.com/r/antiai/comments/1wm51zm/well_this_is_scary/',
    wayback:
      'https://web.archive.org/web/20260921154539id_/https://www.reddit.com/r/antiai/comments/1wm51zm/well_this_is_scary/?solution=65abb1e903fa891465abb1e903fa8914&js_challenge=1&jsc_token=2824be10929bdc604753c70a67a1c331227fb52ee4d50d0c2bec85cb15ec2115&jsc_orig_r=',
  },
  {
    name: 'antiai-feed',
    kind: 'feed',
    captured: '2026-09-20',
    url: 'https://www.reddit.com/r/antiai/',
    wayback:
      'https://web.archive.org/web/20260920161538id_/https://www.reddit.com/r/antiai/?solution=c4dc45af8fe195e1c4dc45af8fe195e1&js_challenge=1&jsc_token=7afd7253fec22262ff1c52b1703fe9ec0a4902116b1dc13cd520bb77d678d9e5&jsc_orig_r=&communityAnchorSource=hourly_trending_discussion',
  },
  {
    name: 'saas-thread',
    kind: 'thread',
    captured: '2026-09-21',
    url: 'https://www.reddit.com/r/SaaS/comments/1wlzxqi/company_raised_416m_sold_for_465m_founders_got_0/',
    wayback:
      'https://web.archive.org/web/20260921084833id_/https://www.reddit.com/r/SaaS/comments/1wlzxqi/company_raised_416m_sold_for_465m_founders_got_0/?solution=5fd82266696a0ee75fd82266696a0ee7&js_challenge=1&jsc_token=7afd7253fec22262ff1c52b1703fe9ec9c00b468e17e7d7145a00a022748b2a7&jsc_orig_r=',
  },
  {
    name: 'saas-thread-2',
    kind: 'thread',
    captured: '2026-09-21',
    url: 'https://www.reddit.com/r/SaaS/comments/1wlcl48/anyone_else_notice_every_aibuilt_site_looks_the/',
    wayback:
      'https://web.archive.org/web/20260921041246id_/https://www.reddit.com/r/SaaS/comments/1wlcl48/anyone_else_notice_every_aibuilt_site_looks_the/?solution=9c5a6d2a4632dc1a9c5a6d2a4632dc1a&js_challenge=1&jsc_token=7afd7253fec22262ff1c52b1703fe9ec9bab45a1d3747b07063d7810d53fe1f5&jsc_orig_r=',
  },
  {
    name: 'saas-feed',
    kind: 'feed',
    captured: '2026-09-15',
    url: 'https://www.reddit.com/r/SaaS/',
    wayback:
      'https://web.archive.org/web/20260915063028id_/https://www.reddit.com/r/SaaS/',
  },
];
async function snapshot(page) {
  const file = path.join(CACHE, `${page.name}.html`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(page.wayback);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let buf = Buffer.from(await res.arrayBuffer());
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // id_ serves the raw (gzipped) capture
        fs.writeFileSync(file, buf);
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    if (!fs.existsSync(file)) throw new Error(`could not fetch ${page.name} capture: ${lastErr}`);
  }
  return fs.readFileSync(file, 'utf8');
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n      ${String(err?.message || err).split('\n').join('\n      ')}`);
  }
}

// Per-item facts read from the page, using the same "own text" rules as the
// content script (quotes/code/tables excluded) so word counts line up.
function readItems(page) {
  return page.evaluate((MIN_WORDS) => {
    const OWNER = 'shreddit-post, shreddit-comment';
    const OURS = '.rcf-group, .rcf-note';
    const own = (el, sel) => [...el.querySelectorAll(sel)].find((n) => n.closest(OWNER) === el && !n.closest(OURS)) ?? null;
    const words = (node) => {
      if (!node) return 0;
      const clone = node.cloneNode(true);
      clone.querySelectorAll(`blockquote, pre, code, table, ${OURS}`).forEach((n) => n.remove());
      clone.querySelectorAll('p, div, li, br, h1, h2, h3, h4, h5, h6').forEach((n) => n.append(' '));
      return clone.textContent.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    };
    const shown = (n) => !!n && n.checkVisibility();
    return [...document.querySelectorAll(OWNER)].map((el) => {
      const isPost = el.localName === 'shreddit-post';
      // Same lookup as the content script: newer markup nests the comment body
      // in layout divs, so fall back to its id.
      const body = isPost
        ? own(el, '[slot="text-body"]')
        : (el.querySelector(`:scope > [slot="comment"]:not(${OURS})`) ?? own(el, '[id$="-comment-rtjson-content"]'));
      const title = isPost ? (el.getAttribute('post-title') ?? '') : '';
      const n = words(body) + (title ? title.split(/\s+/).filter(Boolean).length : 0);
      const badge = [...el.querySelectorAll('.rcf-badge')].find((b) => b.closest(OWNER) === el) ?? null;
      const group = badge?.closest('.rcf-group');
      const prev = group?.previousElementSibling;
      const prevLink = prev?.matches('a') ? prev : prev?.querySelector('a[href*="/user/"]');
      const replies = isPost ? [] : [...el.querySelectorAll('shreddit-comment')].filter((c) => c.parentElement.closest(OWNER) === el);
      return {
        kind: isPost ? 'post' : 'comment',
        author: el.getAttribute('author'),
        words: body ? n : 0,
        long: !!body && n > MIN_WORDS,
        top: el.getBoundingClientRect().top + scrollY,
        collapsed: isPost
          ? !!body?.classList.contains('rcf-hidden')
          : el.querySelector(':scope > details')
            ? !el.querySelector(':scope > details').open
            : (el.shadowRoot?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? (el.hasAttribute('collapsed') ? 'false' : 'true')) === 'false',
        bodyVisible: shown(body),
        replies: replies.length,
        repliesVisible: replies.filter(shown).length,
        badge: badge && {
          text: badge.textContent,
          score: badge.dataset.rcfScore ? Number(badge.dataset.rcfScore) : null,
          level: badge.dataset.rcfLevel,
          visible: shown(badge),
          buttons: [...group.querySelectorAll('button')].filter(shown).map((b) => b.textContent),
          tooltips: [group, ...group.querySelectorAll('*')].filter((x) => x.title).length,
          afterAuthor: !!prevLink && prevLink.getAttribute('href').replace(/\/+$/, '').toLowerCase().endsWith(`/user/${(el.getAttribute('author') || '').toLowerCase()}`),
        },
      };
    });
  }, MIN_WORDS);
}

async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 180_000 });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 180_000 });
}

async function scrollThrough(page) {
  for (let y = 0; ; y += 700) {
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await page.evaluate((y) => scrollTo(0, y), Math.min(y, max));
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 180_000 });
    if (y >= max) break;
  }
  await waitIdle(page);
}

function assertItems(items, label) {
  for (const i of items) {
    const who = `${label}: ${i.author} (${i.words} words)`;
    if (!i.long) {
      assert.equal(i.badge, null, `${who} should not be scored`);
      continue;
    }
    assert.ok(i.badge?.score != null, `${who} has no score`);
    assert.ok(i.badge.visible, `${who}: pill not rendered`);
    assert.ok(i.badge.afterAuthor, `${who}: pill is not right after the username link`);
    assert.deepEqual(i.badge.buttons, [i.badge.text, 'AI', 'Not AI'], `${who}: shows ${JSON.stringify(i.badge.buttons)}`);
    assert.equal(i.badge.tooltips, 0, `${who}: has tooltips`);
    const shouldCollapse = i.badge.score > COLLAPSE_ABOVE;
    assert.equal(i.collapsed, shouldCollapse, `${who}: collapsed=${i.collapsed} at ${i.badge.score}`);
    assert.equal(i.bodyVisible, !shouldCollapse, `${who}: text visible=${i.bodyVisible} at ${i.badge.score}`);
    if (shouldCollapse) assert.equal(i.repliesVisible, 0, `${who}: replies still visible under a collapsed thread`);
  }
}

function printItems(items) {
  for (const i of items.filter((x) => x.long)) {
    const b = i.badge;
    console.log(
      `        ${(b?.text ?? '-').padEnd(7)} ${(b?.level ?? '').padEnd(7)} ${b?.score?.toFixed(2) ?? '-  '}  ${i.collapsed ? 'collapsed' : 'open     '}` +
        `  ${String(i.words).padStart(4)}w  ${i.kind === 'post' ? 'post ' : ''}${i.author}${i.replies ? ` (+${i.replies} replies)` : ''}`,
    );
  }
}

async function run(device, html, expected) {
  console.log(`\n=== real model on ${device} ===`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcf-real-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  });
  try {
    const isExt = (w) => w.url().endsWith('/background.js');
    const sw = ctx.serviceWorkers().find(isExt) ?? (await ctx.waitForEvent('serviceworker', { predicate: isExt }));
    await sw.evaluate((d) => chrome.storage.local.set({ device: d }), device);
    // Serve the captures at their real URLs; never hit reddit.com itself.
    await ctx.route(/^https:\/\/(www|old)\.reddit\.com\//, (route) => {
      const url = route.request().url().split('?')[0];
      const page = PAGES.find((p) => p.url === url);
      if (page && route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html[page.name] });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const offscreen = (msg) => sw.evaluate((m) => chrome.runtime.sendMessage({ target: 'offscreen', ...m }), msg);

    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.text().includes('[rcf]') && errors.push(m.text()));
    if (parityOnly) {
      // No page, so no page batches queue ahead of the comparison: start the model host directly.
      await sw.evaluate(async () => {
        const { device } = await chrome.storage.local.get('device');
        await chrome.offscreen.createDocument({ url: `offscreen.html?device=${device}`, reasons: ['WORKERS'], justification: 'test' });
      });
    } else {
      await page.goto(PAGES[0].url, { waitUntil: 'domcontentloaded' });
    }

    let status;
    for (let t = 0; t < 600; t++) {
      status = await offscreen({ type: 'status' }).catch(() => null);
      if (status && status.state !== 'loading') break;
      await page.waitForTimeout(500);
    }
    console.log(`  engine: ${status.modelId} ${status.modelClass} on ${status.device}/${status.dtype}, loaded in ${status.loadMs} ms`);
    await check(`real model loads on ${device}`, () => {
      assert.equal(status.state, 'ready', status.error);
      assert.equal(status.device, device);
      assert.equal(status.modelClass, 'RobertaForSequenceClassification');
    });

    // --parity-only: one human + one ChatGPT answer.
    const pick = parityOnly ? [0, expected.texts.length - 1] : expected.texts.map((_, i) => i);
    await check('browser scores match onnxruntime/PyTorch on labelled Reddit answers (HC3 reddit_eli5)', async () => {
      const t0 = Date.now();
      const resp = await offscreen({ type: 'classify', texts: pick.map((i) => expected.texts[i]) });
      const ms = Date.now() - t0;
      assert.ok(!resp.error, resp.error);
      const ref = expected.probs[status.dtype];
      const tol = status.dtype === 'q8' ? 0.02 : 0.005;
      resp.results.forEach((r, j) => {
        const i = pick[j];
        assert.ok(Math.abs(r.score - ref[i][1]) < tol, `text ${i}: browser ${r.score.toFixed(4)} vs python ${ref[i][1].toFixed(4)}`);
      });
      const correct = resp.results.filter((r, j) => (r.score > 0.5) === (expected.kinds[pick[j]] === 'ai')).length;
      console.log(`      ${correct}/${resp.results.length} labelled answers classified correctly; batch of ${resp.results.length} in ${ms} ms`);
    });
    if (parityOnly) return;

    for (const [n, p] of PAGES.entries()) {
      await check(`${p.name} (captured ${p.captured}): every item over ${MIN_WORDS} words scored next to its username; above ${COLLAPSE_ABOVE * 100}% collapsed`, async () => {
        if (n > 0) await page.goto(p.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000); // Reddit's components render; the content script scans
        await waitIdle(page);
        if (p.kind === 'thread') {
          // Viewport gating: long comments still far below the fold are not scored yet.
          const vh = await page.evaluate(() => innerHeight);
          const far = (await readItems(page)).filter((i) => i.long && i.top > vh + 600 + 200);
          for (const i of far) assert.equal(i.badge, null, `${i.author} at ${Math.round(i.top)}px was scored before scrolling`);
          console.log(`      ${far.length} long comments still unscored far below the fold before scrolling`);
        }
        await scrollThrough(page);
        const items = await readItems(page);
        const long = items.filter((i) => i.long);
        console.log(`      ${items.length} items, ${long.length} over ${MIN_WORDS} words, ${long.filter((i) => i.collapsed).length} collapsed`);
        printItems(items);
        if (p.kind === 'thread') assert.ok(long.length > 0, `${p.name}: found no long items (selectors?)`);
        if (!long.length) console.log('      (no text posts over 50 words in this capture: nothing to score)');
        assertItems(items, p.name);
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(ARTIFACTS, `real-${p.name}-${device}.png`) });
      });
    }

    await check('the pill toggles Reddit\'s own thread collapse on a real comment', async () => {
      await page.goto(PAGES[0].url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await scrollThrough(page); // the first long comment may be far down
      const pill = page.locator('shreddit-comment .rcf-badge[data-rcf-score]').first();
      const comment = pill.locator('xpath=ancestor::shreddit-comment[1]');
      const body = page.locator(`[id="${await comment.getAttribute('thingid')}-comment-rtjson-content"]`);
      const collapsed = () => comment.evaluate((el) => !el.querySelector(':scope > details').open);
      await pill.scrollIntoViewIfNeeded();
      const before = await collapsed();
      await pill.click();
      assert.equal(await collapsed(), !before, 'first click did not toggle');
      assert.equal(await body.isVisible(), before, 'text visibility after first click');
      await pill.click();
      assert.equal(await collapsed(), before, 'second click did not toggle back');
      assert.equal(await body.isVisible(), !before, 'text visibility after second click');
    });

    await check('no extension errors logged', () => assert.deepEqual(errors.filter((e) => !e.includes('ready on')), []));
  } finally {
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
const html = {};
for (const p of PAGES) html[p.name] = await snapshot(p);
const expected = JSON.parse(fs.readFileSync(path.join(CACHE, 'real_expected.json'), 'utf8'));
// Exact token ids vs Python, incl. two texts past 512 tokens. Scores alone
// can't show a dropped </s> on clear-cut texts, so compare the ids.
console.log('\n=== tokenization (real tokenizer) ===');
hfEnv.localModelPath = path.join(root, 'models/');
hfEnv.allowRemoteModels = false;
const realTok = await AutoTokenizer.from_pretrained('fakespot-ai/roberta-base-ai-text-detection-v1');
await check('token ids match the Python tokenizer, special tokens kept when truncating', () => {
  const { input_ids, attention_mask } = encodeBatch(realTok, expected.texts);
  const width = input_ids.dims[1];
  expected.ids.forEach((py, i) => {
    const row = Array.from(input_ids.data.slice(i * width, (i + 1) * width), Number);
    const len = Array.from(attention_mask.data.slice(i * width, (i + 1) * width)).filter((m) => m === 1n).length;
    assert.deepEqual(row.slice(0, len), py, `text ${i} (${py.length} tokens)`);
  });
});
if (parityOnly && failures) process.exit(1);

for (const device of devices) await run(device, html, expected);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
