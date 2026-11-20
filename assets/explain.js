/* How SDMP explains a layout -- interactive reading of Y = U · P.
   Prototype: one toy small enough to read cell by cell, no build step.

   Everything drawn here comes out of docs/data/explainer_toy.json, written by
   experiments/export_explainer_toy.py, which runs the same pipeline the real
   datasets go through: UMAP's fuzzy kNN graph, the symmetric normalised
   Laplacian, and a cross-entropy fit of the coefficients. */
'use strict';

/* --------------------------------------------------------------- palette */

/* BrBG, the same diverging ramp the signed panels in the viewer use. */
const DIV = ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#f5f5f5',
             '#c7eae5', '#80cdc1', '#35978f', '#01665e'];
/* plasma, truncated before it turns pale: coarse modes dark, fine modes warm. */
const MODE_COLOR = ['#0d0887', '#5302a3', '#8b0aa5', '#b83289',
                    '#db5c68', '#f48849', '#febd2a', '#c88a16'];

const INK = '#1e302d', MUTED = '#4d5c58', FAINT = '#76837f';
const RULE = '#d7dfdb', ACCENT = '#0b665b';
const MONO = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/* ----------------------------------------------------------------- state */

const state = {
  toyKey: 'blobs',
  mode: -1,          // hovered mode, -1 for none
  point: -1,         // hovered point
  pinned: -1,
  cutoff: 8,
  fan: false,
};

let toys = null, toy = null, order = null;

/* the page says where its data sits, so this file works both at the site root
   and from a subdirectory such as /explain/ */
const TOY_URL = document.currentScript?.dataset.toy || 'data/explainer_toy.json';

const el = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fmt = (v, d) => (Math.abs(v) < 1e-12 ? '0' : v.toFixed(d));

function activePoint() { return state.pinned >= 0 ? state.pinned : state.point; }

/* ------------------------------------------------------------- canvas fit */

function fit(cv) {
  if (!cv._logical) cv._logical = { w: cv.width, h: cv.height };
  const { w, h } = cv._logical;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || w;
  const cssH = cssW * h / w;
  cv.style.height = cssH + 'px';
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const ctx = cv.getContext('2d');
  const k = cssW * dpr / w;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function local(cv, ev) {
  const r = cv.getBoundingClientRect();
  const { w, h } = cv._logical;
  return [(ev.clientX - r.left) / r.width * w, (ev.clientY - r.top) / r.height * h];
}

/* ------------------------------------------------------------- colour ops */

function hexRGB(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rampColor(stops, t) {
  t = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(t), stops.length - 2), f = t - i;
  const a = hexRGB(stops[i]), b = hexRGB(stops[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},` +
         `${Math.round(a[1] + (b[1] - a[1]) * f)},` +
         `${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/* Signed value on a symmetric diverging scale. */
const divColor = (v, lim) => rampColor(DIV, 0.5 + 0.5 * clamp(v / (lim || 1), -1, 1));

/* --------------------------------------------------------------- geometry */

function frameOf(pts, rect, pad, include) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const scan = (x, y) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  pts.forEach((p) => scan(p[0], p[1]));
  if (include) include.forEach((p) => scan(p[0], p[1]));
  const sx = (rect.w - 2 * pad) / Math.max(x1 - x0, 1e-9);
  const sy = (rect.h - 2 * pad) / Math.max(y1 - y0, 1e-9);
  const s = Math.min(sx, sy);
  const ox = rect.x + pad + (rect.w - 2 * pad - (x1 - x0) * s) / 2;
  const oy = rect.y + pad + (rect.h - 2 * pad - (y1 - y0) * s) / 2;
  return {
    fx: (x) => ox + (x - x0) * s,
    /* screen y grows downward; flip so the layout reads like a plot */
    fy: (y) => oy + (y1 - y) * s,
    s,
  };
}

function text(ctx, str, x, y, { font = MONO, fill = MUTED, align = 'left', base = 'alphabetic' } = {}) {
  ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = align; ctx.textBaseline = base;
  ctx.fillText(str, x, y);
}

function arrow(ctx, x0, y0, x1, y1, color, width, head) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  if (len < 4 || !head) return;
  const a = Math.atan2(dy, dx), h = Math.min(head, len * 0.5);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - h * Math.cos(a - 0.42), y1 - h * Math.sin(a - 0.42));
  ctx.lineTo(x1 - h * Math.cos(a + 0.42), y1 - h * Math.sin(a + 0.42));
  ctx.closePath(); ctx.fill();
}

/* --------------------------------------------------------- toy accessors */

const U = (n, s) => toy.U[n][s];
const pNorm = (s) => Math.hypot(toy.P[s][0], toy.P[s][1]);
const classColor = (n) => toy.classes[toy.labels[n]].color;

function maxAbsU() {
  let m = 0;
  toy.U.forEach((row) => row.forEach((v) => { if (Math.abs(v) > m) m = Math.abs(v); }));
  return m;
}

/* Partial sum of the first k displacements for point n. */
function partial(n, k) {
  let x = 0, y = 0;
  for (let s = 0; s < k; s++) { x += U(n, s) * toy.P[s][0]; y += U(n, s) * toy.P[s][1]; }
  return [x, y];
}

/* ------------------------------------------------------------- captions */

function modeNote(s) {
  if (s < 0) return toy.key === 'ring'
    ? 'A ring has no clusters, so its modes are plain frequencies, the discrete sines and cosines of the cycle.'
    : 'Hover a column.';
  const lam = toy.eigenvalues[s];
  const head = `Mode ${s + 1}, λ = ${fmt(lam, 4)}. `;
  if (toy.key === 'ring') {
    const cycles = Math.floor(s / 2) + 1;
    const twin = s % 2 === 0 ? s + 2 : s;
    return head + `${cycles} full ${cycles === 1 ? 'cycle' : 'cycles'} around the ring. ` +
      `Modes ${twin - 1} and ${twin} share an eigenvalue, so they are the same frequency ` +
      'at two phases. The pair is determined, but neither one of them on its own is.';
  }
  const tail = [
    'Positive on one group, negative on the other. The coarsest split the graph has, and the lowest eigenvalue in it.',
    'Flat across the left group, top against bottom on the right. A mode can live in one part of the graph and ignore the rest.',
    'The same split, on the left group instead. Its eigenvalue is within 0.01 of mode 2, so which group each of the two takes comes down to numerical accident rather than to anything in the data.',
    'No group structure left. It changes sign between neighbours, which is what a larger eigenvalue measures.',
  ][Math.min(s, 3)];
  return head + tail;
}

/* ================================================================ panel 1 */

const EQ_PARTS = {
  Y: {
    title: 'Y, the layout',
    body: 'Where every point ends up on screen. One row per point, one column per axis. SDMP never optimizes these numbers directly. They are read off the product.',
    flow: 'Y = U · P',
    tag: 'read off',
  },
  U: {
    title: 'U, the spectral basis',
    body: 'What the neighbour graph looks like at each scale, from coarse to fine. One row per point, one column per mode kept. It is fixed before optimization starts, and optimization never touches it.',
    flow: 'X → kNN graph → Laplacian → eigenvectors',
    tag: 'fixed by the data',
  },
  P: {
    title: 'P, the coefficients',
    body: 'How much of each scale the layout uses, and in which direction. Two numbers per mode. This is the whole of what optimization changes, which is why the layout can be read back off it.',
    flow: 'init [I ; 0] + noise → minimize cross-entropy',
    tag: 'learned',
  },
};

function drawEquation() {
  const svg = el('eq-svg');
  const N = toy.n_points, S = toy.n_modes, M = 2;
  const H = 118, cw = 9;                      // block height, column width
  const hP = H * S / N;                        // P is S rows tall, to scale
  const y0 = 24;

  const blocks = [
    { k: 'Y', x: 44, y: y0, w: cw * M, h: H, dims: `${N} × ${M}` },
    { k: 'U', x: 44 + cw * M + 46, y: y0, w: cw * S, h: H, dims: `${N} × ${S}` },
    { k: 'P', x: 44 + cw * M + 46 + cw * S + 26, y: y0, w: cw * M, h: hP, dims: `${S} × ${M}` },
  ];
  /* the operators go in the gaps between the blocks, centred on the tall ones */
  const gap = (a, b) => (a.x + a.w + b.x) / 2;
  const mid = y0 + H / 2;
  const parts = [
    `<text x="${gap(blocks[0], blocks[1])}" y="${mid}" class="op">=</text>`,
    `<text x="${gap(blocks[1], blocks[2])}" y="${mid}" class="op dot">·</text>`,
  ];
  blocks.forEach((b) => {
    const dim = state.eq && state.eq !== b.k ? ' dim' : '';
    parts.push(
      `<g class="eqb${dim}" data-k="${b.k}">` +
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"></rect>` +
      `<text x="${b.x + b.w / 2}" y="${b.y - 9}" class="lab">${b.k}</text>` +
      `<text x="${b.x + b.w / 2}" y="${b.y + b.h + 15}" class="dims">${b.dims}</text>` +
      `</g>`);
  });
  /* the mode axis runs along U's columns and P's rows -- say so once */
  const u = blocks[1];
  parts.push(
    `<line class="axis" x1="${u.x}" y1="${y0 + H + 26}" x2="${u.x + u.w}" y2="${y0 + H + 26}"></line>`,
    `<text x="${u.x + u.w / 2}" y="${y0 + H + 40}" class="dims">coarse → fine</text>`);

  svg.innerHTML = `<style>
    .eqb rect { fill:#eef3f2; stroke:${INK}; stroke-width:1.2; cursor:pointer; transition:fill .12s,opacity .12s; }
    .eqb:hover rect, .eqb.on rect { fill:${ACCENT}; }
    .eqb.dim { opacity:.3; }
    .eqb .lab { font:600 14px ui-monospace,Menlo,monospace; fill:${INK}; text-anchor:middle; }
    .eqb .dims, .dims { font:10px ui-monospace,Menlo,monospace; fill:${FAINT}; text-anchor:middle; }
    .op { font:17px ui-monospace,Menlo,monospace; fill:${MUTED};
          text-anchor:middle; dominant-baseline:central; }
    /* a middle dot at the same size reads much lighter than an equals sign */
    .op.dot { font-size:26px; }
    .axis { stroke:${RULE}; stroke-width:1; }
  </style>${parts.join('')}`;

  svg.querySelectorAll('.eqb').forEach((g) => {
    const k = g.dataset.k;
    g.addEventListener('mouseenter', () => { state.eq = k; drawEquation(); showGloss(k); });
    g.addEventListener('mouseleave', () => { state.eq = null; drawEquation(); showGloss(null); });
  });
  if (state.eq) svg.querySelector(`.eqb[data-k="${state.eq}"]`).classList.add('on');
}

function showGloss(k) {
  const g = el('eq-gloss');
  if (!k) {
    g.innerHTML = '<p>Three blocks, one product. Hover one to see what it holds and where it comes from.</p>';
    return;
  }
  const p = EQ_PARTS[k];
  g.innerHTML = `<h3>${p.title}</h3><p>${p.body}</p>` +
    `<div class="flow">${p.flow}</div><span class="learned">${p.tag}</span>`;
}

/* ================================================================ panel 2 */

function drawGraph() {
  const { ctx, w, h } = fit(el('graph'));
  const rect = { x: 0, y: 0, w, h: h - 22 };
  const F = frameOf(toy.X, rect, 26);
  const lim = maxAbsU();

  toy.edges.forEach(([i, j, wt]) => {
    ctx.strokeStyle = `rgba(118,131,127,${clamp(wt * 0.55, 0.05, 0.4)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(F.fx(toy.X[i][0]), F.fy(toy.X[i][1]));
    ctx.lineTo(F.fx(toy.X[j][0]), F.fy(toy.X[j][1]));
    ctx.stroke();
  });

  const act = activePoint();
  toy.X.forEach((p, n) => {
    const x = F.fx(p[0]), y = F.fy(p[1]);
    ctx.beginPath();
    ctx.arc(x, y, n === act ? 6 : 4.4, 0, Math.PI * 2);
    ctx.fillStyle = state.mode >= 0 ? divColor(U(n, state.mode), lim) : classColor(n);
    ctx.fill();
    ctx.strokeStyle = n === act ? INK : 'rgba(30,48,45,.45)';
    ctx.lineWidth = n === act ? 2 : 0.8;
    ctx.stroke();
  });

  text(ctx, state.mode >= 0
    ? `coloured by u_${state.mode + 1}  (brown −, teal +)`
    : 'the input points and their kNN graph', 4, h - 6, { fill: FAINT });
  el('graph-sub').textContent = state.mode >= 0
    ? `Column ${state.mode + 1} of U, drawn where the points are.`
    : `${toy.n_points} points, k = ${toy.n_neighbors}. All U is computed from.`;
}

/* U as a grid: rows are points grouped by class, columns are modes. */
function umatGeom(w, h) {
  const left = 30, top = 26, right = 12, bottom = 26;
  const cw = (w - left - right) / toy.n_modes;
  const rh = (h - top - bottom) / toy.n_points;
  return { left, top, cw, rh };
}

function drawUMatrix() {
  const cv = el('umat');
  const { ctx, w, h } = fit(cv);
  const g = umatGeom(w, h);
  const lim = maxAbsU();
  const act = activePoint();

  order.forEach((n, r) => {
    for (let s = 0; s < toy.n_modes; s++) {
      ctx.fillStyle = divColor(U(n, s), lim);
      ctx.fillRect(g.left + s * g.cw, g.top + r * g.rh, g.cw + 0.5, g.rh + 0.5);
    }
    ctx.fillStyle = classColor(n);
    ctx.fillRect(g.left - 9, g.top + r * g.rh, 6, g.rh + 0.5);
  });

  if (state.mode >= 0) {
    ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
    ctx.strokeRect(g.left + state.mode * g.cw, g.top - 1, g.cw, g.rh * toy.n_points + 2);
  }
  if (act >= 0) {
    const r = order.indexOf(act);
    ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
    ctx.strokeRect(g.left - 10, g.top + r * g.rh - 0.5, g.cw * toy.n_modes + 11, g.rh + 1);
  }

  for (let s = 0; s < toy.n_modes; s++) {
    text(ctx, String(s + 1), g.left + (s + 0.5) * g.cw, g.top - 6,
      { align: 'center', fill: s === state.mode ? INK : FAINT });
  }
  text(ctx, 'mode', g.left, g.top - 17, { fill: FAINT });

  /* eigenvalue strip: where each mode actually sits on the spectrum */
  const sy = g.top + g.rh * toy.n_points + 11;
  const lamMax = toy.eigenvalues[toy.n_modes - 1] * 1.08;
  ctx.strokeStyle = RULE; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(g.left, sy); ctx.lineTo(g.left + g.cw * toy.n_modes, sy); ctx.stroke();
  toy.eigenvalues.forEach((lam, s) => {
    const x = g.left + (lam / lamMax) * g.cw * toy.n_modes;
    ctx.strokeStyle = s === state.mode ? INK : MODE_COLOR[s];
    ctx.lineWidth = s === state.mode ? 2.2 : 1.4;
    ctx.beginPath(); ctx.moveTo(x, sy - 5); ctx.lineTo(x, sy + 5); ctx.stroke();
  });
  text(ctx, 'λ', g.left - 8, sy + 4, { fill: FAINT, align: 'right' });

  el('umat-sub').innerHTML = 'Each cell is <span class="sym">u<sub>n,s</sub></span>. ' +
    'The strip places the modes at their eigenvalues, not at their index.';
}

/* clear the rotated label properly: redraw it rotated */
function drawUMatrixLabel() {
  const cv = el('umat');
  const ctx = cv.getContext('2d');
  const { w, h } = cv._logical;
  const g = umatGeom(w, h);
  ctx.save();
  ctx.translate(11, g.top + g.rh * toy.n_points / 2);
  ctx.rotate(-Math.PI / 2);
  text(ctx, 'points, grouped by class', 0, 0, { align: 'center', fill: FAINT });
  ctx.restore();
}

/* ================================================================ panel 3 */

function drawPArrows() {
  const { ctx, w, h } = fit(el('parrows'));
  const S = toy.n_modes;
  const cx = w / 2, cy = h / 2 - 6;
  let maxp = 0;
  for (let s = 0; s < S; s++) maxp = Math.max(maxp, pNorm(s));
  const k = Math.min(w, h) * 0.38 / maxp;

  ctx.strokeStyle = RULE; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(14, cy); ctx.lineTo(w - 14, cy);
  ctx.moveTo(cx, 14); ctx.lineTo(cx, h - 26); ctx.stroke();

  for (let s = 0; s < S; s++) {
    const on = state.mode < 0 || state.mode === s;
    const x = cx + toy.P[s][0] * k, y = cy - toy.P[s][1] * k;
    ctx.globalAlpha = on ? 1 : 0.16;
    arrow(ctx, cx, cy, x, y, MODE_COLOR[s], state.mode === s ? 3 : 1.8, 9);
    /* short arrows crowd the origin, so only label what there is room for */
    const len = Math.hypot(x - cx, y - cy);
    if (on && (len > 26 || state.mode === s)) {
      const ux = (x - cx) / (len || 1), uy = (y - cy) / (len || 1);
      text(ctx, String(s + 1), x + ux * 11 - uy * 4, y + uy * 11 + ux * 4 + 4,
        { fill: MODE_COLOR[s], font: '600 ' + MONO, align: 'center' });
    }
    ctx.globalAlpha = 1;
  }
  text(ctx, 'embedding x →', w - 14, cy - 6, { align: 'right', fill: FAINT });
  text(ctx, state.mode >= 0
    ? `p_${state.mode + 1} = (${fmt(toy.P[state.mode][0], 2)}, ${fmt(toy.P[state.mode][1], 2)})`
    : 'hover a bar or an arrow', 6, h - 7, { fill: MUTED });
}

function pbarGeom(w, h) {
  const left = 58, top = 22, right = 46, bottom = 24;
  return { left, top, right, bottom, rh: (h - top - bottom) / toy.n_modes, bw: w - left - right };
}

function drawPBars() {
  const cv = el('pbars');
  const { ctx, w, h } = fit(cv);
  const g = pbarGeom(w, h);
  let maxp = 0;
  for (let s = 0; s < toy.n_modes; s++) maxp = Math.max(maxp, pNorm(s));

  text(ctx, '‖p_s‖   how much the layout uses mode s', 6, 13, { fill: MUTED });
  for (let s = 0; s < toy.n_modes; s++) {
    const y = g.top + s * g.rh, bh = g.rh * 0.68;
    const len = (pNorm(s) / maxp) * g.bw;
    ctx.globalAlpha = state.mode < 0 || state.mode === s ? 1 : 0.22;
    ctx.fillStyle = MODE_COLOR[s];
    ctx.fillRect(g.left, y + (g.rh - bh) / 2, len, bh);
    text(ctx, `mode ${s + 1}`, g.left - 6, y + g.rh / 2 + 3,
      { align: 'right', fill: state.mode === s ? INK : FAINT });
    text(ctx, fmt(pNorm(s), 1), g.left + len + 5, y + g.rh / 2 + 3, { fill: MUTED });
    ctx.globalAlpha = 1;
  }
  text(ctx, 'the profile falls from coarse to fine', 6, h - 7, { fill: FAINT });
}

/* ================================================================ panel 4 */

function drawChain() {
  const cv = el('chain');
  const { ctx, w, h } = fit(cv);
  const rect = { x: 0, y: 0, w, h: h - 20 };
  const F = frameOf(toy.Y, rect, 30, [[0, 0]]);
  const n = activePoint();

  /* the layout itself, faint */
  toy.Y.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(F.fx(p[0]), F.fy(p[1]), i === n ? 6 : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = classColor(i);
    ctx.globalAlpha = i === n ? 1 : 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (i === n) { ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke(); }
  });

  /* the origin, where every chain starts */
  const ox = F.fx(0), oy = F.fy(0);
  ctx.strokeStyle = RULE; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ox - 7, oy); ctx.lineTo(ox + 7, oy);
  ctx.moveTo(ox, oy - 7); ctx.lineTo(ox, oy + 7); ctx.stroke();
  text(ctx, 'origin', ox + 9, oy + 12, { fill: FAINT });

  if (n < 0) {
    text(ctx, 'hover a point', 6, h - 6, { fill: FAINT });
    el('chain-sub').textContent = 'The toy layout Y.';
    el('chain-note').textContent = 'Each segment is one mode\'s contribution to this point.';
    return;
  }

  let cx = 0, cy = 0;
  for (let s = 0; s < toy.n_modes; s++) {
    const dx = U(n, s) * toy.P[s][0], dy = U(n, s) * toy.P[s][1];
    const past = s >= state.cutoff;
    const sx = state.fan ? 0 : cx, sy = state.fan ? 0 : cy;
    const on = state.mode < 0 || state.mode === s;
    ctx.globalAlpha = past ? 0.12 : (on ? 1 : 0.2);
    arrow(ctx, F.fx(sx), F.fy(sy), F.fx(sx + dx), F.fy(sy + dy),
      MODE_COLOR[s], state.mode === s ? 3.4 : 2, 8);
    ctx.globalAlpha = 1;
    cx += dx; cy += dy;
    if (s + 1 === state.cutoff && state.cutoff < toy.n_modes && !state.fan) {
      ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(F.fx(cx), F.fy(cy), 6, 0, Math.PI * 2); ctx.stroke();
      text(ctx, `Y_${state.cutoff}`, F.fx(cx) + 9, F.fy(cy) - 7, { fill: INK });
    }
  }

  const cls = toy.classes[toy.labels[n]].name;
  el('chain-sub').innerHTML = `Point ${n}, from the ${cls} group of the input. ` +
    'The last arrow lands on it.';
  const kept = partial(n, state.cutoff), full = partial(n, toy.n_modes);
  const err = Math.hypot(full[0] - kept[0], full[1] - kept[1]);
  el('chain-note').textContent = state.cutoff < toy.n_modes
    ? `Stopping after ${state.cutoff} mode${state.cutoff > 1 ? 's' : ''} leaves this point ` +
      `${fmt(err, 2)} away from where the full product puts it, which is the per-point ` +
      'version of the reconstruction error.'
    : (state.mode >= 0
      ? `Mode ${state.mode + 1} moves this point by ${fmt(Math.abs(U(n, state.mode)) * pNorm(state.mode), 2)}, ` +
        `which is |u| = ${fmt(Math.abs(U(n, state.mode)), 3)} times ‖p‖ = ${fmt(pNorm(state.mode), 1)}.`
      : 'All eight arrows laid end to end reach the point exactly. Drag the slider to cut the chain short.');
  text(ctx, state.fan ? 'all eight from the origin' : 'end to end from the origin', 6, h - 6,
    { fill: FAINT });
}

function pointBarGeom(w, h) {
  const left = 42, right = 14;
  return { left, right, bw: (w - left - right) / toy.n_modes, topA: 40, hA: (h - 110) / 2, gap: 52 };
}

function drawPointBars() {
  const cv = el('pointbars');
  const { ctx, w, h } = fit(cv);
  const g = pointBarGeom(w, h);
  const n = activePoint();
  const lim = maxAbsU();
  let dmax = 1e-9;
  if (n >= 0) for (let s = 0; s < toy.n_modes; s++) dmax = Math.max(dmax, Math.abs(U(n, s)) * pNorm(s));

  const midA = g.topA + g.hA / 2;
  const topB = g.topA + g.hA + g.gap, hB = g.hA;

  text(ctx, 'u_n,s   participation  (L1)', 6, 16, { fill: MUTED });
  text(ctx, '‖u_n,s · p_s‖   displacement  (L2)', 6, topB - 12, { fill: MUTED });

  ctx.strokeStyle = RULE; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(g.left, midA); ctx.lineTo(w - g.right, midA);
  ctx.moveTo(g.left, topB + hB); ctx.lineTo(w - g.right, topB + hB); ctx.stroke();

  if (n < 0) {
    text(ctx, 'no point selected', g.left, midA + 16, { fill: FAINT });
    return;
  }

  for (let s = 0; s < toy.n_modes; s++) {
    const x = g.left + s * g.bw, bw = g.bw * 0.66, xo = x + (g.bw - bw) / 2;
    ctx.globalAlpha = state.mode < 0 || state.mode === s ? 1 : 0.22;

    const uh = (U(n, s) / lim) * (g.hA / 2);
    ctx.fillStyle = divColor(U(n, s), lim);
    ctx.fillRect(xo, uh >= 0 ? midA - uh : midA, bw, Math.abs(uh));
    ctx.strokeStyle = 'rgba(30,48,45,.35)'; ctx.lineWidth = 0.7;
    ctx.strokeRect(xo, uh >= 0 ? midA - uh : midA, bw, Math.abs(uh));

    const d = Math.abs(U(n, s)) * pNorm(s), dh = (d / dmax) * hB;
    ctx.fillStyle = MODE_COLOR[s];
    ctx.fillRect(xo, topB + hB - dh, bw, dh);

    text(ctx, String(s + 1), x + g.bw / 2, h - 26,
      { align: 'center', fill: state.mode === s ? INK : FAINT });
    ctx.globalAlpha = 1;
    if (s >= state.cutoff) {
      /* two rects, so the panel titles between them stay legible */
      ctx.fillStyle = 'rgba(255,255,255,.66)';
      ctx.fillRect(x, g.topA - 6, g.bw, g.hA + 12);
      ctx.fillRect(x, topB - 6, g.bw, hB + 12);
    }
  }
  text(ctx, 'mode', (g.left + w - g.right) / 2, h - 10, { align: 'center', fill: FAINT });
  text(ctx, '0', g.left - 5, midA + 3, { align: 'right', fill: FAINT });
  text(ctx, '0', g.left - 5, topB + hB + 3, { align: 'right', fill: FAINT });
}

/* ================================================================== wiring */

function renderAll() {
  drawEquation();
  drawGraph();
  drawUMatrix();
  drawUMatrixLabel();
  drawPArrows();
  drawPBars();
  drawChain();
  drawPointBars();
}

function setMode(s) {
  if (s === state.mode) return;
  state.mode = s;
  el('mode-note').textContent = modeNote(s);
  renderAll();
}

function setPoint(n) {
  if (n === state.point) return;
  state.point = n;
  renderAll();
}

function nearest(pts, F, x, y, r) {
  let best = -1, bd = r * r;
  pts.forEach((p, i) => {
    const dx = F.fx(p[0]) - x, dy = F.fy(p[1]) - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function wire() {
  /* toy switch */
  const sw = el('toy-switch');
  sw.innerHTML = toys.map((t) =>
    `<button data-k="${t.key}" class="${t.key === state.toyKey ? 'on' : ''}">` +
    `${t.key === 'ring' ? 'example 2' : 'example 1'}</button>`).join('');
  sw.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    selectToy(b.dataset.k);
  }));

  /* graph: hover a point */
  const gcv = el('graph');
  gcv.addEventListener('mousemove', (e) => {
    const [x, y] = local(gcv, e);
    const { w, h } = gcv._logical;
    const F = frameOf(toy.X, { x: 0, y: 0, w, h: h - 22 }, 26);
    setPoint(nearest(toy.X, F, x, y, 13));
  });
  gcv.addEventListener('mouseleave', () => setPoint(-1));

  /* U matrix: hover a cell */
  const ucv = el('umat');
  ucv.addEventListener('mousemove', (e) => {
    const [x, y] = local(ucv, e);
    const { w, h } = ucv._logical;
    const g = umatGeom(w, h);
    const s = Math.floor((x - g.left) / g.cw);
    const r = Math.floor((y - g.top) / g.rh);
    setMode(s >= 0 && s < toy.n_modes ? s : -1);
    setPoint(r >= 0 && r < toy.n_points ? order[r] : -1);
  });
  ucv.addEventListener('mouseleave', () => { setMode(-1); setPoint(-1); });

  /* P bars and arrows: hover a mode */
  const pb = el('pbars');
  pb.addEventListener('mousemove', (e) => {
    const [, y] = local(pb, e);
    const { w, h } = pb._logical;
    const g = pbarGeom(w, h);
    const s = Math.floor((y - g.top) / g.rh);
    setMode(s >= 0 && s < toy.n_modes ? s : -1);
  });
  pb.addEventListener('mouseleave', () => setMode(-1));

  /* chain: hover / pin a point */
  const ccv = el('chain');
  ccv.addEventListener('mousemove', (e) => {
    const [x, y] = local(ccv, e);
    const { w, h } = ccv._logical;
    const F = frameOf(toy.Y, { x: 0, y: 0, w, h: h - 20 }, 30, [[0, 0]]);
    setPoint(nearest(toy.Y, F, x, y, 14));
  });
  ccv.addEventListener('mouseleave', () => setPoint(-1));
  ccv.addEventListener('click', (e) => {
    const [x, y] = local(ccv, e);
    const { w, h } = ccv._logical;
    const F = frameOf(toy.Y, { x: 0, y: 0, w, h: h - 20 }, 30, [[0, 0]]);
    const n = nearest(toy.Y, F, x, y, 14);
    state.pinned = n >= 0 && n !== state.pinned ? n : -1;
    el('clear-pin').hidden = state.pinned < 0;
    renderAll();
  });
  el('clear-pin').addEventListener('click', () => {
    state.pinned = -1; el('clear-pin').hidden = true; renderAll();
  });

  /* point bars: hover a mode */
  const bcv = el('pointbars');
  bcv.addEventListener('mousemove', (e) => {
    const [x] = local(bcv, e);
    const { w, h } = bcv._logical;
    const g = pointBarGeom(w, h);
    const s = Math.floor((x - g.left) / g.bw);
    setMode(s >= 0 && s < toy.n_modes ? s : -1);
  });
  bcv.addEventListener('mouseleave', () => setMode(-1));

  /* chain tools */
  el('mode-chain').addEventListener('click', () => {
    state.fan = false;
    el('mode-chain').classList.add('on'); el('mode-fan').classList.remove('on');
    renderAll();
  });
  el('mode-fan').addEventListener('click', () => {
    state.fan = true;
    el('mode-fan').classList.add('on'); el('mode-chain').classList.remove('on');
    renderAll();
  });
  const cut = el('cutoff');
  cut.addEventListener('input', () => {
    state.cutoff = +cut.value;
    el('cutoff-out').textContent = cut.value;
    renderAll();
  });

  window.addEventListener('resize', renderAll);
}

function selectToy(key) {
  toy = toys.find((t) => t.key === key);
  state.toyKey = key;
  state.mode = -1; state.point = -1; state.pinned = -1;
  state.cutoff = toy.n_modes;
  el('cutoff').max = toy.n_modes;
  el('cutoff').value = toy.n_modes;
  el('cutoff-out').textContent = toy.n_modes;
  el('clear-pin').hidden = true;

  order = toy.labels
    .map((l, n) => [l, n])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((p) => p[1]);

  document.querySelectorAll('#toy-switch button').forEach((b) =>
    b.classList.toggle('on', b.dataset.k === key));
  el('mode-note').textContent = modeNote(-1);

  /* name the closest pair of eigenvalues this toy actually has */
  let worst = 0, gap = Infinity;
  for (let s = 0; s + 1 < toy.n_modes; s++) {
    const g = toy.eigenvalues[s + 1] - toy.eigenvalues[s];
    if (g < gap) { gap = g; worst = s; }
  }
  el('degen-note').innerHTML =
    `Modes ${worst + 1} and ${worst + 2} here sit at ` +
    `${fmt(toy.eigenvalues[worst], 3)} and ${fmt(toy.eigenvalues[worst + 1], 3)}, ` +
    'so what either one carries on its own comes down to numerical accident ' +
    'rather than to anything in the data. Only the pair together is determined.';

  el('toy-note').textContent = toy.key === 'ring'
    ? `Example 2. ${toy.n_points} points on a ring, with no clusters at all.`
    : `Example 1. ${toy.n_points} points in two groups of two, so the graph has ` +
      'structure at two scales.';
  showGloss(null);
  renderAll();
}

fetch(TOY_URL)
  .then((r) => r.json())
  .then((d) => {
    toys = d.toys;
    wire();
    selectToy('blobs');
  })
  .catch((e) => {
    el('eq-gloss').innerHTML =
      `<p>Could not load <code>${TOY_URL}</code>. Serve the directory over ` +
      'HTTP rather than opening the file directly.</p>';
    console.error(e);
  });
