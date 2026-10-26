// UI: upload, detection via the API, lane / band / ladder editing, calibration, plots, CSV.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const freshEdits = () => ({ removed: [], manual: [], lanes: null, ladder: [], dividers: null });
  const S = {
    image: null, img: null,
    bands: [], wells: [], lanes: [], globalBg: null, seconds: null, model: null,
    // Edits are kept in image coordinates and replayed after every detection.
    edits: freshEdits(),
    mode: 'view', sel: -1, laneBands: [], cal: null, drag: null, error: null,
    // Layout: 'lanes' (one row of lanes), 'multi' (several rows of lanes, split at `dividers`)
    // or 'plate' (grid of wells, e.g. E-Gel 96). Bands are grouped per lane or per well; `groups`
    // holds each group's label, row (tier) and migration origin (y0). Each row has its own
    // ladder (`ladderOf[tier]`, user choices in `ladderPick`) and calibration (`cals[tier]`).
    layout: 'lanes', groups: [], plate: null, dividers: [],
    ladderPick: {}, ladderOf: [], cals: [], focusTier: 0,
    grid: null, gridGuess: true, gridClicks: [],
    overlay: true,  // draw detected bands, lanes and wells over the gel
    angle: 0,       // rotation applied on the server (degrees clockwise)
    zoom: 1, scale: 1,  // display zoom relative to fit-to-panel, and the resulting px per image px
  };

  // ---- API ----
  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = res.statusText;
      try { const d = (await res.json()).detail; msg = typeof d === 'string' ? d : JSON.stringify(d); } catch (e) { /* not JSON */ }
      throw new Error(msg);
    }
    return res.json();
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function busy(on, text) {
    $('busy').textContent = text || 'Working…';
    $('busy').classList.toggle('on', on);
  }

  async function loadModels() {
    try {
      const r = await api('/api/models');
      for (const m of r.models) $('model').add(new Option(m.name + (m.downloaded ? '' : ' (downloads on first use)'), m.id));
      $('model').value = r.default;
    } catch (e) {
      S.error = 'Cannot reach the analysis server: ' + e.message;
      renderMsgs();
    }
  }

  // ---- Controls ----
  const preset = $('ladderPreset');
  for (const [k, l] of Object.entries(Cal.LADDERS)) preset.add(new Option(l.name, k));
  preset.add(new Option('Custom', 'custom'));
  function fillLadder() {
    const l = Cal.LADDERS[preset.value];
    if (!l) return;
    const f = (parseFloat($('ladderUg').value) || l.loadUg) / l.loadUg;
    $('ladderText').value = l.bands.map(([bp, ng]) => `${bp}, ${+(ng * f).toFixed(2)}`).join('\n');
  }
  preset.addEventListener('change', () => {
    const l = Cal.LADDERS[preset.value];
    if (l) $('ladderUg').value = l.loadUg;
    fillLadder(); update();
  });
  $('ladderUg').addEventListener('input', () => { fillLadder(); update(); });
  $('ladderText').addEventListener('input', () => { preset.value = 'custom'; update(); });
  $('ladderUg').value = Cal.LADDERS[preset.value].loadUg;
  fillLadder();

  function parseLadder() {
    return $('ladderText').value.split('\n')
      .map(line => line.trim().split(/[\s,;]+/).map(Number))
      .filter(([bp, ng]) => bp > 0 && ng >= 0);
  }

  for (const id of ['invert', 'model', 'upscale', 'minArea', 'border', 'rbRadius', 'rescue']) $(id).addEventListener('change', detect);
  for (const id of ['volKey', 'sampleUl', 'faint', 'plateRows', 'plateCols', 'plateMarker', 'plateStagger']) $(id).addEventListener('input', update);
  $('ladderLane').addEventListener('change', () => {
    const gi = +$('ladderLane').value;
    S.ladderPick[S.groups[gi].tier] = gi;
    update();
  });
  $('layout').addEventListener('change', () => {
    S.layout = $('layout').value;
    S.ladderPick = {}; S.sel = -1;
    document.body.classList.toggle('plate', S.layout === 'plate');
    document.body.classList.toggle('multi', S.layout === 'multi');
    // Plate bands are small, sharp and often saturated: use the sharp-band model upscaled 2×,
    // add saturated spots it misses, and hide the faint glow below every well.
    const plate = S.layout === 'plate';
    $('model').value = plate ? 'sharp' : 'universal';
    $('upscale').value = plate ? '2' : '0';
    $('faint').value = plate ? 30 : 0;
    $('rescue').checked = plate;
    if (['lanes', 'grid', 'rows'].includes(S.mode)) setMode('view');
    detect();
  });
  $('gridBtn').onclick = () => setMode('grid');
  $('runBtn').onclick = detect;
  $('resetEdits').onclick = () => { S.edits = freshEdits(); detect(); };
  function toggleOverlay() {
    S.overlay = !S.overlay;
    $('overlayBtn').textContent = S.overlay ? 'Hide detected' : 'Show detected';
    $('overlayBtn').setAttribute('aria-pressed', S.overlay);
    closePop();
    draw();
  }
  $('overlayBtn').onclick = toggleOverlay;

  // ---- Rotation (server side, so detection runs on the rotated image) ----
  async function setRotation(angle) {
    if (!S.image) return;
    angle = (((angle % 360) + 540) % 360) - 180;  // keep within [-180, 180)
    busy(true, 'Rotating…');
    try {
      const r = await post(`/api/images/${S.image.id}/rotate`, { angle });
      const img = new Image();
      img.src = `/api/images/${S.image.id}/preview.png?angle=${angle}`;
      await img.decode();
      Object.assign(S.image, { width: r.width, height: r.height });
      // Edits are in image coordinates, which rotation changes.
      Object.assign(S, { img, angle, edits: freshEdits(), grid: null, gridGuess: true, gridClicks: [], sel: -1, ladderPick: {} });
      $('rotAngle').value = +angle.toFixed(2);
      $('dropText').innerHTML = `<b>${esc(S.image.name)}</b><br><small>${r.width} × ${r.height} px · click to change</small>`;
    } catch (e) {
      S.error = e.message; renderMsgs();
      return;
    } finally {
      busy(false);
    }
    await detect();
  }
  $('rotL').onclick = () => setRotation(S.angle - 90);
  $('rotR').onclick = () => setRotation(S.angle + 90);
  $('rotAngle').addEventListener('change', () => setRotation(+$('rotAngle').value || 0));

  // ---- Zoom (display only); keeps the image point under the cursor fixed ----
  function zoomTo(z, clientX, clientY) {
    if (!S.image) return;
    const sc = $('gelScroll'), r = sc.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2, cy = clientY ?? r.top + r.height / 2;
    const p = toImage({ clientX: cx, clientY: cy });
    S.zoom = Math.min(16, Math.max(1, z));
    draw();
    sc.scrollLeft = gel.offsetLeft + p[0] * S.scale - (cx - r.left);
    sc.scrollTop = gel.offsetTop + p[1] * S.scale - (cy - r.top);
    $('zoomFit').textContent = S.zoom === 1 ? 'Fit' : Math.round(S.zoom * 100) + '%';
  }
  $('zoomIn').onclick = () => zoomTo(S.zoom * 1.5);
  $('zoomOut').onclick = () => zoomTo(S.zoom / 1.5);
  $('zoomFit').onclick = () => zoomTo(1);
  $('gelScroll').addEventListener('wheel', ev => {
    if (!S.image || !(ev.ctrlKey || ev.metaKey)) return;  // plain scrolling pans; pinch sends ctrlKey
    ev.preventDefault();
    zoomTo(S.zoom * Math.exp(-ev.deltaY * 0.01), ev.clientX, ev.clientY);
  }, { passive: false });
  $('csv').onclick = downloadCsv;

  const HINTS = {
    view: 'Click a lane or well to select it.',
    rows: 'Click between two rows of wells to add a row boundary; click a boundary (dashed line) to remove it. Lanes are then found again in each row.',
    lanes: 'Click a lane to remove it. Click empty space to add a lane, or drag across to add one of that width (it replaces lanes inside it).',
    bands: 'Click a band to remove or restore it. Drag a box to add a band; it replaces bands whose centre is inside, so you can merge split bands. To split a merged band, remove it and draw a box for each band.',
    ladder: 'Click a band to set its ladder size (this also makes its lane or well the ladder). The other ladder bands are matched counting outward from the sizes you set.',
  };
  function gridHint() {
    const rows = +$('plateRows').value || 8, cols = +$('plateCols').value || 12;
    const names = ['A1', `A${cols}`, `${'ABCDEFGHIJKLMNOP'[rows - 1]}1`];
    return `Click the centre of well ${names[S.gridClicks.length]} (${S.gridClicks.length + 1} of 3): first A1, then the last well of row A, then the first well of the last row.`;
  }
  function setMode(m) {
    S.mode = m;
    S.gridClicks = [];
    closePop();
    document.querySelectorAll('.seg button[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === m));
    $('modeHint').textContent = m === 'grid' ? gridHint() : HINTS[m];
    if (S.image) draw();
  }
  document.querySelectorAll('.seg button[data-mode]').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });
  setMode('view');

  // ---- Upload ----
  const drop = $('drop');
  $('file').addEventListener('change', e => loadFile(e.target.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });

  async function loadFile(file) {
    if (!file) return;
    busy(true, 'Uploading…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const info = await api('/api/images', { method: 'POST', body: fd });
      const img = new Image();
      img.src = `/api/images/${info.id}/preview.png`;
      await img.decode();
      Object.assign(S, { image: info, img, bands: [], wells: [], lanes: [], edits: freshEdits(), sel: -1, ladderPick: {}, error: null,
                         grid: null, gridGuess: true, gridClicks: [], dividers: [], angle: 0, zoom: 1 });
      $('rotAngle').value = 0;
      $('zoomFit').textContent = 'Fit';
      for (const id of ['rotL', 'rotR', 'rotAngle']) $(id).disabled = false;
      $('dropText').innerHTML = `<b>${esc(info.name)}</b><br><small>${info.width} × ${info.height} px · click to change</small>`;
      $('empty').hidden = true; $('gel').hidden = false;
      $('runBtn').disabled = false;
      await detect();
    } catch (e) {
      S.error = e.message; renderMsgs();
    } finally {
      busy(false);
    }
  }

  // ---- Detection ----
  const invert = () => $('invert').value === 'auto' ? S.image.suggested_invert : $('invert').value === 'yes';
  const reqBase = () => ({
    invert: invert(),
    border: Math.max(1, +$('border').value || 5), rb_radius: Math.max(5, +$('rbRadius').value || 50),
  });

  async function detect() {
    if (!S.image) return;
    busy(true, 'Detecting bands…');
    try {
      const base = reqBase();
      const r = await post(`/api/images/${S.image.id}/segment`, { ...base, model: $('model').value, upscale: +$('upscale').value, rescue: $('rescue').checked ? 0.5 : 0, min_area: Math.max(1, +$('minArea').value || 10) });
      let bands = r.bands.map(b => ({ ...b, manual: false, removed: false }));
      if (S.edits.manual.length) {
        const m = await post(`/api/images/${S.image.id}/measure`, { ...base, rects: S.edits.manual });
        for (const mb of m.bands) if (mb) bands = addManual(bands, mb);
      }
      Object.assign(S, { bands, wells: r.wells, globalBg: r.global_bg, seconds: r.seconds, model: r.model, upscale: r.upscale, error: null });
      for (const p of S.edits.removed) { const b = hitBand(p); if (b) b.removed = true; }
      for (const e of S.edits.ladder) { const b = hitBand(e.p); if (b) b.ladderFix = e.bp; }
      computeLanes();
      const opt = [...$('model').options].find(o => o.value === r.model);
      if (opt) opt.text = opt.text.replace(' (downloads on first use)', '');
    } catch (e) {
      S.error = e.message;
    } finally {
      busy(false);
      update();
    }
  }

  const active = () => S.bands.filter(b => !b.removed && !b.faint);

  // Rows (multi-row gels only) and the lanes in each row, unless the user edited them.
  function computeLanes() {
    const bands = active();
    S.dividers = S.layout !== 'multi' ? [] : S.edits.dividers ? S.edits.dividers.slice() : Cal.autoDividers(bands, S.image.height);
    for (const b of S.bands) b.tier = Cal.tierOf(b.centroid[1], S.dividers);
    if (S.edits.lanes) { S.lanes = S.edits.lanes.map(l => ({ ...l })); return; }
    S.lanes = [];
    for (let t = 0; t <= S.dividers.length; t++) {
      const wells = S.wells.filter(w => Cal.tierOf((w[1] + w[3]) / 2, S.dividers) === t);
      S.lanes.push(...Cal.autoLanes(bands.filter(b => b.tier === t), wells).map(l => ({ ...l, tier: t })));
    }
  }
  const tierAt = y => Cal.tierOf(y, S.dividers);
  const isLadderGroup = gi => gi >= 0 && S.ladderOf.includes(gi);
  const inBox = ([x, y], [x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

  function addManual(bands, mb) {
    return bands.filter(b => !inBox(b.centroid, mb.bbox)).concat({ ...mb, manual: true, removed: false });
  }

  function inPolygon([x, y], poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Smallest band under the point: inside its outline, else within 2 px of its box.
  function hitBand(p) {
    const hits = S.bands.filter(b => !b.faint).filter(b => (b.contour && b.contour.length > 2 && inPolygon(p, b.contour))
      || inBox(p, [b.bbox[0] - 2, b.bbox[1] - 2, b.bbox[2] + 2, b.bbox[3] + 2]));
    return hits.sort((a, b) => a.area - b.area)[0] || null;
  }

  // ---- Canvas interaction ----
  function toImage(ev) {
    const r = $('gel').getBoundingClientRect();
    return [(ev.clientX - r.left) * S.image.width / r.width, (ev.clientY - r.top) * S.image.height / r.height];
  }

  const gel = $('gel');
  gel.addEventListener('pointerdown', ev => {
    if (!S.image) return;
    gel.setPointerCapture(ev.pointerId);
    const p = toImage(ev), sc = $('gelScroll');
    S.drag = { start: p, end: p, moved: false, px: [ev.clientX, ev.clientY], scroll: [sc.scrollLeft, sc.scrollTop] };
  });
  gel.addEventListener('pointermove', ev => {
    if (!S.drag) return;
    if (Math.hypot(ev.clientX - S.drag.px[0], ev.clientY - S.drag.px[1]) > 5) S.drag.moved = true;
    if (S.mode === 'view') {  // drag to pan
      const sc = $('gelScroll');
      sc.scrollLeft = S.drag.scroll[0] - (ev.clientX - S.drag.px[0]);
      sc.scrollTop = S.drag.scroll[1] - (ev.clientY - S.drag.px[1]);
      return;
    }
    S.drag.end = toImage(ev);
    if (S.drag.moved) draw();
  });
  gel.addEventListener('pointerup', ev => {
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (d.moved) {
      const [ax, ay] = d.start, [bx, by] = toImage(ev);
      onDrag([Math.round(Math.min(ax, bx)), Math.round(Math.min(ay, by)), Math.round(Math.max(ax, bx)), Math.round(Math.max(ay, by))]);
    } else onClick(d.start, ev);
  });
  gel.addEventListener('pointercancel', () => { S.drag = null; draw(); });

  function laneAt([x, y]) {
    const t = tierAt(y);
    return S.lanes.findIndex(l => (l.tier || 0) === t && x >= l.x0 && x <= l.x1);
  }

  function nearestWell(p) {
    const b = hitBand(p);
    if (b && b.lane >= 0) return b.lane;
    const d = S.plate.wells.map(w => Math.hypot(w.x - p[0], w.y - p[1]));
    const i = d.indexOf(Math.min(...d));
    return d[i] < 0.6 * S.plate.colPitch ? i : -1;
  }

  function lanesChanged() {
    S.lanes.sort((a, b) => (a.tier || 0) - (b.tier || 0) || a.x0 - b.x0);
    S.edits.lanes = S.lanes.map(l => ({ ...l }));
    update();
  }

  function onClick(p, ev) {
    if (S.mode === 'view') {
      // A click on a well selects it; a click on a band selects the well it ran from.
      S.sel = S.plate ? nearestWell(p) : laneAt(p);
      update();  // the plots and ladder choice follow the selected row
    } else if (S.mode === 'grid') {
      S.gridClicks.push([Math.round(p[0]), Math.round(p[1])]);
      if (S.gridClicks.length === 3) {
        const [a1, a12, h1] = S.gridClicks;
        Object.assign(S, { grid: { a1, a12, h1 }, gridGuess: false, gridClicks: [] });
        update();
      } else draw();
      $('modeHint').textContent = gridHint();
    } else if (S.mode === 'rows') {
      const tol = 8 * S.image.width / gel.getBoundingClientRect().width;
      const near = S.dividers.findIndex(d => Math.abs(d - p[1]) < tol);
      const dv = S.dividers.slice();
      if (near >= 0) dv.splice(near, 1); else dv.push(Math.round(p[1]));
      S.edits.dividers = dv.sort((a, b) => a - b);
      S.edits.lanes = null;  // lanes are found again per row
      S.ladderPick = {};
      computeLanes();
      update();
    } else if (S.mode === 'lanes') {
      const i = laneAt(p);
      if (i >= 0) S.lanes.splice(i, 1);
      else {
        const widths = S.lanes.map(l => l.x1 - l.x0).sort((a, b) => a - b);
        const w = widths.length ? widths[widths.length >> 1] : Math.round(S.image.width / 12);
        S.lanes.push({ x0: Math.round(p[0] - w / 2), x1: Math.round(p[0] + w / 2), tier: tierAt(p[1]) });
      }
      lanesChanged();
    } else if (S.mode === 'bands') {
      const b = hitBand(p);
      if (!b) return;
      if (b.manual) {
        S.edits.manual = S.edits.manual.filter(r => !(r[0] === b.bbox[0] && r[1] === b.bbox[1] && r[2] === b.bbox[2] && r[3] === b.bbox[3])
          && !inBox(b.centroid, r));
        S.bands = S.bands.filter(x => x !== b);
        // Model bands it replaced come back on the next detection.
        detect();
        return;
      }
      if (b.removed) {
        S.edits.removed = S.edits.removed.filter(q => hitBand(q) !== b);
        b.removed = false;
      } else {
        S.edits.removed.push([Math.round(p[0]), Math.round(p[1])]);
        b.removed = true;
      }
      update();
    } else if (S.mode === 'ladder') {
      const b = hitBand(p);
      if (!b || b.removed || b.lane < 0) { closePop(); return; }
      if (S.ladderOf[b.tier] !== b.lane) { S.ladderPick[b.tier] = b.lane; update(); }
      openPop(b, p, ev);
    }
  }

  // ---- Ladder size picker ----
  function openPop(band, p, ev) {
    const pop = $('ladderPop'), wrap = $('gelWrap').getBoundingClientRect();
    const sizes = parseLadder().map(([bp]) => bp).sort((a, b) => b - a);
    const used = new Map(S.laneBands[band.lane].filter(b => b !== band && typeof b.ladderFix === 'number').map(b => [b.ladderFix, true]));
    const cur = band.ladderFix;
    const btn = (v, text, extra) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''} ${extra || ''}">${text}</button>`;
    pop.innerHTML = `<div class="popHead">Band size${band.ladderBp && cur == null ? ` <small>(auto: ${band.ladderBp} bp)</small>` : ''}</div>
      <div class="popSizes">${sizes.map(bp => btn(bp, bp + ' bp', used.has(bp) ? 'used' : '')).join('')}</div>
      <div class="popFoot">${btn('auto', 'Auto')}${btn('skip', 'Not a ladder band')}</div>`;
    pop.hidden = false;
    const x = Math.min(ev.clientX - wrap.left + 8, wrap.width - pop.offsetWidth - 4);
    const y = Math.min(ev.clientY - wrap.top + 8, wrap.height - pop.offsetHeight - 4);
    pop.style.left = Math.max(4, x) + 'px';
    pop.style.top = Math.max(4, y) + 'px';
    pop.onclick = e => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      setLadderSize(band, p, v === 'auto' ? null : v === 'skip' ? 'skip' : +v);
      closePop();
    };
  }
  function closePop() { $('ladderPop').hidden = true; }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePop();
    // Shortcuts, unless typing in a field: H overlay, + / − / 0 zoom.
    if (!S.image || e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    if (e.key === 'h' || e.key === 'H') toggleOverlay();
    else if (e.key === '+' || e.key === '=') zoomTo(S.zoom * 1.5);
    else if (e.key === '-') zoomTo(S.zoom / 1.5);
    else if (e.key === '0') zoomTo(1);
  });
  document.addEventListener('pointerdown', e => {
    if (!$('ladderPop').hidden && !e.target.closest('#ladderPop') && e.target !== gel) closePop();
  });

  function setLadderSize(band, p, bp) {
    S.edits.ladder = S.edits.ladder.filter(e => hitBand(e.p) !== band);
    // A size belongs to one band, and sizes must shrink down the lane: the newest choice wins.
    if (typeof bp === 'number') {
      const y = band.centroid[1];
      for (const b of S.laneBands[band.lane]) {
        if (b === band || typeof b.ladderFix !== 'number') continue;
        const f = b.ladderFix;
        if (f === bp || (b.centroid[1] < y && f <= bp) || (b.centroid[1] > y && f >= bp)) {
          delete b.ladderFix;
          S.edits.ladder = S.edits.ladder.filter(e => hitBand(e.p) !== b);
        }
      }
    }
    if (bp == null) delete band.ladderFix;
    else {
      band.ladderFix = bp;
      S.edits.ladder.push({ p: [Math.round(p[0]), Math.round(p[1])], bp });
    }
    update();
  }

  async function onDrag(rect) {
    const [x0, y0, x1, y1] = rect;
    if (S.mode === 'lanes') {
      if (x1 - x0 < 3) return draw();
      const t = tierAt((y0 + y1) / 2);
      S.lanes = S.lanes.filter(l => { const c = (l.x0 + l.x1) / 2; return (l.tier || 0) !== t || c < x0 || c > x1; });
      S.lanes.push({ x0, x1, tier: t });
      lanesChanged();
    } else if (S.mode === 'bands') {
      if (x1 - x0 < 2 || y1 - y0 < 2) return draw();
      busy(true, 'Measuring…');
      try {
        const r = await post(`/api/images/${S.image.id}/measure`, { ...reqBase(), rects: [rect] });
        const mb = r.bands[0];
        if (mb) {
          S.edits.manual.push(mb.bbox);
          S.bands = addManual(S.bands, mb);
        }
      } catch (e) {
        S.error = e.message;
      } finally {
        busy(false);
        update();
      }
    } else draw();
  }

  // ---- Model update ----
  function update() {
    if (!S.image) { renderMsgs(); return; }
    // Faint objects (relative to the brightest band, above background) are ignored.
    const bg = S.globalBg || 0, peak = Math.max(0, ...S.bands.map(b => b.max)), faint = (+$('faint').value || 0) / 100;
    for (const b of S.bands) b.faint = !b.manual && faint > 0 && b.max - bg < faint * (peak - bg);

    const multi = S.layout === 'multi';
    for (const b of S.bands) b.tier = S.layout === 'plate' ? 0 : tierAt(b.centroid[1]);
    if (S.layout === 'plate') {
      S.plate = Cal.plateWells(gridParams());
      S.groups = S.plate.wells.map(w => ({ label: w.label, y0: w.y, tier: 0, well: w }));
    } else {
      S.plate = null;
      const tops = [0, ...S.dividers], bottoms = [...S.dividers, S.image.height], count = {};
      S.groups = S.lanes.map(l => {
        const t = l.tier || 0, k = count[t] = (count[t] || 0) + 1;
        return { label: multi ? `R${t + 1}-${k}` : String(k), y0: tops[t], y1: bottoms[t], tier: t, num: k };
      });
    }
    S.laneBands = S.groups.map(() => []);
    for (const b of S.bands) {
      b.lane = b.removed || b.faint ? -1 : S.plate ? Cal.wellOf(b, S.plate) : Cal.laneOf(b, S.lanes);
      if (b.lane < 0) continue;
      b.pos = b.centroid[1] - S.groups[b.lane].y0;  // migration distance
      S.laneBands[b.lane].push(b);
    }
    S.laneBands.forEach(l => l.sort((a, b) => a.pos - b.pos));

    // One ladder per row: the user's choice, else a default.
    const tiers = S.layout === 'plate' ? 1 : S.dividers.length + 1;
    const inTier = t => S.groups.map((g, i) => i).filter(i => S.groups[i].tier === t);
    const most = idx => idx.slice().sort((a, b) => S.laneBands[b].length - S.laneBands[a].length)[0];
    S.ladderOf = [];
    for (let t = 0; t < tiers; t++) {
      const gis = inTier(t), pick = S.ladderPick[t];
      if (pick != null && S.groups[pick] && S.groups[pick].tier === t) S.ladderOf[t] = pick;
      else if (S.plate) {
        // The marker well with the most bands, else the well with the most bands.
        const markers = gis.filter(i => S.groups[i].well.marker && S.laneBands[i].length >= 2);
        S.ladderOf[t] = markers.length ? most(markers) : most(gis);
      } else if (multi) S.ladderOf[t] = most(gis);  // a ladder has more bands than a sample
      else S.ladderOf[t] = gis[0];                   // standard gels: lane 1
    }
    if (S.sel >= S.groups.length) S.sel = -1;

    // Calibrate each row against its own ladder.
    const ladder = parseLadder(), volKey = $('volKey').value;
    S.cals = S.ladderOf.map((li, t) => {
      const gis = inTier(t);
      return gis.length ? Cal.calibrate(gis.map(i => S.laneBands[i]), gis.indexOf(li), ladder, volKey) : null;
    });
    S.focusTier = S.sel >= 0 ? S.groups[S.sel].tier : Math.max(0, S.cals.findIndex(c => c));
    S.cal = S.cals[S.focusTier] || null;
    const sel = $('ladderLane');
    const choices = S.groups.map((g, i) => i).filter(i => S.laneBands[i].length || isLadderGroup(i));
    sel.innerHTML = choices.map(i => `<option value="${i}">${S.plate ? 'Well' : 'Lane'} ${S.groups[i].label}</option>`).join('');
    sel.value = S.ladderOf[S.focusTier] ?? '';
    const e = S.edits;
    $('resetEdits').disabled = !(e.removed.length || e.manual.length || e.lanes || e.ladder.length);
    $('csv').disabled = !S.groups.length;
    draw(); renderMsgs(); renderTable(); renderPlots();
  }

  function gridParams() {
    const rows = Math.max(2, +$('plateRows').value || 8), cols = Math.max(2, +$('plateCols').value || 12);
    const stagger = $('plateStagger').checked ? 0.5 : 0, w = S.image.width, h = S.image.height;
    let g = S.grid;
    if (!g) {
      // Rough placement until the user clicks the corner wells in Grid mode.
      const a1 = [0.1 * w, 0.14 * h], a12 = [0.84 * w, 0.14 * h];
      const colx = (a12[0] - a1[0]) / (cols - 1);
      g = { a1, a12, h1: [a1[0] + ((rows - 1) % 2) * stagger * colx, 0.8 * h] };
    }
    return { ...g, rows, cols, marker: $('plateMarker').checked, stagger };
  }

  // ---- Drawing ----
  const fmtBp = bp => bp == null ? '' : bp >= 1000 ? +(bp / 1000).toFixed(bp >= 10000 ? 0 : 1) + 'k' : String(Math.round(bp));

  function draw() {
    if (!S.image) return;
    const c = gel, ctx = c.getContext('2d'), V = { w: S.image.width, h: S.image.height };
    // Fit the view to the panel (scaling small images up), capped at 75% of the window height,
    // then apply the zoom.
    const fit = Math.min($('gelWrap').clientWidth / V.w, (window.innerHeight * 0.75) / V.h);
    const scale = S.scale = fit * S.zoom;
    c.classList.toggle('pan', S.mode === 'view' && S.zoom > 1);
    c.style.width = Math.floor(V.w * scale) + 'px';
    c.style.height = Math.floor(V.h * scale) + 'px';
    // Upscaled images get a finer canvas so outlines and labels stay sharp.
    // Capped at ~16 MP so deep zooms don't allocate huge canvases.
    const res = Math.max(1, Math.min(4, Math.ceil(scale * (window.devicePixelRatio || 1)), Math.floor(Math.sqrt(16e6 / (V.w * V.h)))));
    if (c.width !== V.w * res || c.height !== V.h * res) { c.width = V.w * res; c.height = V.h * res; }
    ctx.setTransform(res, 0, 0, res, 0, 0);
    ctx.imageSmoothingEnabled = scale < 1.5;
    ctx.drawImage(S.img, 0, 0);
    if (!S.overlay) return;
    const u = 1 / scale;  // one screen pixel in image pixels
    const fs = 12 * u;
    const top = 0, bottom = S.image.height;

    const label = (text, x, y, color, align) => {
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = align; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3 * u; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color; ctx.fillText(text, x, y);
    };

    for (const [x0, y0, x1, y1] of S.wells) {
      ctx.strokeStyle = 'rgba(255,200,0,0.6)'; ctx.lineWidth = 0.75 * u;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }

    if (S.plate) {
      const P = S.plate, ww = 0.5 * P.colPitch, wh = 0.16 * P.rowPitch;
      S.groups.forEach((g, i) => {
        const W = g.well, isLadder = isLadderGroup(i), has = S.laneBands[i].length > 0;
        ctx.globalAlpha = has || isLadder || i === S.sel ? 1 : 0.45;
        ctx.strokeStyle = isLadder ? '#ff5ce1' : W.marker ? '#ffc800' : '#38d0ff';
        ctx.lineWidth = (i === S.sel ? 2 : 0.75) * u;
        ctx.strokeRect(W.x - ww / 2, W.y - wh / 2, ww, wh);
        ctx.globalAlpha = 1;
        if (has || isLadder || i === S.sel) label(W.label, W.x - ww / 2 - 2 * u, W.y, isLadder ? '#ff5ce1' : '#9fe8ff', 'right');
      });
      for (const [x, y] of S.gridClicks) {
        ctx.strokeStyle = '#ffc800'; ctx.lineWidth = 2 * u;
        ctx.beginPath(); ctx.arc(x, y, 6 * u, 0, 2 * Math.PI); ctx.stroke();
      }
    } else {
      S.lanes.forEach((l, i) => {
        const g = S.groups[i], isLadder = isLadderGroup(i);
        const color = isLadder ? '#ff5ce1' : '#38d0ff';
        ctx.strokeStyle = color;
        ctx.lineWidth = (i === S.sel ? 2 : 0.75) * u;
        ctx.strokeRect(l.x0, g.y0 + u, l.x1 - l.x0, g.y1 - g.y0 - 2 * u);
        label(isLadder ? `L${g.num}` : String(g.num), (l.x0 + l.x1) / 2, g.y0 + fs, color, 'center');
      });
      S.dividers.forEach((d, t) => {
        ctx.setLineDash([6 * u, 4 * u]); ctx.strokeStyle = '#ffc800'; ctx.lineWidth = u;
        ctx.beginPath(); ctx.moveTo(0, d); ctx.lineTo(S.image.width, d); ctx.stroke();
        ctx.setLineDash([]);
      });
      if (S.layout === 'multi') {
        [0, ...S.dividers].forEach((d, t) => label(`Row ${t + 1}`, 4 * u, d + fs, '#ffc800', 'left'));
      }
    }

    for (const b of S.bands) {
      if (b.faint) {
        const [x0, y0, x1, y1] = b.bbox;
        ctx.setLineDash([2 * u, 3 * u]); ctx.strokeStyle = 'rgba(154,165,177,0.6)'; ctx.lineWidth = 0.75 * u;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
        continue;
      }
      const isLadder = isLadderGroup(b.lane);
      const color = b.removed ? '#ff4d4d' : b.lane < 0 ? '#9aa5b1' : b.manual ? '#ffd23f' : isLadder ? '#ff5ce1' : '#7dff4f';
      ctx.beginPath();
      const pts = b.contour && b.contour.length > 2 ? b.contour
        : [[b.bbox[0], b.bbox[1]], [b.bbox[2], b.bbox[1]], [b.bbox[2], b.bbox[3]], [b.bbox[0], b.bbox[3]]];
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      if (b.removed) ctx.setLineDash([3 * u, 3 * u]);
      ctx.strokeStyle = b.saturated && !b.removed ? '#ff3b3b' : color;
      ctx.lineWidth = (b.saturated && !b.removed ? 1.25 : 0.75) * u;
      ctx.stroke();
      ctx.setLineDash([]);
      if (!b.removed && b.lane >= 0 && (isLadder || b.lane === S.sel)) {
        const fixed = isLadder && typeof b.ladderFix === 'number' && b.ladderBp === b.ladderFix;
        const text = isLadder && b.ladderFix === 'skip' ? '✕' : isLadder && b.ladderBp ? fmtBp(b.ladderBp) : isLadder ? '?' : fmtBp(b.bp);
        const lx = S.plate ? b.bbox[2] + 3 * u : S.lanes[b.lane].x1 + 3 * u;
        if (text) label(fixed ? text + ' ✓' : text, lx, b.centroid[1], fixed ? '#ffd23f' : '#fff', 'left');
      }
    }

    if (S.drag && S.drag.moved) {
      const [ax, ay] = S.drag.start, [bx, by] = S.drag.end;
      ctx.setLineDash([5 * u, 4 * u]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * u;
      if (S.mode === 'lanes') {
        const t = tierAt((ay + by) / 2), y0 = t ? S.dividers[t - 1] : 0, y1 = S.dividers[t] ?? bottom;
        ctx.strokeRect(Math.min(ax, bx), y0, Math.abs(bx - ax), y1 - y0);
      }
      else ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.setLineDash([]);
    }
  }

  // ---- Messages ----
  // Remember whether the warnings are expanded across re-renders.
  $('msgs').addEventListener('toggle', e => { S.warnOpen = e.target.open; }, true);

  function renderMsgs() {
    const items = [];
    if (S.error) items.push(['err', S.error]);
    if (S.image && !S.error) {
      const removed = S.bands.filter(b => b.removed).length, faint = S.bands.filter(b => b.faint).length;
      const loose = S.bands.filter(b => !b.removed && !b.faint && b.lane < 0).length;
      const groups = S.plate ? `${S.laneBands.filter(l => l.length).length} wells with bands`
        : S.layout === 'multi' ? `${S.dividers.length + 1} rows, ${S.lanes.length} lanes` : `${S.lanes.length} lanes`;
      let info = `${groups}, ${S.bands.length - removed - faint} bands`;
      if (removed) info += `, ${removed} removed`;
      if (faint) info += `, ${faint} faint objects ignored (dotted)`;
      if (loose) info += `, ${loose} outside any ${S.plate ? 'well' : 'lane'} (grey, not counted)`;
      info += `. ${invert() ? 'Inverted (dark bands).' : 'Bright bands.'}`;
      if (S.seconds != null) info += ` Detection took ${S.seconds} s${S.upscale > 1 ? ` (upscaled ${S.upscale}×)` : ''}.`;
      if (S.layout === 'multi') {
        const r2 = S.cals.map((c, t) => (c && c.r2 != null ? `row ${t + 1} ${c.r2.toFixed(3)}` : null)).filter(Boolean);
        if (r2.length) info += ` Mass fit R²: ${r2.join(', ')}.`;
      } else if (S.cal && S.cal.r2 != null) info += ` Mass fit R² = ${S.cal.r2.toFixed(3)}.`;
      items.push(['', info]);
      if (S.plate && S.gridGuess) items.push(['warn', 'The well grid is only a rough guess. Click Grid, then the centres of wells A1, A12 and H1.']);
      S.cals.forEach((c, t) => {
        for (const w of (c && c.warnings) || []) items.push(['warn', S.layout === 'multi' ? `Row ${t + 1}: ${w}` : w]);
      });
      if (active().some(b => b.saturated)) items.push(['warn', 'Some bands are saturated (red outline). Their amounts are underestimated; use a shorter exposure if you can.']);
    }
    // Status and errors stay visible; warnings fold into one collapsible item.
    const li = ([c, t]) => `<li class="${c}">${esc(t)}</li>`;
    const warns = items.filter(([c]) => c === 'warn');
    let html = items.filter(([c]) => c !== 'warn').map(li).join('');
    if (warns.length) {
      html += `<li class="warnGroup"><details${S.warnOpen ? ' open' : ''}>
        <summary>${warns.length} warning${warns.length > 1 ? 's' : ''}</summary>
        <ul class="msgs">${warns.map(li).join('')}</ul></details></li>`;
    }
    $('msgs').innerHTML = html;
  }

  // ---- Results ----
  function results() {
    const ul = parseFloat($('sampleUl').value), volKey = $('volKey').value;
    const out = [];
    S.laneBands.forEach((lane, li) => lane.forEach((b, bi) => {
      const isLadder = isLadderGroup(li);
      const g = S.groups[li];
      out.push({
        gi: li, label: g.label,
        row: g.well ? 'ABCDEFGHIJKLMNOP'[g.well.row] : S.layout === 'multi' ? g.tier + 1 : '',
        col: g.well ? (g.well.marker ? 'M' : g.well.col + 1) : g.num,
        band: bi + 1, isLadder, b,
        x: b.centroid[0], y: b.centroid[1], run: b.pos, rf: S.plate ? null : b.pos / (g.y1 - g.y0),
        bp: b.bp, ng: b.ng, vol: b[volKey],
        conc: !isLadder && b.ng != null && ul > 0 ? b.ng / ul : null,
        ladderBp: isLadder ? b.ladderBp : null, ladderNg: isLadder ? b.ladderNg : null,
        flags: b.flags || [],
      });
    }));
    return out;
  }

  const num = (v, d) => v == null || !isFinite(v) ? '' : v.toFixed(d);

  function renderTable() {
    if (!S.image) return;
    $('laneHead').textContent = S.plate ? 'Well' : 'Lane';
    $('posHead').textContent = S.plate ? 'Run (px)' : 'Rf';
    $('rows').innerHTML = results().map(r => {
      const known = (v, k, d) => r.isLadder && k != null ? `${num(v, d)} <small>(${k})</small>` : num(v, d);
      return `<tr class="${r.isLadder ? 'ladder' : ''} ${r.gi === S.sel ? 'sel' : ''}" data-lane="${r.gi}">
        <td>${r.isLadder && S.layout === 'lanes' ? 'L' + r.label : esc(r.label)}</td><td>${r.band}</td>
        <td>${known(r.bp, r.ladderBp, 0)}</td><td>${known(r.ng, r.ladderNg, 1)}</td>
        <td>${num(r.conc, 2)}</td><td>${num(r.vol, 0)}</td><td>${r.b.area}</td><td>${S.plate ? num(r.run, 0) : num(r.rf, 3)}</td>
        <td class="l">${esc(r.flags.join(', '))}</td></tr>`;
    }).join('');
  }
  $('rows').addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    S.sel = +tr.dataset.lane;
    update();
  });

  function downloadCsv() {
    const volKey = $('volKey').value;
    const cols = ['file', 'lane_or_well', 'row', 'column', 'band', 'is_ladder', 'x_px', 'y_px', 'migration_px', 'rf', 'size_bp', 'mass_ng', 'conc_ng_per_ul',
                  'volume_used', 'raw_volume', 'global_volume', 'local_volume', 'rb_volume', 'area_px', 'mean_intensity',
                  'source', 'ladder_size_bp', 'ladder_mass_ng', 'flags', 'model'];
    const csvEsc = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [cols.join(',')];
    for (const r of results()) {
      const b = r.b;
      lines.push([S.image.name, r.label, r.row, r.col, r.band, r.isLadder ? 'yes' : 'no', num(r.x, 1), num(r.y, 1), num(r.run, 1), num(r.rf, 4),
                  num(r.bp, 0), num(r.ng, 3), num(r.conc, 4), volKey.replace('_volume', ''),
                  num(b.raw_volume, 1), num(b.global_volume, 1), num(b.local_volume, 1), num(b.rb_volume, 1),
                  b.area, num(b.mean, 2), b.manual ? 'manual' : 'model', r.ladderBp ?? '', r.ladderNg ?? '',
                  r.flags.join('; '), S.model || ''].map(v => csvEsc(String(v))).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.image.name.replace(/\.[^.]+$/, '') || 'gel') + '_bands.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- Plots ----
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= step0);
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(10));
    return out;
  }
  function logTicks(lo, hi) {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
      for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) out.push(v); }
    }
    return out;
  }
  const fmtK = v => v >= 1e6 ? +(v / 1e6).toPrecision(3) + 'M' : v >= 1e3 ? +(v / 1e3).toPrecision(3) + 'k' : String(v);

  function plot(canvas, o) {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--grid').trim();
    if (!o) {
      ctx.fillStyle = muted; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('No data', W / 2, H / 2);
      return;
    }
    const m = { l: 54, r: 10, t: 8, b: 34 };
    const ty = v => o.logY ? Math.log10(v) : v;
    const y0 = ty(o.y[0]), y1 = ty(o.y[1]);
    const X = v => m.l + (v - o.x[0]) / (o.x[1] - o.x[0] || 1) * (W - m.l - m.r);
    const Y = v => H - m.b - (ty(v) - y0) / (y1 - y0 || 1) * (H - m.t - m.b);
    ctx.font = '11px system-ui'; ctx.lineWidth = 1;
    ctx.fillStyle = muted; ctx.strokeStyle = grid;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of o.logY ? logTicks(o.y[0], o.y[1]) : niceTicks(o.y[0], o.y[1], 4)) {
      ctx.beginPath(); ctx.moveTo(m.l, Y(t) + 0.5); ctx.lineTo(W - m.r, Y(t) + 0.5); ctx.stroke();
      ctx.fillText(o.fmtY ? o.fmtY(t) : String(t), m.l - 4, Y(t));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of niceTicks(o.x[0], o.x[1], 5)) ctx.fillText(String(t), X(t), H - m.b + 4);
    ctx.fillText(o.xlabel, (m.l + W - m.r) / 2, H - 14);
    ctx.save(); ctx.translate(11, (m.t + H - m.b) / 2); ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle'; ctx.fillText(o.ylabel, 0, 0); ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(m.l, m.t, W - m.l - m.r, H - m.t - m.b); ctx.clip();
    o.draw(ctx, X, Y, css);
    ctx.restore();
  }

  const dot = (ctx, x, y, r, fill, stroke) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  };

  function renderPlots() {
    const cal = S.cal, pairs = (cal && cal.pairs) || [];
    // x axis: position from the top (gel) or migration below the well (plate).
    const focus = S.laneBands.filter((l, i) => S.groups[i].tier === S.focusTier);
    const runs = focus.flat().map(b => b.pos);
    const top = 0, bottom = S.plate || S.layout === 'multi' ? Math.max(1, ...runs) * 1.15 : S.image ? S.image.height : 1;
    const rowNote = S.layout === 'multi' ? ` (row ${S.focusTier + 1})` : '';
    $('sizeTitle').textContent = 'Size calibration' + rowNote;
    plot($('plotSize'), cal && cal.sizeFn && {
      x: [top, bottom], y: [cal.bpRange[0] / 1.6, cal.bpRange[1] * 1.6], logY: true,
      xlabel: S.plate ? 'Migration below well (px)' : S.layout === 'multi' ? 'Position below row top (px)' : 'Position (px from top)', ylabel: 'Size (bp)', fmtY: fmtBp,
      draw(ctx, X, Y, css) {
        const accent = css.getPropertyValue('--accent').trim(), ladder = css.getPropertyValue('--ladder').trim();
        ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath();
        for (let y = top; y <= bottom; y += 2) ctx.lineTo(X(y), Y(cal.sizeFn(y)));
        ctx.stroke();
        S.laneBands.forEach((l, li) => { if (!isLadderGroup(li) && S.groups[li].tier === S.focusTier) for (const b of l) dot(ctx, X(b.pos), Y(b.bp), 3, null, accent); });
        for (const b of pairs) dot(ctx, X(b.pos), Y(b.ladderBp), 4, ladder);
      },
    });

    const volKey = $('volKey').value;
    const mp = pairs.filter(b => b.ladderNg != null);
    $('massTitle').textContent = (cal && cal.r2 != null ? `Mass calibration (R² = ${cal.r2.toFixed(3)})` : 'Mass calibration') + rowNote;
    const xmax = mp.length ? Math.max(...mp.map(b => b.ladderNg)) * 1.1 : 1;
    plot($('plotMass'), cal && cal.k && mp.length && {
      x: [0, xmax], y: [0, Math.max(...mp.map(b => b[volKey])) * 1.1],
      xlabel: 'Ladder band mass (ng)', ylabel: 'Band volume', fmtY: fmtK,
      draw(ctx, X, Y, css) {
        const accent = css.getPropertyValue('--accent').trim(), ladder = css.getPropertyValue('--ladder').trim();
        ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(xmax), Y(cal.k * xmax)); ctx.stroke();
        for (const b of mp) b.saturated ? dot(ctx, X(b.ladderNg), Y(b[volKey]), 4, null, '#e5484d') : dot(ctx, X(b.ladderNg), Y(b[volKey]), 4, ladder);
      },
    });
  }

  window.addEventListener('resize', () => { if (S.image) { draw(); renderPlots(); } });
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderPlots);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  renderPlots();
  loadModels();
})();
