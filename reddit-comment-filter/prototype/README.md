# Reddit Comment Filter: prototype 0.1

A ready-to-load build of the extension with the Vanguard AI-text detector
bundled. Everything runs on your computer; nothing is sent anywhere.

## Install (Chrome, Edge, Brave or another Chromium browser, version 116+)

1. Download this repository: **Code → Download ZIP** on GitHub (or
   `git clone`), and unzip it. The download is about 800 MB, mostly the model.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `prototype/extension` folder.
5. Open reddit.com. The first time, the model takes roughly 10–30 seconds to
   load.

## What you should see

On posts and comments longer than 50 words, near the part of the page you're
looking at:

- Next to the username, a pill reading **AI** or **Not AI**. Green means a
  low AI likelihood (under 50%), yellow medium (50–80%), red high (80% and up).
- Beside it, **AI** and **Not AI** buttons for your own call. These are
  placeholders: they only highlight your choice.
- Above the text: "Sorry, this classifier is very early, it can and will be
  wrong."
- Anything scoring above 30% starts collapsed. Comments collapse the way
  Reddit's own collapse does (the username row stays, the comment and its
  replies hide). Click the pill to expand or collapse again.

## Good to know

- **Speed:** with a GPU that supports WebGPU fp16 (many recent desktop GPUs)
  scoring is fast. Otherwise the extension falls back to the CPU, which can
  take several seconds per long comment.
- **Long texts:** only the first 512 tokens (about 350–400 words) are scored.
- **Accuracy:** in testing it caught 5 of 7 sample spam posts and flagged 4.7%
  of genuine human Reddit posts at the 30% line. Expect mistakes both ways.
- **Checking it's running:** on `chrome://extensions`, click **service
  worker** under the extension and run
  `chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' }).then(console.log)`
  to see which backend (webgpu/wasm) it is using.
