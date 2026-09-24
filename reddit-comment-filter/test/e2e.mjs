// End-to-end test: loads the built extension (dist-test/, bundled with the tiny
// test model) into Chromium, serves Reddit-shaped fixtures on www.reddit.com
// and old.reddit.com, and checks extraction, viewport gating, badges, blocking
// and model output parity on both the WebGPU and the WASM backend.
//
//   npm run test:model   # once: builds test/.models (needs the Python deps)
//   npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoTokenizer, env as hfEnv } from '@huggingface/transformers';
import { chromium } from 'playwright';
import { encodeBatch } from '../src/encode.js';
import { EXPECT, oldCommentsPage, shredditComment, words, wwwCommentsPage, wwwFeedPage } from './fixtures.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(root, 'dist-test');
const ARTIFACTS = path.join(root, 'test', '.artifacts');
const expected = JSON.parse(fs.readFileSync(path.join(root, 'test/.models/expected.json'), 'utf8'));
const MIN_WORDS = 50;
const ROOT_MARGIN = 600;
const PARITY_TOLERANCE = 2e-3;
const devices = process.argv.slice(2).length ? process.argv.slice(2) : ['webgpu', 'wasm'];

fs.mkdirSync(ARTIFACTS, { recursive: true });
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

async function launch(device) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcf-profile-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // full Chromium in new-headless mode: supports extensions
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--enable-unsafe-webgpu',
      // No GPU in CI containers: SwiftShader provides a software WebGPU adapter.
      '--use-webgpu-adapter=swiftshader',
    ],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await sw.evaluate((d) => chrome.storage.local.set({ device: d }), device);

  const pages = { '/': wwwFeedPage() };
  await ctx.route('https://www.reddit.com/**', (route) => {
    const { pathname } = new URL(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pages[pathname] ?? wwwCommentsPage() });
  });
  await ctx.route('https://old.reddit.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: oldCommentsPage() }),
  );
  return { ctx, sw, userDataDir };
}

const offscreen = (sw, msg) => sw.evaluate((m) => chrome.runtime.sendMessage({ target: 'offscreen', ...m }), msg);

async function waitForEngine(sw) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = await offscreen(sw, { type: 'status' }).catch(() => null);
    if (status && status.state !== 'loading') return status;
    if (Date.now() > deadline) throw new Error(`engine still loading: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Everything about one post/comment the assertions need, read from the page.
function itemState(page, id) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[thingid="${id}"], shreddit-post[id="${id}"], .thing[data-fullname="${id}"]`);
    if (!el) return null;
    const owner = (n) => n.closest('shreddit-comment, shreddit-post, .thing');
    const badge = [...el.querySelectorAll('.rcf-badge')].find((b) => owner(b) === el) ?? null;
    const rect = el.getBoundingClientRect();
    const br = badge?.getBoundingClientRect();
    const prev = badge?.previousElementSibling;
    const prevLink = prev?.matches('a') ? prev : prev?.querySelector('a');
    return {
      top: rect.top + scrollY,
      badge: badge && {
        text: badge.textContent,
        score: badge.dataset.rcfScore ? Number(badge.dataset.rcfScore) : null,
        level: badge.dataset.rcfLevel,
        visible: br.width > 0 && br.height > 0,
        slot: badge.slot,
        parentSlot: badge.parentElement.getAttribute('slot'),
        prevTag: prev?.localName ?? null,
        prevLinkHref: prevLink?.getAttribute('href') ?? null,
        nextSlot: badge.nextElementSibling?.getAttribute('slot') ?? null,
        insideBody: !!badge.closest('.md, [slot="comment"], [slot="text-body"]'),
      },
    };
  }, id);
}

async function waitIdle(page) {
  // No badge still scoring, and nothing changed for a moment.
  await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !document.querySelector('.rcf-badge[data-rcf-level="pending"]'), null, { timeout: 60_000 });
}

function assertScored(state, label, name) {
  assert.ok(state?.badge, `${name}: no badge`);
  assert.ok(state.badge.score != null, `${name}: badge not scored (${state.badge.text} / ${state.badge.level})`);
  assert.ok(state.badge.visible, `${name}: badge is not rendered (slotting?)`);
  assert.match(state.badge.text, /^AI \d+%$/, `${name}: badge text ${state.badge.text}`);
  if (label === 'ai') assert.ok(state.badge.score > 0.5, `${name}: expected AI-like, got ${state.badge.score}`);
  if (label === 'human') assert.ok(state.badge.score < 0.5, `${name}: expected human-like, got ${state.badge.score}`);
}

async function runDevice(device) {
  console.log(`\n=== device: ${device} ===`);
  const { ctx, sw, userDataDir } = await launch(device);
  const logs = [];
  try {
    const page = await ctx.newPage();
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    await page.goto('https://www.reddit.com/r/remotework/comments/post1/fixture/');

    const status = await waitForEngine(sw);
    console.log(`  engine: ${JSON.stringify({ ...status, attempts: status.attempts })}`);

    await check(`model runs on ${device}`, () => {
      assert.equal(status.state, 'ready', status.error);
      assert.equal(status.device, device);
      assert.equal(status.modelClass, 'RobertaForSequenceClassification');
      if (device === 'wasm') assert.equal(status.dtype, 'fp16');
      assert.ok(status.crossOriginIsolated, 'offscreen document is not cross-origin isolated');
      if (device === 'wasm') assert.ok(status.numThreads > 1, `WASM runs single-threaded (${status.numThreads})`);
    });

    await check('batched output matches onnxruntime reference (same tokenizer, truncation, softmax)', async () => {
      const resp = await offscreen(sw, { type: 'classify', texts: expected.texts });
      assert.ok(!resp.error, resp.error);
      const ref = expected.probs[status.dtype];
      resp.results.forEach((r, i) => {
        assert.equal(r.label, 'AI');
        const diff = Math.abs(r.score - ref[i][1]);
        assert.ok(diff < PARITY_TOLERANCE, `text ${i}: browser ${r.score.toFixed(5)} vs python ${ref[i][1].toFixed(5)}`);
      });
      console.log(`      scores: ${resp.results.map((r) => r.score.toFixed(4)).join(', ')}`);
    });

    await waitIdle(page);
    const viewportH = await page.evaluate(() => innerHeight);
    const states = {};
    for (const [key, { id }] of Object.entries(EXPECT)) states[key] = await itemState(page, id);

    await check('only items near the viewport are scored before scrolling', () => {
      assert.ok(states.far1.top > viewportH + ROOT_MARGIN, 'fixture: far1 should start out of range');
      for (const [key, exp] of Object.entries(EXPECT)) {
        const s = states[key];
        const near = s.top < viewportH + ROOT_MARGIN;
        if (exp.label && near) assertScored(s, exp.label, key);
        if (!near) assert.equal(s.badge, null, `${key} is ${Math.round(s.top)}px down but was scored`);
      }
    });

    await check(`items with <= ${MIN_WORDS} words get no badge`, () => {
      for (const key of ['fifty', 'c1r1r1', 'deleted']) assert.equal(states[key].badge, null, `${key} has a badge`);
      assertScored(states.fiftyOne, 'human', `fiftyOne (${MIN_WORDS + 1} words)`);
    });

    await check('badge sits right after the author handle, in the item header', () => {
      for (const key of ['post', 'c1', 'c1r1', 'fiftyOne', 'linker']) {
        const b = states[key].badge;
        assert.ok(b, `${key}: no badge`);
        assert.equal(b.insideBody, false, `${key}: badge inside the text`);
        assert.equal(b.prevLinkHref, `/user/${EXPECT[key].author}/`, `${key}: badge follows ${b.prevLinkHref}`);
        assert.equal(b.prevTag, 'faceplate-tracker', `${key}: should step out of the hovercard wrappers`);
      }
    });

    await page.screenshot({ path: path.join(ARTIFACTS, `www-comments-${device}.png`) });

    await check('scrolling brings far comments into range and scores them', async () => {
      await page.evaluate((id) => document.querySelector(`[thingid="${id}"]`).scrollIntoView({ block: 'center' }), EXPECT.far1.id);
      await page.waitForFunction(
        (ids) => ids.every((id) => document.querySelector(`[thingid="${id}"] .rcf-badge[data-rcf-score]`)),
        [EXPECT.far1.id, EXPECT.far2.id],
        { timeout: 60_000 },
      );
      assertScored(await itemState(page, EXPECT.far1.id), 'ai', 'far1');
      assertScored(await itemState(page, EXPECT.far2.id), 'human', 'far2');
    });

    await check('comments added later (load more / infinite scroll) are picked up', async () => {
      await page.evaluate((html) => {
        const far = document.querySelector('[thingid="t1_far2"]');
        far.insertAdjacentHTML('afterend', html);
      }, shredditComment({ id: 't1_dynamic', author: 'late_arrival', text: words(65, 'ai', 7) }));
      await page.waitForSelector('[thingid="t1_dynamic"] .rcf-badge[data-rcf-score]', { timeout: 60_000 });
      assertScored(await itemState(page, 't1_dynamic'), 'ai', 'dynamic');
    });

    await check('clicking the badge hides the text and does not open the post; clicking again restores it', async () => {
      await page.evaluate(() => scrollTo(0, 0));
      const badge = page.locator(`shreddit-post[id="${EXPECT.post.id}"] .rcf-badge`);
      const body = page.locator(`shreddit-post[id="${EXPECT.post.id}"] [slot="text-body"]:not(.rcf-placeholder)`);
      const before = await page.evaluate(() => window.__postNavigations || 0);
      await badge.click();
      assert.equal(await body.isVisible(), false, 'text still visible after blocking');
      assert.equal(await badge.getAttribute('aria-pressed'), 'true');
      assert.ok(await page.locator(`shreddit-post[id="${EXPECT.post.id}"] .rcf-placeholder`).isVisible(), 'no placeholder');
      await page.screenshot({ path: path.join(ARTIFACTS, `www-blocked-${device}.png`) });
      await badge.click();
      assert.equal(await body.isVisible(), true, 'text not restored');
      assert.equal(await page.evaluate(() => window.__postNavigations || 0), before, 'badge click reached the post card');
    });

    await check('home feed: badge on text posts without an author link, not on image posts', async () => {
      await page.goto('https://www.reddit.com/');
      await page.waitForFunction(() => document.querySelectorAll('.rcf-badge[data-rcf-score]').length >= 2, null, { timeout: 60_000 });
      await waitIdle(page);
      const ai = await itemState(page, 't3_feedai');
      const human = await itemState(page, 't3_feedhuman');
      assertScored(ai, 'ai', 'feed ai');
      assertScored(human, 'human', 'feed human');
      assert.equal(ai.badge.slot, 'text-body', 'fallback badge must share the text-body slot to render');
      assert.equal((await itemState(page, 't3_feedimage')).badge, null);
      const before = await page.evaluate(() => window.__postNavigations || 0);
      await page.locator('shreddit-post[id="t3_feedai"] .rcf-badge').click();
      assert.equal(await page.evaluate(() => window.__postNavigations || 0), before, 'badge click opened the post');
      await page.screenshot({ path: path.join(ARTIFACTS, `www-feed-${device}.png`) });
    });

    await check('old.reddit.com: post + nested comments scored, badge after a.author', async () => {
      await page.goto('https://old.reddit.com/r/test/comments/old1/fixture/');
      await page.waitForFunction(() => document.querySelectorAll('.rcf-badge[data-rcf-score]').length >= 3, null, { timeout: 60_000 });
      await waitIdle(page);
      const expectOld = { t3_old1: ['ai', 'op_user'], t1_o1: ['human', 'old_human'], t1_o1r1: ['ai', 'old_ai'] };
      for (const [id, [label, author]] of Object.entries(expectOld)) {
        const s = await itemState(page, id);
        assertScored(s, label, id);
        assert.equal(s.badge.prevTag, 'a');
        assert.equal(s.badge.prevLinkHref, `https://old.reddit.com/user/${author}`);
      }
      assert.equal((await itemState(page, 't1_o2')).badge, null, 'short old comment scored');
      await page.screenshot({ path: path.join(ARTIFACTS, `old-reddit-${device}.png`) });
    });

    const final = await offscreen(sw, { type: 'status' });
    console.log(`  classified ${final.classified} texts; model load ${final.loadMs} ms`);
    const errors = logs.filter((l) => /error|Refused|CSP/i.test(l));
    await check('no console errors / CSP violations on the page', () => assert.deepEqual(errors, []));
  } finally {
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

// transformers.js 4.3 drops RoBERTa's closing </s> when it truncates; the
// extension encodes itself and must produce exactly the Python token ids.
// (The tiny model barely reacts to </s>, so score parity alone can't catch this.)
async function checkTokenization() {
  console.log('\n=== tokenization ===');
  hfEnv.localModelPath = path.join(root, 'test/.models/');
  hfEnv.allowRemoteModels = false;
  const tok = await AutoTokenizer.from_pretrained('local-test/tiny-roberta');
  await check('token ids match the Python tokenizer, special tokens kept when truncating', () => {
    const { input_ids, attention_mask } = encodeBatch(tok, expected.texts);
    const width = input_ids.dims[1];
    expected.ids.forEach((py, i) => {
      const row = Array.from(input_ids.data.slice(i * width, (i + 1) * width), Number);
      const len = Array.from(attention_mask.data.slice(i * width, (i + 1) * width)).filter((m) => m === 1n).length;
      assert.deepEqual(row.slice(0, len), py, `text ${i} (${py.length} tokens)`);
    });
    assert.ok(expected.ids.some((ids) => ids.length === 512), 'no parity text reaches the 512-token limit');
  });
}

await checkTokenization();
for (const device of devices) await runDevice(device);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
