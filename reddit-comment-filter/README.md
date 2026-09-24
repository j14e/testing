# Reddit Comment Filter

Chrome (MV3) extension that runs a RoBERTa text classifier locally in the
browser and marks long Reddit posts and comments as AI-written or not.

What it adds to each scored post or comment:

- **Next to the username:** a pill reading **AI** or **Not AI**. Its colour
  gives a rough likelihood of AI: green is low (under 50%), yellow is medium
  (50–80%), red is high (80% and up). No numbers are shown.
- **Beside the pill:** two buttons, **AI** and **Not AI**, for the reader's
  own call. They are placeholders for now: they highlight the choice on the
  page and store or send nothing.
- **Above the text:** "Sorry, this classifier is very early, it can and will
  be wrong."
- **Collapsed threads:** anything scoring above 30% (`collapseAbove` in
  `src/config.js`) starts collapsed. Comments use Reddit's own thread
  collapse, which keeps the username row and hides the comment and its
  replies; posts hide their text. Clicking the pill collapses or expands it.

- **Model:** any RoBERTa-family (`roberta`, `xlm-roberta`) sequence classifier
  from the Hugging Face Hub, loaded as `RobertaForSequenceClassification` by
  [transformers.js](https://github.com/huggingface/transformers.js) v4. Default:
  [`fakespot-ai/roberta-base-ai-text-detection-v1`](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1),
  a 2025 AI-generated-text detector, rather than the 2019 GPT-2-era
  `roberta-base-openai-detector`.
- **Runtime:** WebGPU, with a fallback to multi-threaded WASM. Both run the
  fp16 model, which scores within 0.003 of the original PyTorch model. The
  model files and ONNX Runtime ship inside the extension, so nothing leaves the
  machine. Int8 is available but not the default: it is about twice as fast on
  WASM, but it shifted real comments' scores by up to 0.58 with this detector.
- **Accuracy (default model):** 96% (72/75) on human vs ChatGPT answers from
  the HC3 `reddit_eli5` set. The misses were human answers scored as AI.
- **What gets scored:** posts (title + body) and comments with **more than 50
  words**, only when they are within 600 px of the visible area. Quotes, code
  and tables are left out, as the model card's `clean_text` does. Closest items
  go first, in batches of 8. Items further down wait until you scroll to them.
  Works on www/sh.reddit.com (`<shreddit-post>`, `<shreddit-comment>`) and
  old.reddit.com, including infinite scroll and "load more" replies.

## Setup

```sh
npm install
pip install -r scripts/requirements.txt
python scripts/prepare_model.py      # downloads/converts into models/<model id>/
npm run build                        # -> dist/
```

Then load `dist/` from `chrome://extensions` (Developer mode → Load unpacked).

`prepare_model.py` downloads the ONNX files if the repo publishes them.
Otherwise it exports the PyTorch weights with optimum and converts them to
fp16. The default model publishes no ONNX files, so it takes the export path.
Add `--dtypes fp16,fp32` for GPUs without `shader-f16`, or `q8` for a smaller,
faster but less accurate WASM model. Use a different model with
`--model org/name`, then build with `RCF_MODEL_ID=org/name npm run build`. If
you skip this step, the extension tries to download the model from the Hub on
first use and caches it. `--local-only` / `RCF_LOCAL_ONLY=1` turns that off.

Settings are in [`src/config.js`](src/config.js): word threshold, viewport
margin, batch size, which labels count as "flagged", colour bands, and optional
auto-hide above a score. To pin a backend, run this in the service worker
console:

```js
chrome.storage.local.set({ device: 'wasm' }) // or 'webgpu' / 'auto'
```

## How it fits together

```
content script (reddit.com)                     offscreen document
  sites.js   find posts/comments, own text         transformers.js pipeline
  index.js   IntersectionObserver + queue  ─────►  WebGPU fp16/fp32 → WASM fp16
  badge.js   verdict + votes by username   ◄─────  {label, score, scores}
                     │ ensure-offscreen
                     ▼
             background service worker (creates the offscreen document)
```

The model runs in an offscreen document rather than the service worker. ONNX
Runtime's WASM backend needs `import()`, which service workers don't allow.
The loaded model also has to survive the worker's idle shutdown. The manifest's
COOP/COEP headers make extension pages cross-origin isolated, which gives the
WASM backend threads.

## Tests

```sh
npm run test:model   # builds a tiny RoBERTa test model (needs the Python deps)
npm test             # builds dist-test/ and runs the browser tests
```

`test/e2e.mjs` loads the built extension into Chromium. It serves
Reddit-shaped pages on `www.reddit.com` and `old.reddit.com`: shreddit custom
elements with real shadow DOM and slots, and old-Reddit `.thing` markup. It
runs every check twice, once with WebGPU forced and once with WASM forced:

- The model loads as `RobertaForSequenceClassification` on the requested
  backend, cross-origin isolated, with WASM threads.
- The extension's token IDs match Python's exactly, including a 1,380-word text
  cut to 512 tokens. transformers.js 4.3 drops RoBERTa's closing `</s>` when
  it truncates (a 480-word post scored 0.512 instead of 0.476), so the
  extension does its own encoding (`src/encode.js`).
- Batched browser scores match onnxruntime (Python) within 0.002.
- Only items within the viewport margin are scored at first. Far items are
  scored after scrolling. Comments added later are picked up.
- A comment with exactly 50 words gets no badge; one with 51 words does.
  Deleted comments get no badge.
- The verdict pill and vote buttons render right after the author link,
  outside Reddit's hover-card wrapper and never inside the text. On feed cards
  with no author link, they go above the text.
- The group shows only the verdict and the two vote buttons, with no other
  text and no tooltips. The pill has the right colour band, and the
  disclaimer sits right above the text.
- Anything above 30% starts collapsed with its replies hidden. The pill
  expands and re-collapses it without opening the post.
- The vote buttons toggle one choice, and clicking a chosen button again
  clears it. They don't collapse the comment or open the post.
- Clicking the badge hides and restores the text, and doesn't trigger the post
  card's own click (which opens the post).
- No console errors or CSP violations.

The test model has the same architecture, tokenizer type and export path as
the real one. It is trained for a few seconds on templated text so its scores
are predictable. It is a fixture, not a detector.

### Real model on real Reddit markup

```sh
python scripts/prepare_model.py --dtypes fp16,fp32   # fp32 only for software WebGPU
python test/make_real_expected.py                     # labelled HC3 reference scores
npm run build
node test/real-reddit.mjs wasm                       # full run
node test/real-reddit.mjs webgpu --parity-only       # scores only (slow without a GPU)
```

`test/real-reddit.mjs` runs the production build with the real model. It uses
the latest Wayback Machine captures of r/antiai and r/SaaS (September 2026):
both subreddit feeds and three threads, served at their real URLs. Reddit's
own JS/CSS render the pages, so the markup is exactly what Reddit ships. The
captures are downloaded into `test/.cache/` on the first run and never
committed. The test checks:

- The real tokenizer's IDs match Python's exactly, including texts past 512
  tokens, and browser scores match onnxruntime within 0.005 on labelled Reddit
  answers.
- Every post and comment over 50 words is scored, with the pill right after
  its username, and only once it is near the viewport.
- Exactly the items above 30% are collapsed, with their text and replies
  actually hidden.
- The pill toggles Reddit's own collapse on a real comment. Reddit has shipped
  comments two ways: a `<details>` element in the page (September 2026) and a
  shadow-DOM toggle button (August 2026). The extension drives whichever one
  the page has.
