// Runs the production build (dist/, with the real model from
// scripts/prepare_model.py --dtypes fp16,q8,fp32) against real Reddit markup:
// Wayback Machine captures of a live thread and subreddit feed, served at
// their original www.reddit.com URLs. Reddit's own JS/CSS still load from
// redditstatic.com, so the shreddit web components render as they do live.
//
//   node test/real-reddit.mjs [webgpu] [wasm] [--parity-only]
//
// --parity-only: load the model and compare a few scores, skip the pages.
// Useful for WebGPU on machines without a GPU, where SwiftShader runs
// roberta-base far too slowly for whole pages.
//
// Snapshots are downloaded into test/.cache on first run (nothing from Reddit
// is committed). Model accuracy is checked separately against labelled data;
// here we check that the extension finds, scores and badges real comments.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(root, 'dist');
const CACHE = path.join(root, 'test', '.cache');
const ARTIFACTS = path.join(root, 'test', '.artifacts');
const MIN_WORDS = 50;
const args = process.argv.slice(2);
const parityOnly = args.includes('--parity-only');
const named = args.filter((a) => !a.startsWith('--'));
const devices = named.length ? named : ['webgpu', 'wasm'];

const SNAPSHOTS = {
  thread: {
    url: 'https://www.reddit.com/r/explainlikeimfive/comments/1w3leqa/eli5_why_is_the_physical_size_of_ram_so_big/',
    // Reddit's JS challenge redirected the crawler; the solved URL holds the real page.
    wayback:
      'https://web.archive.org/web/20260831223355id_/https://www.reddit.com/r/explainlikeimfive/comments/1w3leqa/eli5_why_is_the_physical_size_of_ram_so_big/?solution=7ea185b6ff38ed0f7ea185b6ff38ed0f&js_challenge=1&token=7afd7253fec22262ff1c52b1703fe9ecc65e195ac4e79dfc3dfc782fb4a9f40b&jsc_orig_r=',
  },
  feed: {
    url: 'https://www.reddit.com/r/explainlikeimfive/',
    wayback: 'https://web.archive.org/web/20260831204622id_/https://www.reddit.com/r/explainlikeimfive/',
  },
};

async function snapshot(name) {
  const file = path.join(CACHE, `${name}.html`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(SNAPSHOTS[name].wayback);
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
    if (!fs.existsSync(file)) throw new Error(`could not fetch ${name} snapshot: ${lastErr}`);
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
function readItems(page, selector) {
  return page.evaluate(
    ({ selector, MIN_WORDS }) => {
      const OWNER = 'shreddit-post, shreddit-comment';
      const own = (el, sel) => [...el.querySelectorAll(sel)].find((n) => n.closest(OWNER) === el) ?? null;
      const words = (node) => {
        if (!node) return 0;
        const clone = node.cloneNode(true);
        clone.querySelectorAll('blockquote, pre, code, table, .rcf-badge, .rcf-placeholder').forEach((n) => n.remove());
        clone.querySelectorAll('p, div, li, br, h1, h2, h3, h4, h5, h6').forEach((n) => n.append(' '));
        return clone.textContent.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
      };
      return [...document.querySelectorAll(selector)].map((el) => {
        const isPost = el.localName === 'shreddit-post';
        const body = isPost ? own(el, '[slot="text-body"]') : el.querySelector(':scope > [slot="comment"]');
        const title = isPost ? (el.getAttribute('post-title') ?? '') : '';
        const n = words(body) + (title ? title.split(/\s+/).filter(Boolean).length : 0);
        const badge = [...el.querySelectorAll('.rcf-badge')].find((b) => b.closest(OWNER) === el) ?? null;
        const r = badge?.getBoundingClientRect();
        const prev = badge?.previousElementSibling;
        const prevLink = prev?.matches('a') ? prev : prev?.querySelector('a[href*="/user/"]');
        return {
          id: el.getAttribute('thingid') ?? el.id,
          author: el.getAttribute('author'),
          words: body ? n : 0,
          long: !!body && n > MIN_WORDS,
          top: el.getBoundingClientRect().top + scrollY,
          badge: badge && {
            text: badge.textContent,
            score: badge.dataset.rcfScore ? Number(badge.dataset.rcfScore) : null,
            level: badge.dataset.rcfLevel,
            title: badge.title,
            visible: r.width > 0 && r.height > 0,
            afterAuthor: !!prevLink && prevLink.getAttribute('href').replace(/\/+$/, '').toLowerCase().endsWith(`/user/${(el.getAttribute('author') || '').toLowerCase()}`),
            inMeta: !!badge.closest('[slot="commentMeta"], [slot="credit-bar"]'),
          },
        };
      });
    },
    { selector, MIN_WORDS },
  );
}

async function scrollThrough(page) {
  for (let y = 0; ; y += 700) {
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await page.evaluate((y) => scrollTo(0, y), Math.min(y, max));
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 120_000 });
    if (y >= max) break;
  }
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 120_000 });
}

function assertBadges(items, label) {
  const long = items.filter((i) => i.long);
  assert.ok(long.length > 0, `${label}: no items over ${MIN_WORDS} words found (selectors?)`);
  for (const i of items) {
    if (!i.long) {
      assert.equal(i.badge, null, `${label}: ${i.author} (${i.words} words) should not be scored`);
      continue;
    }
    assert.ok(i.badge, `${label}: ${i.author} (${i.words} words) has no badge`);
    assert.ok(i.badge.score != null, `${label}: ${i.author} badge not scored: ${i.badge.title}`);
    assert.ok(i.badge.visible, `${label}: ${i.author} badge not rendered`);
    assert.ok(i.badge.afterAuthor, `${label}: ${i.author} badge is not right after the username link`);
  }
}

async function run(device, pages, expected) {
  console.log(`\n=== real model on ${device} ===`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcf-real-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    await sw.evaluate((d) => chrome.storage.local.set({ device: d }), device);
    // Serve the captures at their real URLs; never hit reddit.com itself.
    await ctx.route(/^https:\/\/(www|old)\.reddit\.com\//, (route) => {
      const url = route.request().url().split('?')[0];
      const doc = Object.values(SNAPSHOTS).find((s) => s.url === url);
      if (doc && route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pages[doc === SNAPSHOTS.thread ? 'thread' : 'feed'] });
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
      await page.goto(SNAPSHOTS.thread.url, { waitUntil: 'domcontentloaded' });
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
    await page.waitForFunction(() => document.querySelector('.rcf-badge[data-rcf-score], .rcf-badge[data-rcf-level="error"]'), null, { timeout: 180_000 });
    await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 180_000 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ARTIFACTS, `real-thread-${device}.png`) });

    await check('real thread: before scrolling, only items near the viewport are scored', async () => {
      const items = await readItems(page, 'shreddit-post, shreddit-comment');
      const vh = await page.evaluate(() => innerHeight);
      const far = items.filter((i) => i.long && i.top > vh + 600 + 200);
      assert.ok(far.length > 0, 'thread has no long comments far below the fold');
      for (const i of far) assert.equal(i.badge, null, `${i.author} at ${Math.round(i.top)}px was scored before scrolling`);
    });

    await check('real thread: after scrolling, every comment over 50 words has a badge after its username', async () => {
      await scrollThrough(page);
      const items = await readItems(page, 'shreddit-post, shreddit-comment');
      assertBadges(items, 'thread');
      const long = items.filter((i) => i.long);
      console.log(`      ${items.length} items, ${long.length} over ${MIN_WORDS} words, ${items.filter((i) => i.badge?.score != null).length} scored`);
      for (const i of long) console.log(`        ${(i.badge?.text ?? '-').padEnd(8)} ${String(i.words).padStart(4)}w  ${i.author}`);
    });

    await check('real thread: badge hides and restores a real comment', async () => {
      const first = page.locator('shreddit-comment .rcf-badge[data-rcf-score]').first();
      await first.scrollIntoViewIfNeeded();
      const body = first.locator('xpath=ancestor::shreddit-comment[1]').locator(':scope > [slot="comment"]:not(.rcf-placeholder)');
      await first.click();
      assert.equal(await body.isVisible(), false);
      await first.click();
      assert.equal(await body.isVisible(), true);
    });

    await check('real subreddit feed: text posts over 50 words scored next to the author', async () => {
      await page.goto(SNAPSHOTS.feed.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await scrollThrough(page);
      const items = await readItems(page, 'shreddit-post');
      assertBadges(items, 'feed');
      for (const i of items) console.log(`        ${(i.badge?.text ?? '-').padEnd(8)} ${String(i.words).padStart(4)}w  ${i.author}`);
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(ARTIFACTS, `real-feed-${device}.png`) });
    });

    await check('no extension errors logged', () => assert.deepEqual(errors.filter((e) => !e.includes('ready on')), []));
  } finally {
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
const pages = { thread: await snapshot('thread'), feed: await snapshot('feed') };
const expected = JSON.parse(fs.readFileSync(path.join(CACHE, 'real_expected.json'), 'utf8'));
for (const device of devices) await run(device, pages, expected);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
