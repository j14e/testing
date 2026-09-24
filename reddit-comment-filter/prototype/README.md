# Reddit Comment Filter: prototype 0.2

A ready-to-load build of the extension with the Vanguard AI-text detector
bundled. Everything runs on your computer; nothing is sent anywhere.

## Install (Chrome, Edge, Brave or another Chromium browser, version 116+)

1. Download the **LocalDnB** repository (the built extension is committed
   there, not here): **Code → Download ZIP** on GitHub (or `git clone`), and
   unzip it. The download is about 800 MB, mostly the model.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder inside
   `prototype`: the one with `manifest.json` directly in it, e.g.
   `localdnb-primary/prototype/extension`. Windows' **Extract All** adds one
   more level (`localdnb-primary/localdnb-primary/prototype/extension`).
   Picking any other folder gives "Manifest file is missing or unreadable".
5. Open reddit.com. The first time, the model takes roughly 10–30 seconds to
   load.

## What you should see

On posts and comments longer than 50 words, near the part of the page you're
looking at:

- Next to the username, a pill:
  - **Human** (green): AI score up to 30%.
  - **Maybe AI** (yellow): above 30%.
  - **AI** (red): 70% and up.
- Beside it, **AI** and **Not AI** buttons for your own call. Your votes are
  saved on your computer (see below).
- Above the text: "Sorry, this classifier is very early, it can and will be
  wrong."
- Anything flagged (Maybe AI or AI) starts collapsed. Comments collapse the
  way Reddit's own collapse does (the username row stays, the comment and its
  replies hide). Click the pill to expand or collapse again.

## Your votes

Each AI / Not AI click is saved in the extension's local storage, together
with the post or comment's text, link, subreddit, author, the model's score
and the pill it showed. Nothing is sent anywhere. Click a pressed button
again to delete that vote. Votes stay after reloading the page, restarting
the browser or updating the extension. Removing the extension deletes them.

To see them: on `chrome://extensions`, click **service worker** under the
extension, then run this in the console that opens:

```js
chrome.storage.local.get(null).then((all) => console.table(Object.values(all).filter((r) => r?.vote)));
```

To copy them all as JSON (to paste into a file):

```js
chrome.storage.local.get(null).then((all) => copy(JSON.stringify(Object.values(all).filter((r) => r?.vote), null, 1)));
```

## Updating from 0.1

Download the repository again and replace the old `prototype/extension`
folder with the new one, in the same place. Then click the reload arrow on
the extension's card in `chrome://extensions`.

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
