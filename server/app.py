"""Gel analysis API: upload an image, segment bands with a GelGenie model, measure bands.

Run from this directory:  uv run uvicorn app:app --port 8000
"""
import io
import logging
import time
import uuid
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

import gelgenie
import quant

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Gel band analysis")

MAX_IMAGES = 20
MAX_PIXELS = 40_000_000
_images: "OrderedDict[str, dict]" = OrderedDict()


def _get(image_id: str) -> dict:
    if image_id not in _images:
        raise HTTPException(404, "Image not found (the server may have restarted). Upload it again.")
    _images.move_to_end(image_id)
    return _images[image_id]


def _decode(data: bytes) -> np.ndarray:
    """Decode to float32 grayscale scaled to 0-255 by bit depth (channel mean for colour)."""
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, f"Could not read image: {e}")
    if im.width * im.height > MAX_PIXELS:
        raise HTTPException(413, "Image is too large.")
    if im.mode in ("I;16", "I;16B", "I;16L", "I"):
        a = np.asarray(im, dtype=np.float32)
        top = 65535.0 if im.mode.startswith("I;16") or a.max() <= 65535 else float(a.max())
        return a * (255.0 / top)
    if im.mode == "F":
        a = np.asarray(im, dtype=np.float32)
        return (a - a.min()) * (255.0 / max(1e-6, float(np.ptp(a))))
    if im.mode not in ("L", "RGB"):
        im = im.convert("RGB")
    a = np.asarray(im, dtype=np.float32)
    return a.mean(axis=2) if a.ndim == 3 else a


class Params(BaseModel):
    invert: bool = False
    border: int = Field(5, ge=1, le=100, description="Local background border (px)")
    rb_radius: int = Field(50, ge=5, le=500, description="Rolling-ball radius (px)")


class SegmentRequest(Params):
    model: str = gelgenie.DEFAULT_MODEL
    min_area: int = Field(10, ge=1)
    upscale: int = Field(0, ge=0, le=4, description="Resize factor for the model input; 0 = auto")
    rescue: float = Field(0, ge=0, le=1, description="Add bright spots the model missed (seed threshold "
                                                      "as a fraction of the brightest level above background); 0 = off")


class MeasureRequest(Params):
    rects: list[list[int]]


class RotateRequest(BaseModel):
    angle: float = Field(0, ge=-360, le=360, description="Clockwise rotation of the uploaded image (degrees)")


def _prepare(entry: dict, req: Params):
    """Band-bright measurement image and its rolling-ball-subtracted version."""
    img = 255.0 - entry["gray"] if req.invert else entry["gray"]
    key = (req.invert, req.rb_radius)
    rb = entry["rb"].get(key)
    if rb is None:
        rb = entry["rb"][key] = quant.rolling_ball_subtract(img, req.rb_radius)
    return img, rb


@app.get("/api/models")
def models():
    return {
        "default": gelgenie.DEFAULT_MODEL,
        "models": [{"id": k, "name": m["name"], "downloaded": gelgenie.model_path(k).exists()}
                   for k, m in gelgenie.MODELS.items()],
    }


@app.post("/api/images")
async def upload(file: UploadFile = File(...)):
    gray = _decode(await file.read())
    image_id = uuid.uuid4().hex
    # `orig` is the image as uploaded; `gray` is it after rotation, and is what gets analysed.
    _images[image_id] = {"orig": gray, "gray": gray, "angle": 0.0, "name": file.filename, "rb": {}, "global_bg": {}}
    while len(_images) > MAX_IMAGES:
        _images.popitem(last=False)
    h, w = gray.shape
    return {"id": image_id, "name": file.filename, "width": w, "height": h,
            # A bright background means dark bands, which the models need inverted.
            "suggested_invert": bool(np.median(gray) > 127)}


@app.get("/api/images/{image_id}/preview.png")
def preview(image_id: str):
    buf = io.BytesIO()
    Image.fromarray(np.clip(_get(image_id)["gray"], 0, 255).astype(np.uint8)).save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png")


@app.post("/api/images/{image_id}/rotate")
def rotate(image_id: str, req: RotateRequest):
    """Set the image's rotation (absolute, relative to the upload). Clears cached backgrounds."""
    entry = _get(image_id)
    entry["gray"] = entry["orig"] if req.angle % 360 == 0 else quant.rotate(entry["orig"], req.angle)
    entry["angle"] = req.angle
    entry["rb"].clear()
    entry["global_bg"].clear()
    h, w = entry["gray"].shape
    return {"width": w, "height": h, "angle": req.angle}


@app.post("/api/images/{image_id}/segment")
def segment(image_id: str, req: SegmentRequest):
    if req.model not in gelgenie.MODELS:
        raise HTTPException(400, f"Unknown model {req.model!r}")
    entry = _get(image_id)
    t = time.time()
    img, rb = _prepare(entry, req)
    upscale = req.upscale or gelgenie.auto_upscale(*img.shape)
    classes = gelgenie.segment(img / 255.0, req.model, upscale)
    labels, _ = quant.label_bands(classes, req.min_area)
    first_rescued = int(labels.max()) + 1
    if req.rescue > 0:
        labels, first_rescued = quant.rescue_bright(img, labels, req.rescue, req.min_area)
    global_bg = quant.global_background(img, labels > 0)
    entry["global_bg"][req.invert] = global_bg
    bands = quant.measure_all(img, rb, labels, req.border, global_bg)
    for band in bands:
        band["rescued"] = bool(band.pop("id") >= first_rescued)
    return {"bands": bands, "wells": quant.wells(classes, req.min_area), "global_bg": round(global_bg, 3),
            "model": req.model, "upscale": upscale, "seconds": round(time.time() - t, 2)}


@app.post("/api/images/{image_id}/measure")
def measure(image_id: str, req: MeasureRequest):
    """Measure user-drawn rectangular bands (the whole rectangle is the band)."""
    entry = _get(image_id)
    img, rb = _prepare(entry, req)
    h, w = img.shape
    # Use the background from the last segmentation, else the image median.
    global_bg = entry["global_bg"].get(req.invert)
    if global_bg is None:
        global_bg = float(np.median(img))
    out = []
    for r in req.rects:
        x0, x1 = sorted((max(0, r[0]), min(w, r[2])))
        y0, y1 = sorted((max(0, r[1]), min(h, r[3])))
        if x1 - x0 < 1 or y1 - y0 < 1:
            out.append(None)
            continue
        out.append(quant.measure(img, rb, np.ones((y1 - y0, x1 - x0), bool), (x0, y0, x1, y1), req.border, global_bg))
    return {"bands": out}


WEB = Path(__file__).resolve().parent.parent / "web"
app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
