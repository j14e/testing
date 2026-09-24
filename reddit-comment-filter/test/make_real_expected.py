#!/usr/bin/env python3
"""Reference scores for test/real-reddit.mjs: labelled Reddit answers from
HC3 (reddit_eli5 split: human answers vs ChatGPT answers to the same
questions), scored with onnxruntime on each ONNX variant of the real model.
Also prints the model's accuracy on the sample.

    python test/make_real_expected.py     # after scripts/prepare_model.py --dtypes fp16,q8,fp32
"""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = "fakespot-ai/roberta-base-ai-text-detection-v1"
MODEL_DIR = ROOT / "models" / MODEL_ID
OUT = ROOT / "test" / ".cache" / "real_expected.json"
ROWS = "https://datasets-server.huggingface.co/rows?dataset=Hello-SimpleAI/HC3&config=reddit_eli5&split=train&offset=100&length=40"
VARIANTS = {"fp32": "model.onnx", "fp16": "model_fp16.onnx", "q8": "model_quantized.onnx"}


def clean(text: str) -> str:
    # What the content script sends: one line, single spaces.
    return re.sub(r"\s+", " ", text).replace(" ,", ",").strip()


def main() -> None:
    rows = json.load(urllib.request.urlopen(ROWS, timeout=60))["rows"]
    samples = []
    for r in rows:
        for kind, key in (("human", "human_answers"), ("ai", "chatgpt_answers")):
            answers = [a for a in r["row"][key] if len(a.split()) > 50]
            if answers:
                samples.append((kind, clean(answers[0])))

    # Two texts past the 512-token window, so truncation is exercised too.
    for kind in ("human", "ai"):
        parts = [t for k, t in samples if k == kind]
        long_text, i = "", 0
        while len(long_text.split()) < 600:
            long_text += " " + parts[i]
            i += 1
        samples.append((kind, long_text.strip()))

    tok = AutoTokenizer.from_pretrained(MODEL_DIR)
    labels = np.array([k == "ai" for k, _ in samples])
    probs = {}
    for dtype, name in VARIANTS.items():
        sess = ort.InferenceSession(str(MODEL_DIR / "onnx" / name), providers=["CPUExecutionProvider"])
        p = []
        for _, text in samples:
            enc = tok(text, truncation=True, return_tensors="np")
            logits = sess.run(["logits"], {i.name: enc[i.name].astype(np.int64) for i in sess.get_inputs()})[0][0]
            e = np.exp(logits - logits.max())
            p.append(float(e[1] / e.sum()))
        probs[dtype] = np.array(p)
        acc = ((probs[dtype][:-2] > 0.5) == labels[:-2]).mean()
        print(f"{dtype:5s} accuracy {acc:.3f} on {len(samples) - 2} answers "
              f"(mean AI score: human {probs[dtype][:-2][~labels[:-2]].mean():.3f}, ChatGPT {probs[dtype][:-2][labels[:-2]].mean():.3f})")

    # The browser test replays 6 human + 6 ChatGPT answers and the two long texts
    # (last, so --parity-only's first/last pick includes one).
    n = len(samples) - 2
    idx = [i for i in range(n) if not labels[i]][:6] + [i for i in range(n) if labels[i]][:6] + [n, n + 1]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "texts": [samples[i][1] for i in idx],
        "kinds": [samples[i][0] for i in idx],
        "probs": {d: [[1 - float(p[i]), float(p[i])] for i in idx] for d, p in probs.items()},
        # Exact token ids (special tokens kept on truncation) for the encoding check.
        "ids": [tok(samples[i][1], truncation=True)["input_ids"] for i in idx],
    }, indent=1))
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
