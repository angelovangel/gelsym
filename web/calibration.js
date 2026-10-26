// Lane grouping and ladder calibration. Pure functions over band objects from the API
// (bbox [x0, y0, x1, y1], centroid [x, y], *_volume, saturated).
(function (root) {
  'use strict';

  // Band masses (ng) at the manufacturer's stated load (loadUg).
  const LADDERS = {
    'neb-1kb-plus': {
      name: 'NEB 1 kb Plus (N3200)', loadUg: 1.0,
      bands: [[10000, 40], [8000, 40], [6000, 48], [5000, 40], [4000, 32], [3000, 120], [2000, 40],
              [1500, 57], [1200, 45], [1000, 122], [900, 34], [800, 31], [700, 27], [600, 23],
              [500, 124], [400, 49], [300, 37], [200, 32], [100, 61]],
    },
    'neb-1kb': {
      name: 'NEB 1 kb (N3232)', loadUg: 0.5,
      bands: [[10000, 42], [8000, 42], [6000, 50], [5000, 42], [4000, 33], [3000, 125],
              [2000, 48], [1500, 36], [1000, 42], [500, 42]],
    },
    'neb-100bp': {
      name: 'NEB 100 bp (N3231)', loadUg: 0.5,
      // 517 + 500 run as one band; mass is the sum.
      bands: [[1517, 45], [1200, 35], [1000, 95], [900, 27], [800, 24], [700, 21], [600, 18],
              [517, 97], [400, 38], [300, 29], [200, 25], [100, 48]],
    },
    'generuler-1kb': {
      name: 'Thermo GeneRuler 1 kb (SM0311)', loadUg: 0.5,
      bands: [[10000, 30], [8000, 30], [6000, 70], [5000, 30], [4000, 30], [3500, 30],
              [3000, 70], [2500, 25], [2000, 25], [1500, 25], [1000, 60], [750, 25],
              [500, 25], [250, 25]],
    },
  };

  const median = a => {
    const s = a.slice().sort((p, q) => p - q), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Group bands into lanes by horizontal overlap (like GelGenie's BandSorter, but a lane's
  // extent is the median of its members so one wide or split band can't drag it around).
  // Wells (3-class model) that don't overlap a lane become empty lanes.
  function autoLanes(bands, wells) {
    const items = bands.map(b => ({ x0: b.bbox[0], x1: b.bbox[2], cx: b.centroid[0] })).sort((a, b) => a.cx - b.cx);
    const groups = [];
    for (const it of items) {
      const g = groups[groups.length - 1];
      if (g) {
        const overlap = Math.min(g.x1, it.x1) - Math.max(g.x0, it.x0);
        if (overlap > 0.3 * Math.min(g.x1 - g.x0, it.x1 - it.x0)) {
          g.m.push(it);
          g.x0 = median(g.m.map(m => m.x0));
          g.x1 = median(g.m.map(m => m.x1));
          continue;
        }
      }
      groups.push({ x0: it.x0, x1: it.x1, m: [it] });
    }
    const lanes = groups.map(g => ({ x0: Math.round(g.x0), x1: Math.round(g.x1) }));
    for (const [x0, , x1] of wells || []) {
      if (!lanes.some(l => Math.min(l.x1, x1) - Math.max(l.x0, x0) > 0)) lanes.push({ x0, x1 });
    }
    return lanes.sort((a, b) => a.x0 - b.x0);
  }

  // Index of the lane a band belongs to (centroid inside the lane; nearest centre on ties), or -1.
  // On a multi-row gel only lanes in the band's row (`tier`) count.
  function laneOf(band, lanes) {
    const x = band.centroid[0];
    let best = -1, bestD = Infinity;
    lanes.forEach((l, i) => {
      if ((l.tier || 0) !== (band.tier || 0)) return;
      const d = Math.abs((l.x0 + l.x1) / 2 - x);
      if (x >= l.x0 && x <= l.x1 && d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  // Row boundaries of a multi-row gel: halfway across vertical gaps between bands wider than 5%
  // of the image height. Clusters of fewer than 2 bands (dust) don't make a row of their own.
  function autoDividers(bands, height) {
    const iv = bands.map(b => [b.bbox[1], b.bbox[3]]).sort((a, b) => a[0] - b[0]);
    const clusters = [];
    for (const [y0, y1] of iv) {
      const c = clusters[clusters.length - 1];
      if (c && y0 - c.y1 <= 0.05 * height) { c.y1 = Math.max(c.y1, y1); c.n++; }
      else clusters.push({ y0, y1, n: 1 });
    }
    const rows = clusters.filter(c => c.n >= 2);
    return rows.slice(1).map((c, i) => Math.round((rows[i].y1 + c.y0) / 2));
  }

  // Row index of a y position given sorted row boundaries.
  const tierOf = (y, dividers) => dividers.filter(d => d <= y).length;

  function interp(pts, x) {
    let i = 1;
    while (i < pts.length - 1 && x > pts[i][0]) i++;
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }

  const setLadder = (b, w) => { b.ladderBp = w[0]; b.ladderNg = w[1]; };

  // No sizes set by the user: assign ladder sizes from the top down.
  function matchTopDown(cand, want, volKey, warnings) {
    let use = cand.slice();
    if (use.length > want.length) {
      use = use.sort((a, b) => b[volKey] - a[volKey]).slice(0, want.length);
      warnings.push(`The ladder lane has ${cand.length} bands but the ladder defines ${want.length}; using the ${want.length} strongest. Set band sizes in Ladder mode to fix.`);
    } else if (use.length < want.length) {
      warnings.push(`Only ${use.length} of ${want.length} ladder bands found; sizes were assigned from the top down. Set band sizes in Ladder mode to fix.`);
    }
    use.sort((a, b) => a.pos - b.pos);
    use.forEach((b, i) => setLadder(b, want[i]));
    return use;
  }

  // Bands with a user-set size (ladderFix, in bp) stay fixed; the other bands take consecutive
  // ladder sizes counting outward from them. Returns null if no usable sizes were set.
  function matchAround(cand, want, warnings) {
    const idx = cand.map(() => -1);
    let last = -1;
    cand.forEach((b, i) => {
      if (typeof b.ladderFix !== 'number') return;
      const k = want.findIndex(w => w[0] === b.ladderFix);
      if (k < 0) warnings.push(`${b.ladderFix} bp is not in the ladder table, so it was ignored.`);
      else if (k <= last) warnings.push(`${b.ladderFix} bp is set below a smaller size, so it was ignored.`);
      else { idx[i] = k; last = k; }
    });
    const anchors = idx.map((k, i) => (k >= 0 ? i : -1)).filter(i => i >= 0);
    if (!anchors.length) return null;

    const out = idx.slice();
    for (let i = anchors[0] - 1, k = idx[anchors[0]] - 1; i >= 0; i--, k--) out[i] = k;
    anchors.forEach((a, n) => {
      const next = n + 1 < anchors.length ? anchors[n + 1] : cand.length;
      const limit = n + 1 < anchors.length ? idx[next] : want.length;
      for (let i = a + 1, k = idx[a] + 1; i < next; i++, k++) out[i] = k < limit ? k : -1;
    });

    const pairs = [];
    cand.forEach((b, i) => { if (out[i] >= 0) { setLadder(b, want[out[i]]); pairs.push(b); } });
    const unmatched = cand.length - pairs.length;
    if (unmatched) warnings.push(`${unmatched} band(s) in the ladder lane don't match a ladder size. Set their sizes, or mark them as not ladder bands.`);
    return pairs;
  }

  // laneBands: array (per lane or well) of bands sorted top to bottom, each with `pos`: its
  // migration distance (centroid y for a gel, distance below the well for a plate). Annotates
  // every band with bp, ng, flags (and ladderBp/ladderNg for assigned ladder bands). Size is
  // interpolated in log10(bp) against pos; mass assumes volume = k * ng (least squares through the origin).
  function calibrate(laneBands, ladderLane, ladder, volKey) {
    const warnings = [];
    const cal = { warnings, pairs: [], sizeFn: null, k: null, r2: null, bpRange: null, volRange: null };
    for (const lane of laneBands) for (const b of lane) { delete b.ladderBp; delete b.ladderNg; }
    const lane = laneBands[ladderLane];
    const want = ladder.slice().sort((a, b) => b[0] - a[0]);
    if (!lane) warnings.push('Choose a ladder lane.');
    else if (!want.length) warnings.push('The ladder has no bands defined.');
    else {
      const cand = lane.filter(b => b.ladderFix !== 'skip');
      cal.pairs = matchAround(cand, want, warnings) || matchTopDown(cand, want, volKey, warnings);
    }
    const pairs = cal.pairs;

    if (pairs.length >= 2) {
      const pts = pairs.map(b => [b.pos, Math.log10(b.ladderBp)]);
      cal.sizeFn = y => Math.pow(10, interp(pts, y));
      cal.bpRange = [pairs[pairs.length - 1].ladderBp, pairs[0].ladderBp];
    } else if (lane) warnings.push('At least 2 ladder bands are needed to estimate sizes.');

    const mp = pairs.filter(b => !b.saturated && b[volKey] > 0);
    if (mp.length < pairs.length) warnings.push(`${pairs.length - mp.length} saturated or empty ladder band(s) left out of the mass fit.`);
    if (mp.length) {
      let sxy = 0, sxx = 0, mean = 0;
      for (const b of mp) { sxy += b.ladderNg * b[volKey]; sxx += b.ladderNg ** 2; mean += b[volKey] / mp.length; }
      cal.k = sxy / sxx;
      if (mp.length >= 2) {
        let ssRes = 0, ssTot = 0;
        for (const b of mp) { ssRes += (b[volKey] - cal.k * b.ladderNg) ** 2; ssTot += (b[volKey] - mean) ** 2; }
        cal.r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
      }
      cal.volRange = [Math.min(...mp.map(b => b[volKey])), Math.max(...mp.map(b => b[volKey]))];
    } else if (lane) warnings.push('No usable ladder bands for the mass calibration.');

    for (const l of laneBands) {
      for (const b of l) {
        const v = b[volKey];
        b.bp = cal.sizeFn ? cal.sizeFn(b.pos) : null;
        b.ng = cal.k ? v / cal.k : null;
        b.flags = [];
        if (b.saturated) b.flags.push('saturated');
        if (b.manual) b.flags.push('manual');
        if (b.rescued) b.flags.push('bright spot');
        if (l === lane && typeof b.ladderFix === 'number' && b.ladderBp === b.ladderFix) b.flags.push('size set');
        if (l === lane && b.ladderFix === 'skip') b.flags.push('not a ladder band');
        if (b.bp != null && (b.bp < cal.bpRange[0] * 0.999 || b.bp > cal.bpRange[1] * 1.001)) b.flags.push('size outside ladder');
        // The fit passes through the origin, so modest extrapolation below the faintest band is safe.
        if (b.ng != null && (v < cal.volRange[0] * 0.5 || v > cal.volRange[1] * 1.001)) b.flags.push('mass outside ladder');
      }
    }
    return cal;
  }

  const ROWS = 'ABCDEFGHIJKLMNOP';

  // Plate wells from three clicked well centres (A1, last column of row A, first column of the
  // last row). Staggered plates (E-Gel 96) shift every second row by `stagger` well pitches.
  function plateWells(g) {
    const n = Math.max(1, g.cols - 1), m = Math.max(1, g.rows - 1);
    const col = [(g.a12[0] - g.a1[0]) / n, (g.a12[1] - g.a1[1]) / n];
    const off = (m % 2) * g.stagger;
    const row = [(g.h1[0] - g.a1[0] - off * col[0]) / m, (g.h1[1] - g.a1[1] - off * col[1]) / m];
    const wells = [];
    for (let r = 0; r < g.rows; r++) {
      const s = r % 2 ? g.stagger : 0;
      for (let c = 0; c < g.cols + (g.marker ? 1 : 0); c++) {
        wells.push({
          x: g.a1[0] + (c + s) * col[0] + r * row[0],
          y: g.a1[1] + (c + s) * col[1] + r * row[1],
          row: r, col: c, marker: c >= g.cols,
          label: ROWS[r] + (c >= g.cols ? '-M' : c + 1),
        });
      }
    }
    return { wells, col, row, colPitch: Math.hypot(...col), rowPitch: Math.hypot(...row) };
  }

  // Index of the well a band ran from: the nearest well above it in the same column position
  // (within 0.3 well pitches sideways, so the half-pitch stagger picks every second row), or -1.
  // Bands must have run 0.15-2 row pitches: objects level with a well are well rims or DNA
  // stuck in the well, and anything further down is debris (labels, barcodes).
  function wellOf(band, plate) {
    const [cx, cy] = band.centroid;
    const cu = [plate.col[0] / plate.colPitch, plate.col[1] / plate.colPitch];
    const ru = [plate.row[0] / plate.rowPitch, plate.row[1] / plate.rowPitch];
    let best = -1, bestDy = Infinity;
    plate.wells.forEach((w, i) => {
      const d = [cx - w.x, cy - w.y];
      const dx = d[0] * cu[0] + d[1] * cu[1], dy = d[0] * ru[0] + d[1] * ru[1];
      if (Math.abs(dx) <= 0.3 * plate.colPitch && dy >= 0.15 * plate.rowPitch && dy <= 2 * plate.rowPitch && dy < bestDy) { best = i; bestDy = dy; }
    });
    return best;
  }

  const api = { LADDERS, autoLanes, laneOf, autoDividers, tierOf, calibrate, plateWells, wellOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Cal = api;
})(this);
