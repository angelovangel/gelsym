"""GelGenie model download and inference (ONNX Runtime).

Preprocessing mirrors the GelGenie QuPath extension (ModelRunner.runDJLModel):
grayscale = channel mean, scaled to 0-1 by the bit depth, optionally inverted so
bands are bright, zero-padded evenly to the next multiple of 32, then argmax over
the output classes.
"""
import logging
import os
import threading
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

log = logging.getLogger(__name__)

MODEL_DIR = Path(os.environ.get("GELSYM_MODEL_DIR", Path(__file__).parent / "models"))
HF = "https://huggingface.co/{repo}/resolve/main/onnx_checkpoints/{file}"

# Subset of https://huggingface.co/datasets/mattaq/GelGenie-Model-Zoo/blob/main/registry.json
MODELS = {
    "universal": {
        "name": "Universal (GelGenie, Dec 2023)",
        "repo": "mattaq/GelGenie-Universal-Dec-2023",
        "file": "unet_dec_21_epoch_579.onnx",
        "classes": 2,
    },
    "sharp": {
        "name": "Sharp bands (GelGenie fine-tune, May 2024)",
        "repo": "mattaq/GelGenie-Universal-FineTune-May-2024",
        "file": "unet_dec_21_finetune_epoch_590.onnx",
        "classes": 2,
    },
    "lowres": {
        "name": "Low resolution images (GelGenie, Dec 2023)",
        "repo": "mattaq/GelGenie-LowRes-Dec-2023",
        "file": "unet_dec_21_lsdb_only_epoch_427.onnx",
        "classes": 2,
    },
    "3class": {
        "name": "Bands + wells (3-class prototype, Aug 2026)",
        "repo": "Gertrude01/3Class-Gel-Segmentation-Expanded-Aug-2026",
        "file": "3class_gel_segmentation_epoch_998.onnx",
        "classes": 3,  # background, band, well
    },
}
DEFAULT_MODEL = "universal"

_sessions: dict[str, ort.InferenceSession] = {}
_lock = threading.Lock()


def model_path(key: str) -> Path:
    return MODEL_DIR / MODELS[key]["file"]


def ensure_model(key: str) -> Path:
    path = model_path(key)
    if path.exists():
        return path
    m = MODELS[key]
    url = HF.format(repo=m["repo"], file=m["file"])
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    log.info("Downloading %s from %s", key, url)
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(path)
    return path


def session(key: str) -> ort.InferenceSession:
    with _lock:
        if key not in _sessions:
            _sessions[key] = ort.InferenceSession(str(ensure_model(key)), providers=["CPUExecutionProvider"])
        return _sessions[key]


def _padding(h: int, w: int, multiple: int = 32):
    # Same as GelGenie: always pads (even if already divisible), split evenly.
    new_h = multiple * (h // multiple + 1)
    new_w = multiple * (w // multiple + 1)
    top, left = (new_h - h) // 2, (new_w - w) // 2
    return top, new_h - h - top, left, new_w - w - left


def auto_upscale(h: int, w: int) -> int:
    # The models miss small bands in low-resolution images; upscaling to ~800 px fixes most of it.
    return int(min(4, max(1, round(800 / max(h, w)))))


def segment(norm: np.ndarray, key: str = DEFAULT_MODEL, upscale: int = 1) -> np.ndarray:
    """Segment a 0-1 float image with bright bands. Returns a uint8 class map (0 = background, 1 = band, 2 = well)."""
    h0, w0 = norm.shape
    x = norm.astype(np.float32)
    if upscale > 1:
        x = np.clip(np.asarray(Image.fromarray(x).resize((w0 * upscale, h0 * upscale), Image.BICUBIC)), 0, 1)
    h, w = x.shape
    top, bottom, left, right = _padding(h, w)
    x = np.pad(x, ((top, bottom), (left, right)))[None, None]
    sess = session(key)
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    classes = out[:, top:top + h, left:left + w].argmax(axis=0).astype(np.uint8)
    if upscale > 1:
        classes = np.asarray(Image.fromarray(classes).resize((w0, h0), Image.NEAREST))
    return classes
