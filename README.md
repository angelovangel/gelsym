# Gel Band Quantifier

Browser app for agarose gel images: finds bands with [GelGenie](https://github.com/mattaq31/GelGenie)
deep-learning models, groups them into lanes, estimates size (bp) and DNA amount (ng, ng/µL) from a
ladder, and exports a CSV.

- `server/` – FastAPI + ONNX Runtime. Runs the GelGenie models and measures bands.
- `web/` – static client (served by the server). Lane, band and ladder editing, calibration, CSV.
- `samples/` – test images (`neb_1kb_plus_ladder_gel.tif` is from the GelGenie repo, NEB 1 kb Plus, 1 µg per lane).

## Run

```sh
cd server
uv run uvicorn app:app --port 8000
```

Open http://127.0.0.1:8000. Models are downloaded from HuggingFace into `server/models/` on first
use (~57 MB each).

## Docker

```sh
docker build -t gelsym .
docker run -p 8000:8000 gelsym
```

The image bakes in the Universal and Sharp-band models; others download on first use into
`/app/models` (mount a volume there to keep them). It runs a single worker on purpose, since
uploaded images are held in memory.

Deployed with the other lab apps via [tgs-lab-apps](../tgs-lab-apps) as service `gelsym` on port
3812: `docker compose up -d gelsym` there (builds from `../gelsym`), or
`./build_and_push.sh aangeloo latest gelsym` to push the image to Docker Hub.

## How it works

1. **Segmentation** – same preprocessing as the GelGenie QuPath extension: grayscale (channel mean)
   scaled to 0–1, inverted for dark-band images, zero-padded to a multiple of 32, argmax over the
   model's classes. Images under ~800 px are upscaled 2–4× first (the models miss small bands
   otherwise). Connected band pixels (8-connectivity) are one band. The 3-class model also finds
   wells, which add lanes that have no bands. Optionally, very bright spots the model missed
   (it can skip saturated, compact bands) are added by thresholding ("bright spot" flag).
2. **Measurement** (per band, on 0–255 intensities with bands bright):
   - raw volume: sum of pixels in the band
   - global: raw − median of all non-band pixels in the image × band area
   - local: raw − mean of pixels within 5 px of the band (other bands excluded) × band area
   - rolling ball: sum in the band after rolling-ball background subtraction (radius 50)
3. **Lanes** – bands grouped by horizontal overlap; editable. On a multi-row gel this is done per
   row, and on a 96-well plate bands are grouped by well instead (see below).
4. **Calibration** – ladder bands are matched to the ladder sizes top-down, or around the sizes you
   set in Ladder mode. Size: log10(bp) interpolated against band position. Mass: band volume = k × ng (least squares through the origin).

On the sample gel, global-background volumes correlate with the manufacturer's band masses at
r ≈ 0.98 once merged bands are fixed.

## Editing

- **Lanes** – click a lane to remove it; click empty space to add one; drag across to add one of that width.
- **Bands** – click to remove/restore; drag a box to add a band (replaces bands whose centre is inside,
  which merges split bands). To split a merged band, remove it and draw one box per band.
- **Ladder** – click a band to set its size from the ladder table, or mark it as not a ladder band.
  Its lane becomes the ladder lane, and the other ladder bands take consecutive sizes counting
  outward from the sizes you set. One or two set sizes usually fix a missing or merged band.

Edits are kept in image coordinates and re-applied whenever detection re-runs.

## Viewing and orientation

- **Rotate** (Gel section): ↺/↻ turn the image 90°; type an angle (degrees clockwise) to
  straighten a tilted gel. Rotation is done on the server, so detection runs on the rotated image
  (bands must run top to bottom). It resets edits, since their coordinates change.
- **Zoom**: −/Fit/+ in the toolbar, ⌘/Ctrl + scroll or pinch to zoom around the cursor, keys + − 0.
  Drag to pan in View mode.
- **Hide detected** (or H) shows the bare gel.

## Multi-row gels

Set **Gel type** to *Multi-row gel* for gels cast with several combs (rows of wells, one above the
other). Rows are split halfway across empty vertical gaps between bands (wider than 5% of the image
height; a lone speck doesn't make a row). In **Rows** mode, click between rows to add a boundary
or click a boundary to remove it. Lanes are then found separately in each row, so rows that are
shifted sideways are fine.

Each row is calibrated against its own ladder lane, measured from the top of the row; by default
it's the lane with the most bands (a ladder has more bands than a sample). Pick another in the
ladder list (it applies to the selected row) or by clicking a band in Ladder mode. Lanes are
labelled R2-5 (row 2, lane 5); the CSV has row and column columns. Lanes only exist where bands
were found, so empty wells get no lane unless you add one in Lanes mode.

## 96-well plates (E-Gel 96)

Set **Gel type** to *96-well plate*. This switches to settings that work on plates: the sharp-band
model upscaled 2×, bright-spot rescue on, and bands fainter than 30% of the brightest ignored
(this hides the glow below every well). Then click **Grid** and the centres of wells A1, A12 and
H1. Rows, columns, a marker column (M) and the half-well stagger of rows B, D, F, H are set in the
sidebar.

Each band is assigned to the well it ran from: the nearest well above it at the same column
position, with a run of 0.15–2 row pitches (objects level with a well are rims or stuck DNA).
Size is calibrated against the ladder well's bands by migration distance below the well; the
default ladder well is the marker well with the most bands. The table and CSV give the well, plate
row and column, and the migration distance.

On the sample plates: on a 2% plate, 95 of 96 wells got their band (the 96th is empty). On a 1%
single-genome-amplification plate, the product bands visible by eye were all assigned to the
right wells, though the brightest ones are only found with bright-spot rescue; some bands split
into two pieces and need merging with a box in Bands mode.

## API

- `POST /api/images` (multipart `file`) → `{id, width, height, suggested_invert}`
- `GET /api/images/{id}/preview.png`
- `POST /api/images/{id}/segment` `{model, invert, upscale, rescue, min_area, border, rb_radius}` → bands, wells
- `POST /api/images/{id}/measure` `{rects, invert, border, rb_radius}` → bands for drawn boxes
- `POST /api/images/{id}/rotate` `{angle}` → new width and height (rotation relative to the upload)
- `GET /api/models`
