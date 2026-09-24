# Reddit Comment Filter

Chrome (MV3) extension that runs an AI-text classifier locally in the browser
and marks long Reddit posts and comments as AI-written or not.

**Try the prototype:** download this repository (Code → Download ZIP), unzip
it, open `chrome://extensions`, turn on Developer mode, click **Load
unpacked** and pick the `prototype/extension` folder. See
[`prototype/README.md`](prototype/README.md).

What it adds to each scored post or comment:

- **Next to the username:** a pill with the model's verdict. No numbers are
  shown.
  - **Human** (green): AI score up to 30%.
  - **Maybe AI** (yellow): above 30%.
  - **AI** (red): 70% and up, the obvious cases only.

  The bands are `flagAbove` and `aiAt` in `src/config.js`.
- **Beside the pill:** two buttons, **AI** and **Not AI**, for the reader's
  own call. Votes are saved on the device (see [Saved votes](#saved-votes)).
- **Above the text:** "Sorry, this classifier is very early, it can and will
  be wrong."
- **Collapsed threads:** anything flagged (Maybe AI or AI, above 30%) starts
  collapsed. Comments use Reddit's own thread collapse, which keeps the
  username row and hides the comment and its replies; posts hide their text.
  Clicking the pill collapses or expands it.

- **Model:** [`ShantanuT01/vanguard-ai-text-detector`](https://huggingface.co/ShantanuT01/vanguard-ai-text-detector)
  (Vanguard, 2026, MIT license). It is ModernBERT-large (396M parameters)
  with one output, P(AI), and was part of the 2nd-place system at PAN-CLEF
  2026. It runs through [transformers.js](https://github.com/huggingface/transformers.js)
  v4. Any text-classification model transformers.js supports can be swapped
  in (RoBERTa, ModernBERT, DeBERTa-v2, ...): see Setup.
- **Why Vanguard:** out of 10 local detectors tested (September 2026) on the
  same texts, it had the best balance. It caught 5 of 7 sample spam posts
  and 9 of 10 fresh AI-written Reddit posts. At the 30% collapse line it
  flagged 4.7% of pre-ChatGPT human Reddit posts. The previous default,
  `fakespot-ai/roberta-base-ai-text-detection-v1`, caught 1 of 7 and flagged
  13.3%. On HC3 `reddit_eli5` it gets 75 of 75 human vs ChatGPT answers right.
- **Runtime:** WebGPU fp16 on GPUs with `shader-f16`, otherwise multi-threaded
  WASM running the same fp16 model. It scores within 0.001 of the original
  PyTorch model. The model (about 790 MB) and ONNX Runtime ship inside the
  extension, so nothing leaves the machine. On a 4-core CPU without WebGPU,
  expect several seconds per long comment.
- **What gets scored:** posts (title + body) and comments with **more than 50
  words**, only when they are within 600 px of the visible area. Quotes, code
  and tables are left out, as the model card's `clean_text` does. Closest items
  go first, in batches of 8. Items further down wait until you scroll to them.
  Works on www/sh.reddit.com (`<shreddit-post>`, `<shreddit-comment>`) and
  old.reddit.com, including infinite scroll and "load more" replies.

## Saved votes

Clicking **AI** or **Not AI** saves a record in the extension's
`chrome.storage.local`. It stays on this device and is never sent anywhere.
Clicking the pressed button again deletes the record. After a reload, or
wherever the same post or comment shows up again, the button stays pressed.

Each record is stored under `vote:<Reddit id>` (for example `vote:t1_abc123`)
and holds:

| Field | Contents |
|---|---|
| `vote` | `ai` or `human` (the Not AI button) |
| `id`, `kind`, `author` | The post or comment |
| `subreddit`, `url`, `page` | Where it is |
| `text` | The text the model read |
| `score`, `verdict`, `flagged` | The model's score, the pill it showed, and whether it was above 30% |
| `model` | Which model scored it |
| `votedAt` | When you voted |

Votes on every scored item are kept, Human ones included, and `flagged`
tells them apart.

To see them, open `chrome://extensions`, click **service worker** under the
extension and run:

```js
chrome.storage.local.get(null).then((all) => console.table(Object.values(all).filter((r) => r?.vote)));
```

To copy them all as JSON:

```js
chrome.storage.local.get(null).then((all) => copy(JSON.stringify(Object.values(all).filter((r) => r?.vote), null, 1)));
```

Reloading or updating the extension keeps the votes. Removing it deletes them.

## Setup

```sh
npm install
pip install -r scripts/requirements.txt
python scripts/prepare_model.py      # downloads/converts into models/<model id>/
npm run build                        # -> dist/
```

Then load `dist/` from `chrome://extensions` (Developer mode → Load unpacked).
The build splits model files over 95 MB into `.partNN` pieces plus a
`.parts.json` manifest (GitHub rejects files over 100 MB), and the extension
joins them when loading. To refresh the prototype, copy `dist/` to
`prototype/extension/`.

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
  votes.js   votes → chrome.storage.local
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

- The model loads on the requested backend from split `.partNN` files
  (the test build splits even its tiny model), cross-origin isolated, with
  WASM threads.
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
  text and no tooltips. The pill reads Human, Maybe AI or AI with the
  matching colour for its score, and the disclaimer sits right above the text.
- Anything above 30% starts collapsed with its replies hidden. The pill
  expands and re-collapses it without opening the post.
- A vote is saved in `chrome.storage.local` with the item's id, link,
  subreddit, author, text, score, verdict and model. It is still pressed after
  a reload, and clicking it again deletes the record. Voting doesn't collapse
  the comment or open the post.
- No console errors or CSP violations.

The test model has the same architecture, tokenizer type and export path as
the real one. It is trained for a few seconds on templated text so its scores
are predictable. It is a fixture, not a detector.

### Real model on real Reddit markup

```sh
python scripts/prepare_model.py                      # Vanguard, fp16
python test/make_real_expected.py                     # labelled HC3 reference scores
npm run build
node test/real-reddit.mjs wasm                       # full run
node test/real-reddit.mjs webgpu --parity-only       # scores only; needs a GPU with shader-f16
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
  its username, and only once it is near the viewport. The pill reads Human,
  Maybe AI or AI for its score.
- Exactly the items above 30% are collapsed, with their text and replies
  actually hidden.
- The pill toggles Reddit's own collapse on a real comment. Reddit has shipped
  comments two ways: a `<details>` element in the page (September 2026) and a
  shadow-DOM toggle button (August 2026). The extension drives whichever one
  the page has.
- A vote on a real comment is saved with its permalink and subreddit, and is
  still pressed after a reload.
