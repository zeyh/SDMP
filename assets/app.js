/* Spectral progressive viewer -- plain ES2017, no modules, no dependencies.
 *
 * Everything is read from static files under data/: one meta.json per run and
 * flat little-endian binaries beside it. The one identity the page leans on is
 *
 *     ||u_{n,s} p_s||_2 = |u_{n,s}| * ||p_s||_2
 *
 * so the points x modes displacement heatmap of any stage is one exported
 * |U| scaled column-wise by that stage's response vector, computed here rather
 * than exported ten times over.
 */
'use strict';

/* ------------------------------------------------------------------ utils */
var DATA = 'data';

function el(id) { return document.getElementById(id); }

function fetchJSON(url) {
  return fetch(url, { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    return r.json();
  });
}

function fetchBin(url, Ctor) {
  return fetch(url, { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (buf) { return new Ctor(buf); });
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* Significant-digit formatting that keeps integers intact: toPrecision turns
   10 into "1.0e+1" at two digits, and stripping its trailing zeros turns it
   into "1" -- both wrong on a decade-marked colour bar. */
function fmt(v, digits) {
  if (!isFinite(v)) return '--';
  if (v === 0) return '0';
  var a = Math.abs(v), d = digits === undefined ? 3 : digits;
  if (a >= 1e5 || a < 1e-3) return v.toExponential(Math.max(1, d - 1));
  var places = Math.max(0, d - 1 - Math.floor(Math.log10(a)));
  var s = v.toFixed(places);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function fmtPct(v) {
  if (!(v > 0)) return '0%';
  if (v < 1e-4) return (v * 100).toExponential(1) + '%';
  return (v * 100).toFixed(v < 0.01 ? 3 : (v < 0.1 ? 2 : 1)) + '%';
}

/* ------------------------------------------------------------- colormaps */
/* Fallback BrBG stops, used only if the export ran without matplotlib. */
var BRBG_FALLBACK = [
  '#543005', '#7f4909', '#a6611a', '#c68a3f', '#dfc27d', '#efdeb0', '#f6e8c3',
  '#f5f5f5', '#c7e9e2', '#80cdc1', '#43a89c', '#139c8d', '#01665e', '#003c30'
];

function lutFromHex(hexes) {
  var n = hexes.length, out = new Uint8Array(n * 3);
  for (var i = 0; i < n; i++) {
    var h = hexes[i];
    out[3 * i] = parseInt(h.substr(1, 2), 16);
    out[3 * i + 1] = parseInt(h.substr(3, 2), 16);
    out[3 * i + 2] = parseInt(h.substr(5, 2), 16);
  }
  return out;
}

function lutResample(stops, count, lo, hi) {
  var src = lutFromHex(stops), n = stops.length, out = new Uint8Array(count * 3);
  for (var i = 0; i < count; i++) {
    var u = lo + (hi - lo) * (count === 1 ? 0 : i / (count - 1));
    var x = u * (n - 1), i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), f = x - i0;
    for (var c = 0; c < 3; c++) {
      out[3 * i + c] = Math.round(src[3 * i0 + c] * (1 - f) + src[3 * i1 + c] * f);
    }
  }
  return out;
}

var CMAP = { seq: null, div: null };

function initColormaps(maps) {
  CMAP.seq = (maps && maps.seq) ? lutFromHex(maps.seq) : lutResample(BRBG_FALLBACK, 256, 0.5, 1.0);
  CMAP.div = (maps && maps.div) ? lutFromHex(maps.div) : lutResample(BRBG_FALLBACK, 256, 0.0, 1.0);
}

function lutColor(lut, t) {
  var n = lut.length / 3;
  var i = clamp(Math.round(t * (n - 1)), 0, n - 1);
  return 'rgb(' + lut[3 * i] + ',' + lut[3 * i + 1] + ',' + lut[3 * i + 2] + ')';
}

/* ------------------------------------------------------------------ norms */
function linNorm(vmax) {
  var m = vmax > 0 ? vmax : 1;
  return { kind: 'lin', vmin: 0, vmax: m, t: function (v) { return clamp(v / m, 0, 1); } };
}

function logNorm(vmax, decades) {
  var hi = vmax > 0 ? vmax : 1;
  var lo = hi / Math.pow(10, decades);
  var a = Math.log10(lo), b = Math.log10(hi);
  return {
    kind: 'log', vmin: lo, vmax: hi, decades: decades,
    t: function (v) { return v > 0 ? clamp((Math.log10(v) - a) / (b - a), 0, 1) : 0; }
  };
}

/* matplotlib SymLogNorm(linthresh, linscale=1, base=10) over [-L, L]. */
function symLogNorm(limit, decades) {
  var L = limit > 0 ? limit : 1;
  var thresh = L / Math.pow(10, decades);
  var adj = 1 / (1 - 1 / 10);              // linscale / (1 - base**-1)
  function tr(x) {
    var s = x < 0 ? -1 : 1, a = Math.abs(x);
    return a > thresh ? s * thresh * (adj + Math.log10(a / thresh)) : x * adj;
  }
  var lo = tr(-L), hi = tr(L);
  return {
    kind: 'symlog', vmin: -L, vmax: L, linthresh: thresh, decades: decades,
    t: function (v) { return clamp((tr(v) - lo) / (hi - lo), 0, 1); }
  };
}

/* ------------------------------------------------------- canvas plumbing */
function setupCanvas(canvas, cssW, cssH) {
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return ctx;
}

var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
var INK = '#111827', SUBINK = '#4b5563', FAINT = '#6b7280';
var BORDER = '#d8dee7', ACCENT = '#0f766e';

function label(ctx, text, x, y, opts) {
  opts = opts || {};
  ctx.save();
  ctx.fillStyle = opts.color || SUBINK;
  ctx.font = (opts.weight || '400') + ' ' + (opts.size || 10) + 'px ' + (opts.mono ? MONO : FONT);
  ctx.textAlign = opts.align || 'left';
  ctx.textBaseline = opts.baseline || 'alphabetic';
  if (opts.rotate) {
    ctx.translate(x, y);
    ctx.rotate(opts.rotate);
    ctx.fillText(text, 0, 0);
  } else {
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

/* One image buffer reused by every heatmap, so stepping stages allocates nothing. */
var scratch = document.createElement('canvas');
var scratchCtx = scratch.getContext('2d');

function blitHeatmap(ctx, rect, cols, rows, fill, smooth) {
  if (cols <= 0 || rows <= 0) return;
  if (scratch.width !== cols || scratch.height !== rows) {
    scratch.width = cols;
    scratch.height = rows;
  }
  var img = scratchCtx.createImageData(cols, rows);
  fill(img.data);
  scratchCtx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = !!smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scratch, 0, 0, cols, rows, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1);
}

/* Mode-axis ticks: whichever of 1/2/5/10/... keeps labels ~36 px apart. */
var TICK_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

function modeTicks(count, pixels) {
  var room = Math.max(2, Math.floor(pixels / 36));
  for (var i = 0; i < TICK_STEPS.length; i++) {
    if (count / TICK_STEPS[i] <= room) {
      var step = TICK_STEPS[i], out = [];
      for (var m = step; m <= count; m += step) out.push(m);
      if (out[0] !== 1) out.unshift(1);
      return out;
    }
  }
  return [1, count];
}

function drawModeAxis(ctx, rect, count, title) {
  var ticks = modeTicks(count, rect.w);
  ctx.save();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  for (var i = 0; i < ticks.length; i++) {
    var x = rect.x + (ticks[i] - 0.5) / count * rect.w;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, rect.y + rect.h);
    ctx.lineTo(Math.round(x) + 0.5, rect.y + rect.h + 3);
    ctx.stroke();
    label(ctx, String(ticks[i]), x, rect.y + rect.h + 13, { align: 'center', size: 9.5, mono: true, color: FAINT });
  }
  ctx.restore();
  if (title) {
    label(ctx, title, rect.x + rect.w / 2, rect.y + rect.h + 28, { align: 'center', size: 10.5, color: SUBINK });
  }
}

function colorbar(ctx, x, y, w, h, lut, norm, title, formatter) {
  var steps = 128;
  for (var i = 0; i < steps; i++) {
    var t = 1 - i / (steps - 1);
    ctx.fillStyle = lutColor(lut, t);
    ctx.fillRect(x, y + i * (h / steps), w, h / steps + 1);
  }
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);

  var fm = formatter || function (v) { return fmt(v, 2); };
  var marks = [];
  if (norm.kind === 'log') {
    var hiE = Math.log10(norm.vmax), loE = Math.log10(norm.vmin);
    for (var e = Math.ceil(loE); e <= Math.floor(hiE); e++) marks.push(Math.pow(10, e));
    if (marks.length < 2) marks = [norm.vmin, norm.vmax];
  } else if (norm.kind === 'symlog') {
    marks = [norm.vmin, -norm.linthresh, 0, norm.linthresh, norm.vmax];
  } else {
    marks = [0, norm.vmax / 2, norm.vmax];
  }
  for (var k = 0; k < marks.length; k++) {
    var v = marks[k], ty = y + (1 - norm.t(v)) * h;
    ctx.strokeStyle = BORDER;
    ctx.beginPath();
    ctx.moveTo(x + w, Math.round(ty) + 0.5);
    ctx.lineTo(x + w + 3, Math.round(ty) + 0.5);
    ctx.stroke();
    label(ctx, fm(v), x + w + 5, ty + 3, { size: 9, mono: true, color: FAINT });
  }
  if (title) {
    label(ctx, title, x - 5, y + h / 2, {
      align: 'center', size: 10, color: SUBINK, rotate: -Math.PI / 2
    });
  }
}

/* Row labels in a left gutter, thinned so they cannot collide. */
function gutterLabels(ctx, rect, blocks, minPitch, opts) {
  var last = -Infinity, drawn = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var y = rect.y + ((b.start + b.stop) / 2) / blocks.total * rect.h;
    if (y - last >= minPitch) {
      label(ctx, b.name, rect.x - 6, y + 3, {
        align: 'right', size: (opts && opts.size) || 9, color: (opts && opts.color) || SUBINK
      });
      last = y;
      drawn.push(i);
    }
  }
  return drawn;
}

/* --------------------------------------------------------------- loading */
var index = null;
var ds = null;              // { meta, schemes, eig, absU, snap, resp, coeff, share }
var cache = {};

/* A colour scheme is one way of colouring the points: a categorical one over
   the run's own labels, and for C. elegans a second, continuous one over
   embryo time.  Each carries its own heatmap row order -- grouping rows by
   class says nothing about a continuous quantity, where sorting by the value is
   what makes the row axis readable -- so the row index is a property of the
   scheme and not of the dataset. */
function buildScheme(spec, order, values, nPoints) {
  var s = {
    key: spec.key, label: spec.label, kind: spec.kind,
    order: order, values: values,
    classes: spec.classes || null,
    unit: spec.unit || '', note: spec.note || '',
    vmin: spec.vmin, vmax: spec.vmax,
    missingColor: spec.missing_color || '#c7ccd4'
  };
  s.rowOf = new Uint32Array(nPoints);
  for (var r = 0; r < nPoints; r++) s.rowOf[order[r]] = r;

  if (s.kind === 'continuous') {
    /* The exported stops are viridis at ten samples, the same list
       figures/plot_svg.py interpolates for its "coloured by embryo time" row.
       Resampled to 256 here so a point lands on a colour without a per-point
       interpolation. */
    s.lut = rampHex(spec.stops, 256);
    var span = s.vmax - s.vmin;
    s.colorOf = function (point) {
      var v = values[point];
      if (!isFinite(v)) return s.missingColor;
      var a = span > 0 ? (v - s.vmin) / span : 1;
      return s.lut[clamp(Math.round(a * 255), 0, 255)];
    };
    s.textOf = function (point) {
      var v = values[point];
      if (!isFinite(v)) return 'no value';
      return fmt(v, 4) + (s.unit ? ' ' + s.unit : '');
    };
  } else {
    s.colorOf = function (point) { return s.classes[values[point]].color; };
    s.textOf = function (point) { return s.classes[values[point]].name; };
  }
  return s;
}

/* Interpolate a short list of hex stops into `count` hex colours. */
function rampHex(stops, count) {
  var rgb = stops.map(hexToRGB), out = [];
  for (var i = 0; i < count; i++) {
    var a = (count === 1) ? 0 : i / (count - 1);
    var pos = a * (rgb.length - 1);
    var lo = Math.min(Math.floor(pos), rgb.length - 2), f = pos - lo;
    var c = [0, 0, 0];
    for (var j = 0; j < 3; j++) {
      c[j] = Math.round(rgb[lo][j] + f * (rgb[lo + 1][j] - rgb[lo][j]));
    }
    out.push('#' + c.map(function (v) {
      return ('0' + clamp(v, 0, 255).toString(16)).slice(-2);
    }).join(''));
  }
  return out;
}

function hexToRGB(hex) {
  var h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function loadDataset(key) {
  if (cache[key]) return Promise.resolve(cache[key]);
  var base = DATA + '/' + key + '/';
  return fetchJSON(base + 'meta.json').then(function (meta) {
    var specs = meta.schemes || [];
    var jobs = [
      fetchBin(base + 'eigenvalues.bin', Float32Array),
      fetchBin(base + 'absU.bin', Float32Array),
      fetchBin(base + 'snapshots.bin', Float32Array),
      fetchBin(base + 'response.bin', Float32Array),
      fetchBin(base + 'coeff.bin', Float32Array)
    ];
    specs.forEach(function (spec) {
      jobs.push(fetchBin(base + spec.order_file, Uint32Array));
      jobs.push(fetchBin(base + spec.value_file,
        spec.kind === 'continuous' ? Float32Array : Uint16Array));
    });
    return Promise.all(jobs).then(function (parts) {
      var meta2 = meta;
      var out = {
        meta: meta2,
        eig: parts[0], absU: parts[1], snap: parts[2],
        resp: parts[3], coeff: parts[4],
        schemes: specs.map(function (spec, i) {
          return buildScheme(spec, parts[5 + 2 * i], parts[6 + 2 * i], meta2.n_points);
        })
      };

      /* Parseval share per stage, normalized over the full exported spectrum. */
      var T = meta2.n_stages, S = meta2.n_modes_total;
      out.share = new Float32Array(T * S);
      for (var s = 0; s < T; s++) {
        var total = 0, o = s * S, i;
        for (i = 0; i < S; i++) { var v = out.resp[o + i]; total += v * v; }
        if (total > 0) for (i = 0; i < S; i++) {
          var w = out.resp[o + i];
          out.share[o + i] = (w * w) / total;
        }
      }
      out.shareMax = 0;
      for (var j = 0; j < out.share.length; j++) {
        if (out.share[j] > out.shareMax) out.shareMax = out.share[j];
      }
      cache[key] = out;
      return out;
    });
  });
}

/* ----------------------------------------------------------------- state */
var state = {
  key: null,
  scheme: null,        // active colour scheme key, null = the run's default
  frame: 0,            // fractional while tweening
  tab: 'up',
  modes: 50,
  localKind: 'up',     // 'up' | 'u'
  scale: 'shared',     // 'shared' | 'stage'
  playing: false,
  tween: false,
  speed: 800,
  hover: -1,
  pinned: -1,
  solo: -1
};

/* The active colour scheme, falling back to the run's default. Everything that
   draws a point or a heatmap row goes through this rather than reading labels
   off the dataset, so adding a scheme does not mean touching the panels. */
function sch() {
  var list = ds.schemes;
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === state.scheme) return list[i];
  }
  return list[0];
}

function stageIndex() { return clamp(Math.round(state.frame), 0, ds.meta.n_stages - 1); }
function stageMeta() { return ds.meta.stages[stageIndex()]; }

function responseRow(s) {
  var S = ds.meta.n_modes_total;
  return ds.resp.subarray(s * S, (s + 1) * S);
}

function shareRow(s) {
  var S = ds.meta.n_modes_total;
  return ds.share.subarray(s * S, (s + 1) * S);
}

function coeffRow(s) {
  var M = ds.meta.n_modes;
  return ds.coeff.subarray(s * M * 2, (s + 1) * M * 2);
}

function snapshotRow(s) {
  var N = ds.meta.n_points;
  return ds.snap.subarray(s * N * 2, (s + 1) * N * 2);
}

function upNorm() {
  var limit = state.scale === 'stage' ? stageMeta().up_limit : ds.meta.limits.up;
  return logNorm(limit, 3);
}

function participationNorm() { return linNorm(ds.meta.limits.participation); }

function localNorm() {
  return state.localKind === 'u' ? participationNorm() : upNorm();
}

/* --------------------------------------------------------- viewer links */
function writeViewerState() {
  var parts = [state.key, 's' + (stageIndex() + 1), state.tab, 'm' + state.modes];
  if (ds && ds.schemes.length > 1) parts.push('c' + sch().key);
  if (state.pinned >= 0) parts.push('p' + state.pinned);
  var url = new URL(location.href);
  var value = parts.join('/');
  if (url.searchParams.get('view') === value) return;
  url.searchParams.set('view', value);
  if (url.hash.slice(1).split('/')[0] === state.key) url.hash = '#viewer';
  history.replaceState(null, '', url);
}

function readViewerState() {
  var raw = new URLSearchParams(location.search).get('view') || location.hash.slice(1);
  if (!raw) return null;
  var parts = raw.split('/'), out = { key: parts[0] };
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i];
    if (/^s\d+$/.test(p)) out.stage = parseInt(p.slice(1), 10) - 1;
    else if (/^m\d+$/.test(p)) out.modes = parseInt(p.slice(1), 10);
    else if (/^p\d+$/.test(p)) out.pinned = parseInt(p.slice(1), 10);
    else if (p === 'up' || p === 'response' || p === 'coeff') out.tab = p;
    /* After the tab, or "coeff" would read as the scheme "oeff". */
    else if (/^c[a-z0-9_]+$/.test(p)) out.scheme = p.slice(1);
  }
  return out;
}

/* --------------------------------------------------------------- scatter */
var snapBox = null;        // plot rect, for hit-testing
var snapGrid = null;       // { cell, cols, rows, bins } over normalized coords
var snapFrame = null;      // Float32Array(2N) normalized coordinates of the drawn frame

function normalizedFrame() {
  var N = ds.meta.n_points, T = ds.meta.n_stages;
  if (!snapFrame || snapFrame.length !== 2 * N) snapFrame = new Float32Array(2 * N);
  var f = clamp(state.frame, 0, T - 1);
  var i0 = Math.floor(f), i1 = Math.min(T - 1, i0 + 1), t = f - i0;
  var a = snapshotRow(i0), b = snapshotRow(i1);
  var ba = ds.meta.stages[i0].bounds, bb = ds.meta.stages[i1].bounds;
  var wa = ba[2] - ba[0], ha = ba[3] - ba[1], wb = bb[2] - bb[0], hb = bb[3] - bb[1];
  for (var i = 0; i < N; i++) {
    var xa = (a[2 * i] - ba[0]) / wa, ya = (a[2 * i + 1] - ba[1]) / ha;
    if (t > 0) {
      var xb = (b[2 * i] - bb[0]) / wb, yb = (b[2 * i + 1] - bb[1]) / hb;
      xa += (xb - xa) * t;
      ya += (yb - ya) * t;
    }
    snapFrame[2 * i] = xa;
    snapFrame[2 * i + 1] = 1 - ya;      // canvas y grows downward
  }
  return snapFrame;
}

function buildGrid(frame) {
  var N = ds.meta.n_points, cols = 48, rows = 48;
  var bins = new Array(cols * rows);
  for (var i = 0; i < N; i++) {
    var cx = clamp(Math.floor(frame[2 * i] * cols), 0, cols - 1);
    var cy = clamp(Math.floor(frame[2 * i + 1] * rows), 0, rows - 1);
    var k = cy * cols + cx;
    if (!bins[k]) bins[k] = [];
    bins[k].push(i);
  }
  snapGrid = { cols: cols, rows: rows, bins: bins };
}

function nearestPoint(u, v, radius) {
  if (!snapGrid || !snapFrame) return -1;
  var cols = snapGrid.cols, rows = snapGrid.rows;
  var cx = clamp(Math.floor(u * cols), 0, cols - 1);
  var cy = clamp(Math.floor(v * rows), 0, rows - 1);
  var span = Math.max(1, Math.ceil(radius * cols));
  var best = -1, bestD = radius * radius;
  for (var gy = Math.max(0, cy - span); gy <= Math.min(rows - 1, cy + span); gy++) {
    for (var gx = Math.max(0, cx - span); gx <= Math.min(cols - 1, cx + span); gx++) {
      var bin = snapGrid.bins[gy * cols + gx];
      if (!bin) continue;
      for (var j = 0; j < bin.length; j++) {
        var i = bin[j];
        if (state.solo >= 0 && sch().values[i] !== state.solo) continue;
        var dx = snapFrame[2 * i] - u, dy = snapFrame[2 * i + 1] - v;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
  }
  return best;
}

function drawSnapshot() {
  var host = el('snap-host');
  var size = clamp(host.clientWidth || 480, 240, 620);
  var ctx = setupCanvas(el('snap'), size, size);
  var pad = 1;
  var rect = { x: pad, y: pad, w: size - 2 * pad, h: size - 2 * pad };
  snapBox = rect;

  ctx.fillStyle = '#fff';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  var frame = normalizedFrame();
  buildGrid(frame);

  var N = ds.meta.n_points, scheme = sch();
  var r = N > 3000 ? 1.9 : 2.6;
  var inset = 8;

  function px(i) { return rect.x + inset + frame[2 * i] * (rect.w - 2 * inset); }
  function py(i) { return rect.y + inset + frame[2 * i + 1] * (rect.h - 2 * inset); }

  /* Dimmed points first, so an isolated class is drawn on top of its context. */
  if (state.solo >= 0) {
    ctx.fillStyle = 'rgba(17,24,39,0.07)';
    for (var i = 0; i < N; i++) {
      if (scheme.values[i] === state.solo) continue;
      ctx.beginPath();
      ctx.arc(px(i), py(i), r, 0, 6.2832);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 0.82;
  if (scheme.kind === 'categorical') {
    /* One fillStyle per class rather than per point: setting it 5,000 times
       costs more than the arcs do. */
    for (var c = 0; c < scheme.classes.length; c++) {
      if (state.solo >= 0 && c !== state.solo) continue;
      ctx.fillStyle = scheme.classes[c].color;
      for (var k = 0; k < N; k++) {
        if (scheme.values[k] !== c) continue;
        ctx.beginPath();
        ctx.arc(px(k), py(k), r, 0, 6.2832);
        ctx.fill();
      }
    }
  } else {
    /* In the scheme's row order, so the latest cells land on top of the
       earliest where the layout stacks them -- the same reason the
       progressive table draws its time row in time order. */
    var ord = scheme.order;
    for (var q = 0; q < N; q++) {
      var pt = ord[q];
      ctx.fillStyle = scheme.colorOf(pt);
      ctx.beginPath();
      ctx.arc(px(pt), py(pt), r, 0, 6.2832);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  function ring(i, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(px(i), py(i), r + 3.5, 0, 6.2832);
    ctx.stroke();
  }
  if (state.pinned >= 0) ring(state.pinned, INK, 2);
  if (state.hover >= 0 && state.hover !== state.pinned) ring(state.hover, ACCENT, 1.6);

  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1);

  var sm = stageMeta();
  label(ctx, 'K = ' + sm.k.toLocaleString(),
    rect.x + 9, rect.y + 17, { size: 10.5, mono: true, color: SUBINK });
}

/* Gutters: a narrow canvas cannot give 182 px to labels and a colour bar and
   still have a heatmap left, so they shrink with it. */
function gutters(W, extraRight) {
  var narrow = W < 540;
  return { L: narrow ? 58 : 96, R: (narrow ? 52 : 86) + (extraRight || 0) };
}

/* ------------------------------------------------------------- UP / U tab */
var panelBox = null;       // { kind, rect, cols, rows, extra }

/* For a continuous scheme: the row colours as a strip beside the heatmap, with
   a few value ticks.  Rows run from the lowest value to the highest, so this
   is the same colour ramp the legend shows, read down the panel. */
function valueGutter(ctx, rect, scheme, L) {
  var N = scheme.order.length, strip = 7, x = rect.x - strip - 3;
  for (var y = 0; y < Math.round(rect.h); y++) {
    var row = clamp(Math.floor(y / rect.h * N), 0, N - 1);
    ctx.fillStyle = scheme.colorOf(scheme.order[row]);
    ctx.fillRect(x, rect.y + y, strip, 1);
  }
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, rect.y - 0.5, strip + 1, rect.h + 1);

  var count = clamp(Math.floor(rect.h / 42), 2, 7), seen = [];
  for (var i = 0; i < count; i++) {
    var a = count === 1 ? 0 : i / (count - 1);
    var r2 = clamp(Math.round(a * (N - 1)), 0, N - 1);
    var v = scheme.values[scheme.order[r2]];
    var text = isFinite(v) ? fmt(v, 4) : '--';
    if (seen.indexOf(text) >= 0) continue;
    seen.push(text);
    label(ctx, text, x - 5, rect.y + a * rect.h + 3,
      { align: 'right', size: 9, mono: true, color: SUBINK });
  }
  if (scheme.unit) {
    label(ctx, scheme.unit, x - 5, rect.y + rect.h + 13,
      { align: 'right', size: 8.5, mono: true, color: FAINT });
  }
}

function drawLocalPanel(ctx, W, H) {
  var meta = ds.meta, N = meta.n_points, M = state.modes;
  var g = gutters(W), L = g.L, R = g.R, T = 10, B = 42;
  var rect = { x: L, y: T, w: W - L - R, h: H - T - B };
  var kind = state.localKind;
  var norm = localNorm();
  var lut = CMAP.seq;
  var resp = responseRow(stageIndex());
  var absU = ds.absU, stride = meta.n_modes;
  var scheme = sch(), order = scheme.order;

  blitHeatmap(ctx, rect, M, N, function (out) {
    var o = 0;
    for (var row = 0; row < N; row++) {
      /* absU is exported in point order; the row order belongs to the colour
         scheme, so the permutation costs one lookup per row, not per texel. */
      var base = order[row] * stride;
      for (var s = 0; s < M; s++) {
        var v = absU[base + s];
        if (kind === 'up') v *= resp[s];
        var t = norm.t(v);
        var i = clamp(Math.round(t * 255), 0, 255) * 3;
        out[o++] = lut[i];
        out[o++] = lut[i + 1];
        out[o++] = lut[i + 2];
        out[o++] = 255;
      }
    }
  }, true);

  if (scheme.kind === 'categorical') {
    /* Class blocks: white rules and a thinned name column. */
    var blocks = scheme.classes.map(function (c) {
      return { name: c.name, start: c.row_start, stop: c.row_stop };
    });
    blocks.total = N;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    for (var b = 0; b < blocks.length - 1; b++) {
      var y = rect.y + blocks[b].stop / N * rect.h;
      ctx.beginPath();
      ctx.moveTo(rect.x, Math.round(y) + 0.5);
      ctx.lineTo(rect.x + rect.w, Math.round(y) + 0.5);
      ctx.stroke();
    }
    ctx.restore();
    gutterLabels(ctx, rect, blocks, 11);
  } else {
    /* No blocks to rule off: the rows are sorted by the value, so the row axis
       is the value axis.  A strip of the point colours against it is what ties
       a band of rows here to a region of the snapshot. */
    valueGutter(ctx, rect, scheme, L);
  }
  label(ctx, scheme.label, L - 6, rect.y - 2, { align: 'right', size: 9.5, color: FAINT });

  /* The marked point's row, the link between this panel and the snapshot. */
  function mark(point, color, width) {
    var row = scheme.rowOf[point];
    var y = rect.y + (row + 0.5) / N * rect.h;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.w, y);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(rect.x - 1, y);
    ctx.lineTo(rect.x - 7, y - 3.5);
    ctx.lineTo(rect.x - 7, y + 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  if (state.pinned >= 0) mark(state.pinned, 'rgba(17,24,39,0.85)', 1.4);
  if (state.hover >= 0 && state.hover !== state.pinned) mark(state.hover, ACCENT, 1.2);

  drawModeAxis(ctx, rect, M, 'mode s →');
  colorbar(ctx, W - R + 16, rect.y, 11, rect.h, lut, norm,
    kind === 'up' ? '‖uₙₛ pₛ‖' : '|uₙₛ|');

  panelBox = { kind: 'local', rect: rect, cols: M, rows: N, norm: norm };
}

/* ------------------------------------------------------- response tab */
function drawResponsePanel(ctx, W, H) {
  var meta = ds.meta, T = meta.n_stages, M = state.modes, S = meta.n_modes_total;
  var g = gutters(W), L = g.L, R = g.R, TOP = 10, GAP = 46;
  var hHeat = Math.min(26 * T, Math.round((H - TOP - GAP - 44) * 0.56));
  var rect = { x: L, y: TOP, w: W - L - R, h: hHeat };
  var norm = logNorm(ds.shareMax, 4);
  var lut = CMAP.seq;

  blitHeatmap(ctx, rect, M, T, function (out) {
    var o = 0;
    for (var s = 0; s < T; s++) {
      var row = s * S;
      for (var m = 0; m < M; m++) {
        var t = norm.t(ds.share[row + m]);
        var i = clamp(Math.round(t * 255), 0, 255) * 3;
        out[o++] = lut[i];
        out[o++] = lut[i + 1];
        out[o++] = lut[i + 2];
        out[o++] = 255;
      }
    }
  }, false);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  for (var r = 1; r < T; r++) {
    var y = rect.y + r / T * rect.h;
    ctx.beginPath();
    ctx.moveTo(rect.x, Math.round(y) + 0.5);
    ctx.lineTo(rect.x + rect.w, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.restore();

  var cur = stageIndex();
  for (var s2 = 0; s2 < T; s2++) {
    var y2 = rect.y + (s2 + 0.5) / T * rect.h;
    var pitch = rect.h / T;
    if (pitch >= 10 || s2 === cur || s2 === 0 || s2 === T - 1) {
      label(ctx, 'K = ' + meta.stages[s2].k.toLocaleString(), L - 6, y2 + 3, {
        align: 'right', size: 9, mono: true,
        color: s2 === cur ? INK : FAINT, weight: s2 === cur ? '700' : '400'
      });
    }
  }
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(rect.x - 0.8, rect.y + cur / T * rect.h - 0.8, rect.w + 1.6, rect.h / T + 1.6);
  ctx.restore();

  colorbar(ctx, W - R + 16, rect.y, 11, rect.h, lut, norm, 'energy share πₛ',
    function (v) { return fmtPct(v); });

  /* The selected stage's share as a curve, on the same mode axis. */
  var cTop = rect.y + rect.h + GAP - 16;
  var crect = { x: L, y: cTop, w: rect.w, h: H - cTop - 44 };
  if (crect.h > 40) {
    var row2 = shareRow(cur);
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(crect.x, crect.y, crect.w, crect.h);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(crect.x - 0.5, crect.y - 0.5, crect.w + 1, crect.h + 1);

    var hi = Math.log10(ds.shareMax), lo = hi - 4;
    function yOf(v) {
      var t = v > 0 ? clamp((Math.log10(v) - lo) / (hi - lo), 0, 1) : 0;
      return crect.y + (1 - t) * crect.h;
    }
    for (var e = Math.ceil(lo); e <= Math.floor(hi); e++) {
      var gy = yOf(Math.pow(10, e));
      ctx.strokeStyle = '#eef1f5';
      ctx.beginPath();
      ctx.moveTo(crect.x, Math.round(gy) + 0.5);
      ctx.lineTo(crect.x + crect.w, Math.round(gy) + 0.5);
      ctx.stroke();
      label(ctx, fmtPct(Math.pow(10, e)), crect.x - 6, gy + 3,
        { align: 'right', size: 8.5, mono: true, color: FAINT });
    }
    ctx.beginPath();
    for (var m2 = 0; m2 < M; m2++) {
      var x = crect.x + (m2 + 0.5) / M * crect.w;
      var y3 = yOf(row2[m2]);
      if (m2 === 0) ctx.moveTo(x, y3); else ctx.lineTo(x, y3);
    }
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();
    drawModeAxis(ctx, crect, M, 'mode s →');
    label(ctx, 'πₛ at K = ' + meta.stages[cur].k.toLocaleString(),
      crect.x + 8, crect.y + 13, { size: 10, mono: true, color: SUBINK });
    panelBox = { kind: 'response', rect: rect, cols: M, rows: T, norm: norm, curve: crect };
  } else {
    drawModeAxis(ctx, rect, M, 'mode s →');
    panelBox = { kind: 'response', rect: rect, cols: M, rows: T, norm: norm };
  }
}

/* ------------------------------------------------------------- P tab */
var PX_COLOR = '#01665e', PY_COLOR = '#8c510a';

function drawCoeffPanel(ctx, W, H) {
  var meta = ds.meta, M = state.modes;
  var g = gutters(W), L = g.L, R = g.R, TOP = 10;
  var rowH = 26, gap = 34;
  var rect = { x: L, y: TOP, w: W - L - R, h: 2 * rowH };
  var norm = symLogNorm(meta.limits.coeff, 2);
  var lut = CMAP.div;
  var cur = stageIndex();
  var P = coeffRow(cur);

  blitHeatmap(ctx, rect, M, 2, function (out) {
    var o = 0;
    for (var comp = 0; comp < 2; comp++) {
      for (var s = 0; s < M; s++) {
        var t = norm.t(P[2 * s + comp]);
        var i = clamp(Math.round(t * 255), 0, 255) * 3;
        out[o++] = lut[i];
        out[o++] = lut[i + 1];
        out[o++] = lut[i + 2];
        out[o++] = 255;
      }
    }
  }, false);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(rect.x, rect.y + rowH + 0.5);
  ctx.lineTo(rect.x + rect.w, rect.y + rowH + 0.5);
  ctx.stroke();
  ctx.restore();
  label(ctx, 'pₛ,ₓ', L - 6, rect.y + rowH * 0.5 + 3.5, { align: 'right', size: 10, mono: true });
  label(ctx, 'pₛ,ᵧ', L - 6, rect.y + rowH * 1.5 + 3.5, { align: 'right', size: 10, mono: true });
  // The bar is taller than the two-row strip it describes: five symlog marks
  // (+/-limit, +/-linthresh, 0) cannot be labelled inside 52 px.
  colorbar(ctx, W - R + 16, rect.y, 11, rect.h + gap - 8, lut, norm, '');

  /* The same numbers as bars: the heatmap says sign and order of magnitude,
     the bars say how much of the layout a mode actually carries. */
  var bTop = rect.y + rect.h + gap;
  var brect = { x: L, y: bTop, w: rect.w, h: H - bTop - 44 };
  var limit = meta.limits.coeff * 1.05;
  var clipped = 0, s2;
  for (s2 = 0; s2 < M; s2++) {
    if (Math.abs(P[2 * s2]) > limit || Math.abs(P[2 * s2 + 1]) > limit) clipped++;
  }
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(brect.x, brect.y, brect.w, brect.h);
  ctx.strokeStyle = BORDER;
  ctx.strokeRect(brect.x - 0.5, brect.y - 0.5, brect.w + 1, brect.h + 1);
  var mid = brect.y + brect.h / 2;
  function yOf(v) { return mid - clamp(v / limit, -1, 1) * (brect.h / 2 - 2); }
  var gridVals = [-limit, -limit / 2, 0, limit / 2, limit];
  for (var gi = 0; gi < gridVals.length; gi++) {
    var gy = yOf(gridVals[gi]);
    ctx.strokeStyle = gi === 2 ? '#c6ced9' : '#eef1f5';
    ctx.beginPath();
    ctx.moveTo(brect.x, Math.round(gy) + 0.5);
    ctx.lineTo(brect.x + brect.w, Math.round(gy) + 0.5);
    ctx.stroke();
    label(ctx, fmt(gridVals[gi], 2), brect.x - 6, gy + 3,
      { align: 'right', size: 8.5, mono: true, color: FAINT });
  }
  var colW = brect.w / M, bw = Math.max(1, Math.min(7, colW * 0.38));
  for (s2 = 0; s2 < M; s2++) {
    var cx = brect.x + (s2 + 0.5) * colW;
    ctx.fillStyle = PX_COLOR;
    var y0 = yOf(P[2 * s2]);
    ctx.fillRect(cx - bw - 0.5, Math.min(mid, y0), bw, Math.abs(y0 - mid) || 0.8);
    ctx.fillStyle = PY_COLOR;
    var y1 = yOf(P[2 * s2 + 1]);
    ctx.fillRect(cx + 0.5, Math.min(mid, y1), bw, Math.abs(y1 - mid) || 0.8);
  }
  ctx.restore();

  label(ctx, 'pₛ,ₓ', brect.x + 9, brect.y + 13, { size: 10, mono: true, color: PX_COLOR, weight: '700' });
  label(ctx, 'pₛ,ᵧ', brect.x + 48, brect.y + 13, { size: 10, mono: true, color: PY_COLOR, weight: '700' });
  label(ctx, 'K = ' + meta.stages[cur].k.toLocaleString() +
    (clipped ? '  ·  ' + clipped + ' mode' + (clipped > 1 ? 's' : '') + ' clipped' : ''),
    brect.x + brect.w - 8, brect.y + 13, { align: 'right', size: 9.5, mono: true, color: FAINT });

  drawModeAxis(ctx, brect, M, 'mode s →');
  panelBox = { kind: 'coeff', rect: rect, cols: M, rows: 2, norm: norm, bars: brect };
}

function drawPanel() {
  var host = el('panel-host');
  var W = Math.max(360, host.clientWidth || 720);
  var H = state.tab === 'up' ? clamp(Math.round(W * 0.62), 380, 560) : 440;
  var ctx = setupCanvas(el('panel'), W, H);
  if (state.tab === 'up') drawLocalPanel(ctx, W, H);
  else if (state.tab === 'response') drawResponsePanel(ctx, W, H);
  else drawCoeffPanel(ctx, W, H);
}

/* ------------------------------------------------------ point spectrum */
var pointBox = null;

function activePoint() {
  return state.hover >= 0 ? state.hover : state.pinned;
}

function drawPointPanel() {
  var point = activePoint();
  var head = el('point-head'), host = el('point-host'), empty = el('point-empty');
  if (point < 0) {
    head.hidden = true;
    host.hidden = true;
    empty.hidden = false;
    el('point-note').textContent = '';
    pointBox = null;
    return;
  }
  empty.hidden = true;
  head.hidden = false;
  host.hidden = false;

  var meta = ds.meta, M = state.modes, stride = meta.n_modes;
  var scheme = sch();
  var cur = stageIndex(), row = scheme.rowOf[point];
  var resp = responseRow(cur);
  var snapshot = snapshotRow(cur);

  var top = [];
  for (var s = 0; s < M; s++) top.push([s, ds.absU[point * stride + s] * resp[s]]);
  top.sort(function (a, b) { return b[1] - a[1]; });
  var topText = top.slice(0, 3).map(function (e) {
    return 's=' + (e[0] + 1) + ' (' + fmt(e[1], 2) + ')';
  }).join(', ');

  el('point-note').textContent = '— at K = ' + meta.stages[cur].k.toLocaleString();
  head.innerHTML =
    '<span class="who"><span class="swatch" style="background:' +
    scheme.colorOf(point) + '"></span>' +
    escapeHTML(scheme.label + ' · ' + scheme.textOf(point)) + '</span>' +
    '<span class="meta">point ' + point + ' · y = (' +
    fmt(snapshot[2 * point], 3) + ', ' + fmt(snapshot[2 * point + 1], 3) + ') · row ' + row + '</span>' +
    '<span class="meta">strongest modes: ' + escapeHTML(topText) + '</span>' +
    (point === state.pinned ? '<span class="pinned" title="Click the background to release">pinned</span>' : '');

  var W = Math.max(360, el('point-host').clientWidth || 720);
  var H = 250;
  var ctx = setupCanvas(el('point'), W, H);
  var g = gutters(W, 12), L = g.L, R = g.R, TOP = 12, rowH = 22, gap = 12;

  var upNormHere = upNorm(), partNorm = participationNorm();
  var strips = [
    { name: '|uₙₛ|', norm: partNorm, get: function (s) { return ds.absU[point * stride + s]; } },
    { name: '‖uₙₛ pₛ‖', norm: upNormHere, get: function (s) { return ds.absU[point * stride + s] * resp[s]; } }
  ];
  var y = TOP;
  for (var k = 0; k < strips.length; k++) {
    var strip = strips[k], rect = { x: L, y: y, w: W - L - R, h: rowH };
    (function (strip, rect) {
      blitHeatmap(ctx, rect, M, 1, function (out) {
        var o = 0;
        for (var s2 = 0; s2 < M; s2++) {
          var t = strip.norm.t(strip.get(s2));
          var i = clamp(Math.round(t * 255), 0, 255) * 3;
          out[o++] = CMAP.seq[i];
          out[o++] = CMAP.seq[i + 1];
          out[o++] = CMAP.seq[i + 2];
          out[o++] = 255;
        }
      }, false);
    })(strip, rect);
    label(ctx, strip.name, L - 6, y + rowH / 2 + 4, { align: 'right', size: 10.5, mono: true, color: INK });
    label(ctx, strip.norm.kind === 'lin'
      ? 'lin 0–' + fmt(strip.norm.vmax, 2)
      : 'log ' + fmt(strip.norm.vmin, 1) + '–' + fmt(strip.norm.vmax, 2),
      W - R + 8, y + rowH / 2 + 4, { size: 8.5, mono: true, color: FAINT });
    y += rowH + gap;
  }

  /* Bars: the same displacement row, so a colour can be read as a number. */
  var brect = { x: L, y: y + 6, w: W - L - R, h: H - (y + 6) - 44 };
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(brect.x, brect.y, brect.w, brect.h);
  ctx.strokeStyle = BORDER;
  ctx.strokeRect(brect.x - 0.5, brect.y - 0.5, brect.w + 1, brect.h + 1);
  var hi = Math.log10(upNormHere.vmax), lo = Math.log10(upNormHere.vmin);
  function yOf(v) {
    var t = v > 0 ? clamp((Math.log10(v) - lo) / (hi - lo), 0, 1) : 0;
    return brect.y + (1 - t) * brect.h;
  }
  for (var e = Math.ceil(lo); e <= Math.floor(hi); e++) {
    var gy = yOf(Math.pow(10, e));
    ctx.strokeStyle = '#eef1f5';
    ctx.beginPath();
    ctx.moveTo(brect.x, Math.round(gy) + 0.5);
    ctx.lineTo(brect.x + brect.w, Math.round(gy) + 0.5);
    ctx.stroke();
    label(ctx, fmt(Math.pow(10, e), 1), brect.x - 6, gy + 3,
      { align: 'right', size: 8.5, mono: true, color: FAINT });
  }
  var colW = brect.w / M, bw = Math.max(1, Math.min(9, colW * 0.74));
  for (var s3 = 0; s3 < M; s3++) {
    var v = ds.absU[point * stride + s3] * resp[s3];
    if (!(v > 0)) continue;
    var yv = yOf(v);
    ctx.fillStyle = lutColor(CMAP.seq, upNormHere.t(v));
    ctx.fillRect(brect.x + (s3 + 0.5) * colW - bw / 2, yv, bw, brect.y + brect.h - yv);
  }
  ctx.restore();
  label(ctx, '‖uₙₛ pₛ‖  (log)', brect.x + 8, brect.y + 13,
    { size: 10, mono: true, color: SUBINK });
  drawModeAxis(ctx, brect, M, 'mode s →');

  pointBox = { strips: strips, rowH: rowH, gap: gap, top: TOP, L: L, R: R, W: W, bars: brect, point: point, row: row, cur: cur };
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ---------------------------------------------------------------- chrome */
function renderPlayer() {
  var meta = ds.meta, cur = stageIndex(), sm = meta.stages[cur];
  var slider = el('stage');
  slider.max = String(meta.n_stages - 1);
  if (!state.tween || !state.playing) slider.value = String(cur);
  el('stage-readout').innerHTML =
    'K <b>' + sm.k.toLocaleString() + '</b>/' + meta.n_modes_total.toLocaleString() +
    '  ·  <b>' + sm.stage + '</b>/' + meta.n_stages;

  var ticks = el('stage-ticks');
  if (ticks.childElementCount !== meta.n_stages) {
    ticks.innerHTML = '';
    meta.stages.forEach(function (st, i) {
      var span = document.createElement('span');
      span.textContent = st.k >= 1000 ? Math.round(st.k / 1000) + 'k' : String(st.k);
      span.title = 'stage ' + st.stage + ', K = ' + st.k;
      span.addEventListener('click', function () { setFrame(i); stopPlaying(); });
      ticks.appendChild(span);
    });
  }
  for (var i = 0; i < ticks.children.length; i++) {
    ticks.children[i].className = i === cur ? 'cur' : '';
  }
  el('play').innerHTML = state.playing ? '&#9646;&#9646;' : '&#9654;';
  el('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  el('snap-note').textContent = '— ' + ds.meta.n_points.toLocaleString() + ' points';
}

function renderTabTools() {
  var tools = el('tab-tools'), meta = ds.meta;
  tools.innerHTML = '';

  if (state.tab === 'up') {
    var g1 = document.createElement('div');
    g1.className = 'modes';
    g1.innerHTML = '<span>quantity</span>';
    [['up', '‖uₙₛ pₛ‖ (U·P)'], ['u', '|uₙₛ| (U)']].forEach(function (opt) {
      var b = document.createElement('button');
      b.className = 'mini';
      b.textContent = opt[1];
      b.setAttribute('aria-pressed', String(state.localKind === opt[0]));
      b.addEventListener('click', function () { state.localKind = opt[0]; render(); });
      g1.appendChild(b);
    });
    tools.appendChild(g1);

    if (state.localKind === 'up') {
      var g2 = document.createElement('div');
      g2.className = 'modes';
      g2.innerHTML = '<span>color scale</span>';
      [['shared', 'shared'], ['stage', 'per stage']].forEach(function (opt) {
        var b = document.createElement('button');
        b.className = 'mini';
        b.textContent = opt[1];
        b.title = opt[0] === 'shared'
          ? 'One log scale for every stage, so frames are comparable. The layout shrinks as K grows, so late stages are darker.'
          : 'Rescale to this stage’s own 99.5th percentile.';
        b.setAttribute('aria-pressed', String(state.scale === opt[0]));
        b.addEventListener('click', function () { state.scale = opt[0]; render(); });
        g2.appendChild(b);
      });
      tools.appendChild(g2);
    }
  }

  var g3 = document.createElement('div');
  g3.className = 'modes';
  var span = document.createElement('span');
  span.innerHTML = 'modes <code>' + state.modes + '</code>/' + meta.n_modes;
  var slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '8';
  slider.max = String(meta.n_modes);
  slider.step = '1';
  slider.value = String(state.modes);
  slider.setAttribute('aria-label', 'Modes shown');
  slider.addEventListener('input', function () {
    state.modes = clamp(parseInt(slider.value, 10) || 8, 8, meta.n_modes);
    span.innerHTML = 'modes <code>' + state.modes + '</code>/' + meta.n_modes;
    drawPanel();
    drawPointPanel();
    writeViewerState();
  });
  g3.appendChild(span);
  g3.appendChild(slider);
  tools.appendChild(g3);

  var dl = document.createElement('button');
  dl.className = 'mini';
  dl.textContent = 'PNG';
  dl.title = 'Download this panel';
  dl.addEventListener('click', function () {
    var a = document.createElement('a');
    a.download = ds.meta.key + '_' + state.tab + '_K' + stageMeta().k + '.png';
    a.href = el('panel').toDataURL('image/png');
    a.click();
  });
  tools.appendChild(dl);

}

function renderLegend() {
  var host = el('legend');
  var scheme = sch();
  host.innerHTML = '';
  host.className = 'legend' + (scheme.kind === 'continuous' ? ' ramp' : '');

  if (scheme.kind === 'continuous') {
    /* A ramp has no entries to click, so it shows the scale instead: the same
       stops the points are coloured from, with the ends labelled. */
    var bar = document.createElement('div');
    bar.className = 'rampbar';
    bar.style.background = 'linear-gradient(to right,' + scheme.lut.join(',') + ')';
    var row = document.createElement('div');
    row.className = 'rampwrap';
    row.innerHTML =
      '<span class="end">' + escapeHTML(fmt(scheme.vmin, 4)) + '</span>';
    row.appendChild(bar);
    var tail = document.createElement('span');
    tail.className = 'end';
    tail.textContent = fmt(scheme.vmax, 4) + (scheme.unit ? ' ' + scheme.unit : '');
    row.appendChild(tail);
    host.appendChild(row);
    return;
  }

  scheme.classes.forEach(function (c, i) {
    var item = document.createElement('div');
    item.className = 'item' + (state.solo >= 0 ? (state.solo === i ? ' solo' : ' dim') : '');
    item.innerHTML = '<span class="swatch" style="background:' + c.color + '"></span>' +
      '<span>' + escapeHTML(c.name) + '</span><span class="count">' + c.count + '</span>';
    item.title = 'Click to isolate this ' + scheme.label;
    item.addEventListener('click', function () {
      state.solo = state.solo === i ? -1 : i;
      renderLegend();
      drawSnapshot();
    });
    host.appendChild(item);
  });
}

/* The "color by" control, shown only where a run has more than one scheme. */
function renderSchemePicker() {
  var field = el('scheme-field'), picker = el('scheme');
  if (!ds || ds.schemes.length < 2) { field.hidden = true; return; }
  field.hidden = false;
  if (picker.dataset.key !== ds.meta.key) {
    picker.innerHTML = '';
    ds.schemes.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = s.label;
      picker.appendChild(opt);
    });
    picker.dataset.key = ds.meta.key;
  }
  picker.value = sch().key;
}

function render(updateUrl) {
  renderPlayer();
  renderTabTools();
  renderSchemePicker();
  renderLegend();
  drawSnapshot();
  drawPanel();
  drawPointPanel();
  if (updateUrl !== false) writeViewerState();
}

/* --------------------------------------------------------------- readouts */
function showReadout(node, host, x, y, text) {
  node.textContent = text;
  node.classList.add('show');
  var w = node.offsetWidth, h = node.offsetHeight;
  var left = x + 14, topPos = y - h - 10;
  if (left + w > host.clientWidth) left = x - w - 14;
  if (topPos < 0) topPos = y + 16;
  node.style.left = Math.max(0, left) + 'px';
  node.style.top = topPos + 'px';
}

function hideReadout(node) { node.classList.remove('show'); }

/* ------------------------------------------------------------- playback */
/* Two clocks on purpose. Stepping stage by stage is not frame-synced
   animation, and requestAnimationFrame stops in a tab the compositor thinks is
   not on screen -- which includes a preview pane behind another window, where
   the player would simply freeze. A timer keeps that case working. Tweening
   *is* animation, so it takes the frame clock. */
var raf = 0, timer = 0, lastTick = 0, lastDrawnStage = -1;

function showFrame(redrawPanels) {
  drawSnapshot();
  renderPlayer();
  if (redrawPanels) {
    lastDrawnStage = stageIndex();
    drawPanel();
    drawPointPanel();
  }
}

function tweenTick(now) {
  if (!state.playing || !state.tween) return;
  if (!lastTick) lastTick = now;
  var dt = now - lastTick;
  lastTick = now;
  var T = ds.meta.n_stages;
  state.frame += dt / state.speed;
  if (state.frame >= T - 1 + 0.001) state.frame = 0;
  showFrame(stageIndex() !== lastDrawnStage);
  raf = requestAnimationFrame(tweenTick);
}

function stepTick() {
  if (!state.playing || state.tween) return;
  state.frame = (stageIndex() + 1) % ds.meta.n_stages;
  showFrame(true);
  timer = setTimeout(stepTick, state.speed);
}

function startPlaying() {
  if (state.playing) return;
  state.playing = true;
  lastTick = 0;
  lastDrawnStage = stageIndex();
  renderPlayer();
  if (state.tween) raf = requestAnimationFrame(tweenTick);
  else timer = setTimeout(stepTick, state.speed);
}

function stopPlaying() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(raf);
  clearTimeout(timer);
  state.frame = stageIndex();
  renderPlayer();
  drawSnapshot();
  writeViewerState();
}

function restartPlaying() {
  if (!state.playing) return;
  cancelAnimationFrame(raf);
  clearTimeout(timer);
  state.playing = false;
  startPlaying();
}

function setFrame(value) {
  state.frame = clamp(value, 0, ds.meta.n_stages - 1);
  lastDrawnStage = stageIndex();
  renderPlayer();
  drawSnapshot();
  drawPanel();
  drawPointPanel();
  writeViewerState();
}

/* ------------------------------------------------------------------ wire */
function wireSnapshot() {
  var canvas = el('snap'), host = el('snap-host'), readout = el('snap-readout');

  canvas.addEventListener('mousemove', function (e) {
    if (!snapBox) return;
    var inset = 8;
    var u = (e.offsetX - snapBox.x - inset) / (snapBox.w - 2 * inset);
    var v = (e.offsetY - snapBox.y - inset) / (snapBox.h - 2 * inset);
    var found = nearestPoint(u, v, 0.022);
    if (found !== state.hover) {
      state.hover = found;
      drawSnapshot();
      drawPanel();
      drawPointPanel();
    }
    if (found >= 0) {
      var snapshot = snapshotRow(stageIndex());
      showReadout(readout, host, e.offsetX, e.offsetY,
        sch().textOf(found) + '\npoint ' + found +
        '\n(' + fmt(snapshot[2 * found], 3) + ', ' + fmt(snapshot[2 * found + 1], 3) + ')');
    } else {
      hideReadout(readout);
    }
  });

  canvas.addEventListener('mouseleave', function () {
    hideReadout(readout);
    if (state.hover >= 0) {
      state.hover = -1;
      drawSnapshot();
      drawPanel();
      drawPointPanel();
    }
  });

  canvas.addEventListener('click', function () {
    state.pinned = state.hover >= 0 ? state.hover : -1;
    drawSnapshot();
    drawPanel();
    drawPointPanel();
    writeViewerState();
  });
}

function wirePanel() {
  var canvas = el('panel'), host = el('panel-host'), readout = el('panel-readout');

  canvas.addEventListener('mousemove', function (e) {
    if (!panelBox) { hideReadout(readout); return; }
    var box = panelBox, rect = box.rect;
    var inside = e.offsetX >= rect.x && e.offsetX <= rect.x + rect.w &&
      e.offsetY >= rect.y && e.offsetY <= rect.y + rect.h;
    var curveRect = box.curve || box.bars;
    var inCurve = curveRect && e.offsetX >= curveRect.x && e.offsetX <= curveRect.x + curveRect.w &&
      e.offsetY >= curveRect.y && e.offsetY <= curveRect.y + curveRect.h;
    if (!inside && !inCurve) { hideReadout(readout); return; }

    var ref = inside ? rect : curveRect;
    var mode = clamp(Math.floor((e.offsetX - ref.x) / ref.w * box.cols), 0, box.cols - 1);
    var lam = ds.eig[mode];
    var lines = ['mode s = ' + (mode + 1), 'λ = ' + fmt(lam, 4)];

    if (box.kind === 'local') {
      var row = clamp(Math.floor((e.offsetY - rect.y) / rect.h * box.rows), 0, box.rows - 1);
      var point = sch().order[row];
      var stride = ds.meta.n_modes;
      var u = ds.absU[point * stride + mode];
      var r = responseRow(stageIndex())[mode];
      lines.push('point ' + point + '  (' + sch().textOf(point) + ')');
      lines.push('|u| = ' + fmt(u, 3));
      lines.push('‖p‖ = ' + fmt(r, 3));
      lines.push('‖u p‖ = ' + fmt(u * r, 3));
    } else if (box.kind === 'response') {
      var st = inside
        ? clamp(Math.floor((e.offsetY - rect.y) / rect.h * box.rows), 0, box.rows - 1)
        : stageIndex();
      lines.push('K = ' + ds.meta.stages[st].k.toLocaleString());
      lines.push('πₛ = ' + fmtPct(shareRow(st)[mode]));
      lines.push('‖pₛ‖ = ' + fmt(responseRow(st)[mode], 3));
    } else {
      var P = coeffRow(stageIndex());
      lines.push('pₛ,ₓ = ' + fmt(P[2 * mode], 3));
      lines.push('pₛ,ᵧ = ' + fmt(P[2 * mode + 1], 3));
      lines.push('‖pₛ‖ = ' + fmt(responseRow(stageIndex())[mode], 3));
    }
    showReadout(readout, host, e.offsetX, e.offsetY, lines.join('\n'));
  });

  canvas.addEventListener('mouseleave', function () { hideReadout(readout); });

  /* Clicking a row of the U.P panel pins that point, the reverse of hovering
     the snapshot: the heatmap is also a way in. */
  canvas.addEventListener('click', function (e) {
    if (!panelBox) return;
    if (panelBox.kind === 'local') {
      var rect = panelBox.rect;
      if (e.offsetY < rect.y || e.offsetY > rect.y + rect.h) return;
      var row = clamp(Math.floor((e.offsetY - rect.y) / rect.h * panelBox.rows), 0, panelBox.rows - 1);
      state.pinned = sch().order[row];
      drawSnapshot();
      drawPanel();
      drawPointPanel();
      writeViewerState();
    } else if (panelBox.kind === 'response') {
      var r2 = panelBox.rect;
      if (e.offsetY < r2.y || e.offsetY > r2.y + r2.h) return;
      setFrame(clamp(Math.floor((e.offsetY - r2.y) / r2.h * panelBox.rows), 0, panelBox.rows - 1));
      stopPlaying();
    }
  });
}

function wirePointPanel() {
  var canvas = el('point'), host = el('point-host'), readout = el('point-readout');
  canvas.addEventListener('mousemove', function (e) {
    if (!pointBox) { hideReadout(readout); return; }
    var b = pointBox;
    var w = b.W - b.L - b.R;
    if (e.offsetX < b.L || e.offsetX > b.L + w) { hideReadout(readout); return; }
    var mode = clamp(Math.floor((e.offsetX - b.L) / w * state.modes), 0, state.modes - 1);
    var stride = ds.meta.n_modes;
    var u = ds.absU[b.point * stride + mode];
    var r = responseRow(b.cur)[mode];
    showReadout(readout, host, e.offsetX, e.offsetY,
      'mode s = ' + (mode + 1) + '\nλ = ' + fmt(ds.eig[mode], 4) +
      '\n|u| = ' + fmt(u, 3) + '\n‖p‖ = ' + fmt(r, 3) +
      '\n‖u p‖ = ' + fmt(u * r, 3));
  });
  canvas.addEventListener('mouseleave', function () { hideReadout(readout); });
}

function wireControls() {
  el('play').addEventListener('click', function () {
    if (state.playing) stopPlaying(); else startPlaying();
  });
  el('prev').addEventListener('click', function () { stopPlaying(); setFrame(stageIndex() - 1); });
  el('next').addEventListener('click', function () { stopPlaying(); setFrame(stageIndex() + 1); });
  el('stage').addEventListener('input', function () {
    stopPlaying();
    setFrame(parseInt(el('stage').value, 10) || 0);
  });
  el('speed').addEventListener('change', function () {
    state.speed = parseInt(el('speed').value, 10) || 800;
    restartPlaying();
  });
  el('tween').addEventListener('click', function () {
    state.tween = !state.tween;
    el('tween').setAttribute('aria-pressed', String(state.tween));
    if (state.playing) restartPlaying();
    else setFrame(stageIndex());
  });

  ['up', 'response', 'coeff'].forEach(function (tab) {
    el('tab-' + tab).addEventListener('click', function () {
      state.tab = tab;
      ['up', 'response', 'coeff'].forEach(function (t) {
        el('tab-' + t).setAttribute('aria-selected', String(t === tab));
      });
      renderTabTools();
      drawPanel();
      writeViewerState();
    });
  });

  el('dataset').addEventListener('change', function () {
    selectDataset(el('dataset').value);
  });

  el('scheme').addEventListener('change', function () {
    state.scheme = el('scheme').value;
    /* The isolated class is an index into the old scheme's class list, and the
       row order has changed under the panels, so both go back to neutral. */
    state.solo = -1;
    render();
  });

  el('viewer').addEventListener('keydown', function (e) {
    if (!ds || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') {
      if (e.target.closest('button, a')) return;
      e.preventDefault();
      if (state.playing) stopPlaying(); else startPlaying();
    } else if (e.key === 'ArrowRight') {
      stopPlaying();
      setFrame(stageIndex() + 1);
    } else if (e.key === 'ArrowLeft') {
      stopPlaying();
      setFrame(stageIndex() - 1);
    } else if (e.key === 'Escape') {
      state.pinned = -1;
      state.solo = -1;
      render();
    }
  });

  var pending = 0;
  window.addEventListener('resize', function () {
    clearTimeout(pending);
    pending = setTimeout(function () {
      if (!ds) return;
      drawSnapshot();
      drawPanel();
      drawPointPanel();
    }, 120);
  });
}

/* ------------------------------------------------------------------ boot */
function selectDataset(key, opts) {
  opts = opts || {};
  el('status').hidden = false;
  el('status').className = 'status';
  el('status').textContent = 'Loading ' + key + '…';
  stopPlaying();
  return loadDataset(key).then(function (loaded) {
    ds = loaded;
    state.key = key;
    state.hover = -1;
    state.pinned = (opts.pinned !== undefined && opts.pinned < ds.meta.n_points) ? opts.pinned : -1;
    state.solo = -1;
    var wanted = opts.scheme || null;
    state.scheme = null;
    for (var i = 0; i < ds.schemes.length; i++) {
      if (ds.schemes[i].key === wanted) state.scheme = wanted;
    }
    state.modes = clamp(opts.modes || Math.min(50, ds.meta.n_modes), 8, ds.meta.n_modes);
    state.frame = clamp(opts.stage !== undefined ? opts.stage : ds.meta.n_stages - 1,
      0, ds.meta.n_stages - 1);
    el('dataset').value = key;
    el('status').hidden = true;
    el('main').hidden = false;
    render(opts.updateUrl);
  }).catch(function (err) {
    el('status').className = 'status error';
    el('status').textContent = 'Could not load ' + key + ': ' + err.message;
    throw err;
  });
}

function boot() {
  fetchJSON(DATA + '/index.json').then(function (idx) {
    index = idx;
    initColormaps(idx.colormaps);
    var select = el('dataset');
    idx.datasets.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.key;
      opt.textContent = d.title + '  (' + d.n_points.toLocaleString() + ' pts, ' +
        d.n_stages + ' stages)';
      select.appendChild(opt);
    });
    var options = readViewerState();
    var keys = idx.datasets.map(function (d) { return d.key; });
    if (options && keys.indexOf(options.key) < 0) options = null;
    var start = options ? options.key : keys[0];
    wireControls();
    wireSnapshot();
    wirePanel();
    wirePointPanel();
    if (options && options.tab) {
      state.tab = options.tab;
      ['up', 'response', 'coeff'].forEach(function (t) {
        el('tab-' + t).setAttribute('aria-selected', String(t === state.tab));
      });
    }
    var legacyLink = options && !new URLSearchParams(location.search).has('view');
    return selectDataset(start, options || { updateUrl: false }).then(function () {
      if (legacyLink) el('viewer').scrollIntoView();
    });
  }).catch(function (err) {
    el('status').className = 'status error';
    el('status').textContent = 'Could not load data/index.json: ' + err.message +
      '  —  the page needs to be served over HTTP (GitHub Pages, or `python -m http.server`).';
    console.error(err);
  });
}

boot();
