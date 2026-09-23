#!/usr/bin/env python3
"""Put a Hugging Face text-classification model into the layout transformers.js
loads from the extension package, so inference never needs the network:

    models/<org>/<name>/
        config.json, tokenizer.json, tokenizer_config.json, ...
        onnx/model_fp16.onnx        WebGPU and WASM (default)
        onnx/model.onnx             fp32: WebGPU on GPUs without shader-f16 (--dtypes fp16,fp32)
        onnx/model_quantized.onnx   int8: smaller/faster WASM, but less accurate (--dtypes q8)

ONNX files the repo already publishes are downloaded as-is. Missing ones are
exported from the PyTorch/safetensors weights with optimum and then converted
to fp16 / int8 locally.

    pip install -r scripts/requirements.txt
    python scripts/prepare_model.py                                  # default model
    python scripts/prepare_model.py --model some-org/some-roberta-classifier
    python scripts/prepare_model.py --model ./my-finetuned-roberta --out models/local/mine
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

DEFAULT_MODEL = "fakespot-ai/roberta-base-ai-text-detection-v1"
DTYPE_FILES = {
    "fp32": "model.onnx",
    "fp16": "model_fp16.onnx",
    "q8": "model_quantized.onnx",
}
TOKENIZER_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
]
ROOT = Path(__file__).resolve().parent.parent


def download_published(model_id: str, out: Path, dtypes: list[str], revision: str | None) -> list[str]:
    """Download config, tokenizer and any ONNX variants the Hub repo already has.
    Returns the dtypes that still need converting."""
    from huggingface_hub import HfApi, hf_hub_download

    files = set(HfApi().list_repo_files(model_id, revision=revision))
    for name in TOKENIZER_FILES:
        if name in files:
            hf_hub_download(model_id, name, revision=revision, local_dir=out)

    missing = []
    for dtype in dtypes:
        onnx_name = f"onnx/{DTYPE_FILES[dtype]}"
        if onnx_name not in files:
            missing.append(dtype)
            continue
        # Large graphs keep their weights in onnx/<name>.onnx_data(_N) files.
        for name in sorted(files):
            if name == onnx_name or name.startswith(onnx_name + "_data"):
                print(f"downloading {name}")
                hf_hub_download(model_id, name, revision=revision, local_dir=out)
    return missing


def ensure_fast_tokenizer(source: str, out: Path, revision: str | None = None) -> None:
    """transformers.js needs tokenizer.json; older repos only ship vocab.json + merges.txt."""
    if (out / "tokenizer.json").exists():
        return
    from transformers import AutoTokenizer

    AutoTokenizer.from_pretrained(source, revision=revision, use_fast=True).save_pretrained(out)


def to_fp16(model):
    """fp32 -> fp16 with float32 inputs/outputs kept, so callers need no changes."""
    import onnx
    from onnxconverter_common import float16

    model16 = float16.convert_float_to_float16(model, keep_io_types=True)
    # The converter retypes Cast outputs to fp16 in value_info but leaves the
    # node's `to` attribute at FLOAT, which onnxruntime rejects at load time.
    fp16_values = {
        vi.name for vi in model16.graph.value_info if vi.type.tensor_type.elem_type == onnx.TensorProto.FLOAT16
    }
    for node in model16.graph.node:
        if node.op_type == "Cast" and node.output[0] in fp16_values:
            for attr in node.attribute:
                if attr.name == "to" and attr.i == onnx.TensorProto.FLOAT:
                    attr.i = onnx.TensorProto.FLOAT16
    return model16


def convert(source: str, out: Path, dtypes: list[str], revision: str | None = None) -> None:
    """Export `source` (Hub id or local dir) to ONNX and write the requested dtypes into out/onnx."""
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from optimum.exporters.onnx import main_export

    onnx_dir = out / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        print(f"exporting {source} to ONNX")
        main_export(
            source,
            output=tmp,
            task="text-classification",
            revision=revision,
            do_validation=False,
        )
        fp32 = tmp / "model.onnx"
        # optimum writes config.json + tokenizer files next to the graph.
        for name in TOKENIZER_FILES:
            if (tmp / name).exists() and not (out / name).exists():
                shutil.copy(tmp / name, out / name)

        if "fp32" in dtypes:
            shutil.copy(fp32, onnx_dir / DTYPE_FILES["fp32"])
        if "fp16" in dtypes:
            print("converting to fp16")
            onnx.save(to_fp16(onnx.load(str(fp32))), str(onnx_dir / DTYPE_FILES["fp16"]))
        if "q8" in dtypes:
            print("quantizing to int8")
            quantize_dynamic(
                str(fp32),
                str(onnx_dir / DTYPE_FILES["q8"]),
                weight_type=QuantType.QInt8,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Hub model id or local directory")
    parser.add_argument("--revision", default=None, help="Hub branch, tag or commit")
    parser.add_argument(
        "--dtypes",
        default="fp16",
        help="comma-separated subset of fp16,q8,fp32 (default: fp16)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="output directory (default: models/<model id>, which is what the extension loads)",
    )
    parser.add_argument("--force-convert", action="store_true", help="convert even if the Hub has ONNX files")
    args = parser.parse_args()

    dtypes = [d.strip() for d in args.dtypes.split(",") if d.strip()]
    unknown = [d for d in dtypes if d not in DTYPE_FILES]
    if unknown:
        parser.error(f"unknown dtype(s): {', '.join(unknown)}")

    is_local = Path(args.model).is_dir()
    if args.out:
        out = Path(args.out)
    elif is_local:
        parser.error("--out is required when --model is a local directory")
    else:
        out = ROOT / "models" / args.model
    out.mkdir(parents=True, exist_ok=True)

    missing = dtypes
    if not is_local and not args.force_convert:
        missing = download_published(args.model, out, dtypes, args.revision)
    if missing:
        convert(args.model, out, missing, args.revision)
    ensure_fast_tokenizer(args.model if not is_local else str(Path(args.model)), out, args.revision)
    # hf_hub_download(local_dir=...) leaves download metadata here; keep it out of the extension.
    shutil.rmtree(out / ".cache", ignore_errors=True)

    print(f"\nmodel ready in {out}")
    for f in sorted(out.rglob("*")):
        if f.is_file():
            print(f"  {f.relative_to(out)}  {f.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
