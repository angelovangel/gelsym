"""Band labelling and measurement, following the GelGenie QuPath extension (TableController):

- raw volume:   sum of pixel intensities inside the band
- local volume: raw - local background mean * pixel count, where the local background is
                the pixels in the band's bounding box grown by `border` px, outside the band
- global volume: raw - global background * pixel count; the global background is the median
                of all non-band pixels in the image (GelGenie asks for a hand-picked patch)
- rb volume:    sum inside the band of the rolling-ball background-subtracted image

Intensities are 0-255 grayscale with bands bright (dark-band images are inverted first).
"""
import numpy as np
from scipy import ndimage as ndi
from skimage.measure import approximate_polygon, find_contours
from skimage.restoration import rolling_ball

SATURATION = 254.0


def rotate(img: np.ndarray, angle: float) -> np.ndarray:
    """Rotate clockwise by `angle` degrees. Multiples of 90 are exact; other angles are
    interpolated (bilinear) into a larger canvas filled with the image median."""
    a = angle % 360
    k = round(a / 90)
    if abs(a - 90 * k) < 1e-6:
        return np.ascontiguousarray(np.rot90(img, -k))
    return ndi.rotate(img, -a, reshape=True, order=1, mode="constant", cval=float(np.median(img)))


def rolling_ball_subtract(img: np.ndarray, radius: int) -> np.ndarray:
    # Like ImageJ, shrink before rolling large balls (full resolution is ~100x slower).
    shrink = 1 if radius <= 10 else 2 if radius <= 30 else 4 if radius <= 100 else 8
    h, w = img.shape
    if shrink > 1:
        ph, pw = -h % shrink, -w % shrink
        p = np.pad(img, ((0, ph), (0, pw)), mode="edge")
        small = p.reshape(p.shape[0] // shrink, shrink, p.shape[1] // shrink, shrink).min(axis=(1, 3))
        bg_small = rolling_ball(small, radius=radius / shrink)
        bg = ndi.zoom(bg_small, shrink, order=1)[:h, :w]
        bg = np.minimum(bg, img)
    else:
        bg = rolling_ball(img, radius=radius)
    return img - bg


def label_bands(classes: np.ndarray, min_area: int):
    labels, n = ndi.label(classes == 1, structure=np.ones((3, 3)))
    if n:
        areas = np.bincount(labels.ravel())
        small = np.flatnonzero(areas < min_area)
        small = small[small > 0]
        if small.size:
            labels[np.isin(labels, small)] = 0
            labels, n = ndi.label(labels > 0, structure=np.ones((3, 3)))
    return labels, n


def rescue_bright(img: np.ndarray, labels: np.ndarray, frac: float, min_area: int):
    """Add very bright spots that the model missed (it can skip saturated, compact bands).

    Seeds are pixels above background + frac * (99.9th percentile - background); each seed is
    grown over pixels above half that threshold, and kept if it touches no existing band.
    Returns the new label image and the first label id of the added bands.
    """
    band = labels > 0
    bg = float(np.median(img[~band])) if (~band).any() else float(np.median(img))
    top = float(np.percentile(img, 99.9))
    if top <= bg:
        return labels, int(labels.max()) + 1
    seeds = img >= bg + frac * (top - bg)
    grown, n = ndi.label(img >= bg + 0.5 * frac * (top - bg), structure=np.ones((3, 3)))
    first = next_id = int(labels.max()) + 1
    out = labels.copy()
    for i, sl in enumerate(ndi.find_objects(grown), start=1):
        if sl is None:
            continue
        region = grown[sl] == i
        if not seeds[sl][region].any() or band[sl][region].any() or region.sum() < min_area:
            continue
        out[sl][region] = next_id
        next_id += 1
    return out, first


def wells(classes: np.ndarray, min_area: int):
    labels, n = ndi.label(classes == 2, structure=np.ones((3, 3)))
    out = []
    for i, sl in enumerate(ndi.find_objects(labels), start=1):
        if sl is not None and (labels[sl] == i).sum() >= min_area:
            out.append([sl[1].start, sl[0].start, sl[1].stop, sl[0].stop])
    return out


def _contour(mask: np.ndarray, x0: int, y0: int):
    padded = np.pad(mask, 1)
    cs = find_contours(padded.astype(np.float32), 0.5)
    if not cs:
        return []
    c = approximate_polygon(max(cs, key=len), tolerance=0.6)
    return [[round(float(col) - 1 + x0, 1), round(float(row) - 1 + y0, 1)] for row, col in c]


def measure(img: np.ndarray, rb_img: np.ndarray, mask: np.ndarray, bbox, border: int,
            global_bg: float, other_bands: np.ndarray | None = None) -> dict:
    """Measure one band. `mask` covers `bbox` = (x0, y0, x1, y1) in image coordinates."""
    x0, y0, x1, y1 = bbox
    h, w = img.shape
    px = img[y0:y1, x0:x1][mask]
    raw = float(px.sum())
    n = int(px.size)

    bx0, by0 = max(0, x0 - border), max(0, y0 - border)
    bx1, by1 = min(w, x1 + border), min(h, y1 + border)
    bg_mask = np.ones((by1 - by0, bx1 - bx0), bool)
    bg_mask[y0 - by0:y1 - by0, x0 - bx0:x1 - bx0] &= ~mask
    if other_bands is not None:  # keep neighbouring bands out of the background estimate
        bg_mask &= ~other_bands[by0:by1, bx0:bx1]
    bg_px = img[by0:by1, bx0:bx1][bg_mask]
    local_mean = float(bg_px.mean()) if bg_px.size else 0.0

    ys, xs = np.nonzero(mask)
    return {
        "bbox": [int(x0), int(y0), int(x1), int(y1)],
        "centroid": [round(float(xs.mean()) + x0, 2), round(float(ys.mean()) + y0, 2)],
        "area": n,
        "mean": round(float(px.mean()), 3) if n else 0.0,
        "max": float(px.max()) if n else 0.0,
        "raw_volume": round(raw, 2),
        "local_bg": round(local_mean, 3),
        "local_volume": round(raw - local_mean * n, 2),
        "global_volume": round(raw - global_bg * n, 2),
        "rb_volume": round(float(rb_img[y0:y1, x0:x1][mask].sum()), 2),
        "saturated": bool(n and px.max() >= SATURATION),
        "contour": _contour(mask, x0, y0),
    }


def global_background(img: np.ndarray, band_mask: np.ndarray) -> float:
    bg = img[~band_mask]
    return float(np.median(bg)) if bg.size else 0.0


def measure_all(img: np.ndarray, rb_img: np.ndarray, labels: np.ndarray, border: int, global_bg: float) -> list[dict]:
    all_bands = labels > 0
    out = []
    for i, sl in enumerate(ndi.find_objects(labels), start=1):
        if sl is None:
            continue
        bbox = (sl[1].start, sl[0].start, sl[1].stop, sl[0].stop)
        out.append({"id": i, **measure(img, rb_img, labels[sl] == i, bbox, border, global_bg, all_bands)})
    return out

