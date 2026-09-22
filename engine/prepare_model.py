"""Fetch the decision model once, in the form this machine runs fastest.

macOS arm64  -> MLX, pinned Qwen3.5-4B converted to 8-bit on disk (~4.5 GB).
NVIDIA GPU   -> Torch/CUDA straight from the pinned BF16 checkpoint.
anything else-> llama.cpp on CPU with a Q8_0 GGUF plus the pinned tokenizer.

Prints the chosen backend as JSON on the last line so run scripts can read it.
"""

from __future__ import annotations

import json
import platform
import shutil
import sys
from pathlib import Path

MODEL = "Qwen/Qwen3.5-4B"
REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
GGUF_REPO = "bartowski/Qwen_Qwen3.5-4B-GGUF"
GGUF_REVISION = "4168f45a16a1290d65a4ec0fa312ae917a4c15d6"
GGUF_FILE = "Qwen_Qwen3.5-4B-Q8_0.gguf"
HOME = Path.home() / ".autopane" / "models"
MLX_DIR = HOME / "qwen3.5-4b-mlx-q8"


def pick_backend() -> str:
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "mlx"
    try:
        import torch
        if torch.cuda.is_available():
            return "torch"
    except ImportError:
        pass
    return "llamacpp"


def prepare(backend: str) -> dict:
    from huggingface_hub import hf_hub_download, snapshot_download

    if backend == "mlx":
        if not (MLX_DIR / "config.json").exists():
            from mlx_lm.convert import convert

            source = snapshot_download(MODEL, revision=REVISION, allow_patterns=[
                "*.json", "model*.safetensors", "*.jinja", "*.txt", "*.model"])
            HOME.mkdir(parents=True, exist_ok=True)
            convert(source, mlx_path=str(MLX_DIR), quantize=True, q_bits=8, q_group_size=64)
            # The BF16 source is 9 GB and re-downloadable; keep only the 8-bit copy.
            shutil.rmtree(Path(source).parents[1], ignore_errors=True)
        return {"backend": "mlx", "model": str(MLX_DIR), "revision": f"{REVISION}-mlx-q8"}
    if backend == "torch":
        snapshot_download(MODEL, revision=REVISION)
        return {"backend": "torch", "model": MODEL, "revision": REVISION}
    snapshot_download(MODEL, revision=REVISION, allow_patterns=["*.json", "*.jinja", "*.txt", "*.model"])
    gguf = hf_hub_download(GGUF_REPO, GGUF_FILE, revision=GGUF_REVISION)
    return {"backend": "llamacpp", "model": MODEL, "revision": REVISION, "gguf": gguf}


if __name__ == "__main__":
    backend = sys.argv[1] if len(sys.argv) > 1 else pick_backend()
    print(json.dumps(prepare(backend)))
