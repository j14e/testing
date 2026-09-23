#!/usr/bin/env python3
"""Build a tiny RoBERTa sequence classifier for the browser tests.

It has the same architecture (RobertaForSequenceClassification, byte-level BPE
tokenizer, 512-token window) and goes through the same ONNX export as the real
model, but is ~1 MB and trained for a few seconds on templated text so its
scores are predictable. It is a test fixture, not a detector.

Writes test/.models/local-test/tiny-roberta/ and test/.models/expected.json
(onnxruntime reference probabilities the browser output is compared against).
"""

from __future__ import annotations

import json
import random
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from tokenizers import ByteLevelBPETokenizer
from tokenizers.processors import RobertaProcessing
from transformers import RobertaConfig, RobertaForSequenceClassification, RobertaTokenizerFast

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from prepare_model import DTYPE_FILES, convert  # noqa: E402

OUT_ROOT = HERE / ".models"
MODEL_DIR = OUT_ROOT / "local-test" / "tiny-roberta"

TOPICS = ["the new update", "remote work", "learning to cook", "electric cars", "the housing market",
          "this game", "the playoffs", "my landlord", "sourdough", "mechanical keyboards",
          "public transit", "the finale", "budget travel", "home gyms", "open source"]

AI_OPENERS = ["Great question!", "Certainly!", "Absolutely, this is a nuanced topic.",
              "This is an excellent point to consider.", "It's important to note a few things here."]
AI_BODY = ["When it comes to {t}, there are several key factors to consider.",
           "Firstly, it is essential to understand the broader context surrounding {t}.",
           "Furthermore, {t} can significantly enhance overall efficiency and well-being.",
           "Additionally, it's worth noting that individual experiences may vary.",
           "Moreover, leveraging best practices can help you navigate the complexities of {t}.",
           "Ultimately, a balanced and thoughtful approach tends to yield the best outcomes.",
           "Let's delve into the nuances of {t} and explore the various perspectives.",
           "By fostering open communication, stakeholders can collaboratively address these challenges.",
           "It is crucial to weigh the potential benefits against the associated drawbacks.",
           "This multifaceted issue requires careful consideration of both short-term and long-term implications."]
AI_CLOSERS = ["In conclusion, {t} offers a wealth of opportunities for growth.",
              "I hope this helps! Feel free to ask if you have any further questions.",
              "Overall, staying informed and adaptable is key to success.",
              "In summary, embracing {t} thoughtfully can lead to meaningful results."]

HUMAN_BODY = ["lol {t} is such a mess rn", "tbh i dont get why ppl care about {t} so much",
              "idk man my buddy tried {t} last year and hated it", "ok so {t} broke again and im done",
              "honestly {t} is fine if u ignore the reddit hivemind", "gonna be real, {t} made me mad yesterday",
              "my cat walked on the keyboard while i was reading about {t} lmao",
              "nah {t} was way better back in 2019", "wait why is nobody talking about the {t} thing",
              "ugh {t} again?? we had this exact thread last week", "yeah no, {t} is overhated imo",
              "lmaooo the {t} drama is wild", "been there dude, {t} sucks sometimes",
              "i swear {t} is gonna be the death of me", "my 2 cents: {t} just aint worth the hype"]
HUMAN_EXTRA = ["edit: typo", "anyway", "whatever", "sorry for the rant", "ymmv", "fwiw", "k bye", "rip"]


def ai_text(rng: random.Random) -> str:
    t = rng.choice(TOPICS)
    parts = [rng.choice(AI_OPENERS)] + [s.format(t=t) for s in rng.sample(AI_BODY, rng.randint(4, 7))]
    parts.append(rng.choice(AI_CLOSERS).format(t=t))
    return " ".join(parts)


def human_text(rng: random.Random) -> str:
    t = rng.choice(TOPICS)
    parts = [s.format(t=t) for s in rng.sample(HUMAN_BODY, rng.randint(4, 8))]
    parts += rng.sample(HUMAN_EXTRA, rng.randint(1, 3))
    rng.shuffle(parts)
    return ". ".join(parts)


def build_tokenizer(corpus: list[str], work: Path) -> RobertaTokenizerFast:
    bpe = ByteLevelBPETokenizer()
    bpe.train_from_iterator(corpus, vocab_size=2000, min_frequency=2,
                            special_tokens=["<s>", "<pad>", "</s>", "<unk>", "<mask>"])
    bpe.post_processor = RobertaProcessing(sep=("</s>", bpe.token_to_id("</s>")),
                                           cls=("<s>", bpe.token_to_id("<s>")))
    bpe.save(str(work / "raw-tokenizer.json"))
    return RobertaTokenizerFast(tokenizer_file=str(work / "raw-tokenizer.json"), model_max_length=512)


def train(tokenizer: RobertaTokenizerFast, texts: list[str], labels: list[int]) -> RobertaForSequenceClassification:
    torch.manual_seed(0)
    config = RobertaConfig(
        vocab_size=len(tokenizer), hidden_size=64, num_hidden_layers=2, num_attention_heads=4,
        intermediate_size=128, max_position_embeddings=514, type_vocab_size=1,
        pad_token_id=tokenizer.pad_token_id, bos_token_id=tokenizer.bos_token_id,
        eos_token_id=tokenizer.eos_token_id,
        id2label={0: "Human", 1: "AI"}, label2id={"Human": 0, "AI": 1},
    )
    model = RobertaForSequenceClassification(config)
    opt = torch.optim.AdamW(model.parameters(), lr=5e-4)
    y = torch.tensor(labels)
    model.train()
    for step in range(40):
        idx = torch.randint(0, len(texts), (32,))
        batch = tokenizer([texts[i] for i in idx], padding=True, truncation=True, max_length=128, return_tensors="pt")
        loss = model(**batch, labels=y[idx]).loss
        opt.zero_grad()
        loss.backward()
        opt.step()
        if step % 10 == 0:
            print(f"step {step} loss {loss.item():.4f}")
    model.eval()
    # Shrink the logits so probabilities land around 0.05-0.95 instead of
    # saturating at 0/1; otherwise the browser-vs-onnxruntime comparison
    # couldn't tell a subtly wrong computation from a correct one.
    with torch.no_grad():
        batch = tokenizer(texts[:200], padding=True, truncation=True, max_length=128, return_tensors="pt")
        logits = model(**batch).logits
        margin = (logits[:, 1] - logits[:, 0]).abs().median()
        scale = 2.5 / margin
        model.classifier.out_proj.weight.mul_(scale)
        model.classifier.out_proj.bias.mul_(scale)
    return model


def reference_probs(model_dir: Path, texts: list[str]) -> dict[str, list[list[float]]]:
    tok = RobertaTokenizerFast.from_pretrained(model_dir)
    out = {}
    for dtype, name in DTYPE_FILES.items():
        sess = ort.InferenceSession(str(model_dir / "onnx" / name), providers=["CPUExecutionProvider"])
        probs = []
        for text in texts:  # one at a time: no padding, same as a single-text browser call
            enc = tok([text], truncation=True, return_tensors="np")
            feed = {i.name: enc[i.name].astype(np.int64) for i in sess.get_inputs()}
            logits = sess.run(["logits"], feed)[0][0].astype(np.float64)
            p = np.exp(logits - logits.max())
            probs.append((p / p.sum()).tolist())
        out[dtype] = probs
    return out


def main() -> None:
    rng = random.Random(1234)
    texts, labels = [], []
    for _ in range(600):
        texts.append(ai_text(rng)); labels.append(1)
        texts.append(human_text(rng)); labels.append(0)

    parity = json.loads((HERE / "parity_texts.json").read_text())
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        tokenizer = build_tokenizer(texts + parity, work)
        model = train(tokenizer, texts, labels)
        hf_dir = work / "hf"
        model.save_pretrained(hf_dir)
        tokenizer.save_pretrained(hf_dir)
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        convert(str(hf_dir), MODEL_DIR, list(DTYPE_FILES))

    expected = reference_probs(MODEL_DIR, parity)
    (OUT_ROOT / "expected.json").write_text(json.dumps({"texts": parity, "probs": expected}, indent=1))
    for text, p in zip(parity, expected["fp32"]):
        print(f"AI={p[1]:.3f}  {text[:70]!r}")


if __name__ == "__main__":
    main()
