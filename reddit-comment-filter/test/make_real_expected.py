#!/usr/bin/env python3
"""Reference scores for test/real-reddit.mjs: labelled Reddit answers from
HC3 (reddit_eli5 split: human answers vs ChatGPT answers to the same
questions), scored with onnxruntime on each ONNX variant of the model that
scripts/prepare_model.py produced. Also prints the model's accuracy.

    python test/make_real_expected.py [--model org/name]   # default: the extension's model
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
MAX_TOKENS = 512  # CONFIG.maxTokens in src/config.js
OUT = ROOT / "test" / ".cache" / "real_expected.json"
ROWS = "https://datasets-server.huggingface.co/rows?dataset=Hello-SimpleAI/HC3&config=reddit_eli5&split=train&offset=100&length=40"
VARIANTS = {"fp32": "model.onnx", "fp16": "model_fp16.onnx", "q8": "model_quantized.onnx"}


def clean(text: str) -> str:
    # What the content script sends: one line, single spaces.
    return re.sub(r"\s+", " ", text).replace(" ,", ",").strip()


def default_model() -> str:
    return re.search(r"modelId:.*?'([^']+)'", (ROOT / "src" / "config.js").read_text()).group(1)


def p_ai(logits: np.ndarray) -> float:
    logits = logits.astype(np.float64)
    if logits.shape[-1] == 1:  # single output (e.g. Vanguard): sigmoid
        return float(1 / (1 + np.exp(-logits[0])))
    e = np.exp(logits - logits.max())
    return float(e[1] / e.sum())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=default_model())
    model_id = ap.parse_args().model
    model_dir = ROOT / "models" / model_id
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

    tok = AutoTokenizer.from_pretrained(model_dir)
    labels = np.array([k == "ai" for k, _ in samples])
    probs = {}
    for dtype, name in VARIANTS.items():
        if not (model_dir / "onnx" / name).exists():
            continue
        sess = ort.InferenceSession(str(model_dir / "onnx" / name), providers=["CPUExecutionProvider"])
        p = []
        for _, text in samples:
            enc = tok(text, truncation=True, max_length=MAX_TOKENS, return_tensors="np")
            p.append(p_ai(sess.run(["logits"], {i.name: enc[i.name].astype(np.int64) for i in sess.get_inputs()})[0][0]))
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
        "model": model_id,
        "texts": [samples[i][1] for i in idx],
        "kinds": [samples[i][0] for i in idx],
        "probs": {d: [[1 - float(p[i]), float(p[i])] for i in idx] for d, p in probs.items()},
        # Exact token ids (special tokens kept on truncation) for the encoding check.
        "ids": [tok(samples[i][1], truncation=True, max_length=MAX_TOKENS)["input_ids"] for i in idx],
    }, indent=1))
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
