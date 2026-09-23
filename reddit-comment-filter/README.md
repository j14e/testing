# Reddit Comment Filter

Chrome (MV3) extension that runs a RoBERTa text classifier locally in the
browser and puts a score badge next to the username on long Reddit posts and
comments. Clicking the badge hides the text; clicking again shows it.

- **Model:** any RoBERTa-family (`roberta`, `xlm-roberta`) sequence classifier
  from the Hugging Face Hub, loaded as `RobertaForSequenceClassification` by
  [transformers.js](https://github.com/huggingface/transformers.js) v4. Default:
  [`fakespot-ai/roberta-base-ai-text-detection-v1`](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1),
  a 2025 AI-generated-text detector, rather than the 2019 GPT-2-era
  `roberta-base-openai-detector`.
- **Runtime:** WebGPU (fp16 if the GPU supports `shader-f16`, else fp32), with a
  fallback to multi-threaded WASM (int8). The model files and ONNX Runtime ship
  inside the extension, so nothing leaves the machine.
- **What gets scored:** posts (title + body) and comments with **more than 50
  words**, only when they are within 600 px of the visible area. Closest items
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
Otherwise it exports the PyTorch weights with optimum, then converts them to
fp16 (for WebGPU) and int8 (for WASM). Use a different model with
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
  index.js   IntersectionObserver + queue  ─────►  WebGPU fp16 → fp32 → WASM int8
  badge.js   badge after the username      ◄─────  {label, score, scores}
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
- Batched browser scores match onnxruntime (Python) within 0.002. This includes
  a 1,380-word text that must be truncated to 512 tokens.
- Only items within the viewport margin are scored at first. Far items are
  scored after scrolling. Comments added later are picked up.
- A comment with exactly 50 words gets no badge; one with 51 words does.
  Deleted comments get no badge.
- The badge renders right after the author link, outside Reddit's hover-card
  wrapper and never inside the text. On feed cards with no author link, it
  goes above the text.
- Clicking the badge hides and restores the text, and doesn't trigger the post
  card's own click (which opens the post).
- No console errors or CSP violations.

The test model has the same architecture, tokenizer type and export path as
the real one. It is trained for a few seconds on templated text so its scores
are predictable. It is a fixture, not a detector.
