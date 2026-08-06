/**
 * The /visual-ontologies dashboard, as one self-contained HTML document (inline CSS + JS,
 * no external assets — the droplet serves it without a CDN). The page fetches the live
 * `ontology.rdf` and parses the RDF/XML client-side with DOMParser, so what it draws is
 * exactly the persisted datasource, reified timestamps included.
 *
 * Two views over the same parsed graph:
 *   Graph    — force layout with collision + degree-aware forces, neighborhood focus on
 *              hover/select, screen-space label decluttering, zoom-to-cursor and fit.
 *   Timeline — time buckets (day/week/month) on x: a stacked "entities touched" column
 *              per bucket on top, then one lane per class with nodes placed at their
 *              created bucket and edges drawn as arcs, so category evolution and
 *              cross-time connections are visible.
 *
 * Visual identity: 8 validated categorical hues × two node shapes cover the 14 classes,
 * so class identity is never color-alone (shape + legend + direct labels). Light and dark
 * themes are both first-class via prefers-color-scheme.
 */
export const DASHBOARD_PAGE: string = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal Context — Ontology</title>
<style>
  :root {
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --ink-1: #0b0b0b; --ink-2: #52514e; --ink-muted: #898781;
    --hairline: #e1e0d9; --border: rgba(11,11,11,0.10);
    --c1: #2a78d6; --c2: #1baf7a; --c3: #eda100; --c4: #008300;
    --c5: #4a3aa7; --c6: #e34948; --c7: #e87ba4; --c8: #eb6834;
    --recent: #0ca30c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-muted: #898781;
      --hairline: #2c2c2a; --border: rgba(255,255,255,0.10);
      --c1: #3987e5; --c2: #199e70; --c3: #c98500; --c4: #008300;
      --c5: #9085e9; --c6: #e66767; --c7: #d55181; --c8: #d95926;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--page); color: var(--ink-1);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid var(--hairline); background: var(--surface-1); flex-wrap: wrap;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .meta { color: var(--ink-2); font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
  .meta b { color: var(--ink-1); font-weight: 600; }
  .seg { display: inline-flex; border: 1px solid var(--hairline); border-radius: 6px; overflow: hidden; flex: none; }
  .seg button {
    border: 0; background: none; color: var(--ink-2); padding: 5px 11px; font: inherit;
    font-size: 12px; cursor: pointer;
  }
  .seg button + button { border-left: 1px solid var(--hairline); }
  .seg button.on { background: var(--c1); color: #fff; }
  #views { margin-left: auto; }
  #grain { display: none; }
  #grain.show { display: inline-flex; }
  #fit {
    border: 1px solid var(--hairline); background: none; color: var(--ink-2); border-radius: 6px;
    padding: 5px 11px; font: inherit; font-size: 12px; cursor: pointer;
  }
  #search {
    padding: 6px 10px; font: inherit; color: var(--ink-1);
    background: var(--page); border: 1px solid var(--hairline); border-radius: 6px; width: 190px;
  }
  #pending-badge {
    display: none; font-size: 12px; padding: 3px 8px; border-radius: 10px; cursor: pointer;
    background: var(--c3); color: #0b0b0b; font-weight: 600;
  }
  main { flex: 1; display: flex; min-height: 0; }
  #stage { flex: 1; position: relative; min-width: 0; }
  canvas { position: absolute; inset: 0; cursor: grab; }
  #tooltip {
    position: absolute; pointer-events: none; display: none; max-width: 320px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.18); z-index: 5;
  }
  #tooltip .tt-title { font-weight: 600; }
  #tooltip .tt-sub { color: var(--ink-2); }
  #tooltip .tt-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  #tooltip .tt-row .n { margin-left: auto; font-variant-numeric: tabular-nums; }
  #legend {
    position: absolute; left: 10px; bottom: 10px; background: var(--surface-1);
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
    display: grid; grid-template-columns: repeat(2, minmax(110px, auto)); gap: 2px 12px;
    font-size: 12px; max-height: 46vh; overflow: auto;
  }
  .lg { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--ink-2); user-select: none; }
  .lg.off { opacity: .35; }
  .sw { width: 10px; height: 10px; flex: none; }
  .sw.circle { border-radius: 50%; }
  #panel {
    width: 340px; flex: none; border-left: 1px solid var(--hairline); background: var(--surface-1);
    overflow-y: auto; padding: 14px 16px; display: none;
  }
  #panel.open { display: block; }
  #panel h2 { font-size: 15px; margin: 0 0 2px; }
  #panel .cls { font-size: 12px; color: var(--ink-2); margin-bottom: 10px; }
  #panel .stamp { font-size: 11px; color: var(--ink-muted); margin-bottom: 12px; }
  #panel h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--ink-muted); margin: 14px 0 6px; font-weight: 600;
  }
  .row { padding: 6px 0; border-top: 1px solid var(--hairline); font-size: 13px; }
  .row .k { color: var(--ink-2); font-size: 12px; }
  .row .when { color: var(--ink-muted); font-size: 11px; }
  .row .edge-target { color: var(--c1); cursor: pointer; }
  #close { float: right; border: 0; background: none; color: var(--ink-2); font-size: 16px; cursor: pointer; }
  #empty {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    color: var(--ink-2); text-align: center; padding: 24px; white-space: pre-line;
  }
  #pending-list {
    display: none; position: absolute; top: 8px; right: 8px; z-index: 6; width: 380px; max-height: 60vh;
    overflow: auto; background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 12px; font-size: 12px; box-shadow: 0 6px 18px rgba(0,0,0,.2);
  }
  #pending-list h3 { margin: 0 0 6px; font-size: 12px; }
  #pending-list .pg { border-top: 1px solid var(--hairline); padding: 6px 0; }
  #pending-list .pg .p { color: var(--ink-2); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>Ontology — personal context</h1>
  <div class="meta" id="meta">loading…</div>
  <span id="pending-badge"></span>
  <div class="seg" id="views">
    <button data-v="graph" class="on">Graph</button>
    <button data-v="timeline">Timeline</button>
  </div>
  <div class="seg" id="grain">
    <button data-g="day">Day</button>
    <button data-g="week">Week</button>
    <button data-g="month">Month</button>
  </div>
  <button id="fit" title="Zoom to fit">Fit</button>
  <input id="search" type="search" placeholder="Filter nodes…" autocomplete="off">
</header>
<main>
  <div id="stage">
    <canvas id="canvas"></canvas>
    <div id="tooltip"></div>
    <div id="legend"></div>
    <div id="empty"></div>
    <div id="pending-list"></div>
  </div>
  <aside id="panel"></aside>
</main>
<script>
'use strict';
var PC = 'https://pbenavides.dev/ontology/personal-context#';
var RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
var RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
var DCT = 'http://purl.org/dc/terms/';

/* class → categorical slot (1..8) + shape; 8 validated hues × 2 shapes cover 14 classes */
var CLASS_STYLE = {
  Goal:            { slot: 1, shape: 'circle' },
  Project:         { slot: 2, shape: 'circle' },
  Milestone:       { slot: 3, shape: 'circle' },
  Habit:           { slot: 4, shape: 'circle' },
  Skill:           { slot: 5, shape: 'circle' },
  HealthCondition: { slot: 6, shape: 'circle' },
  Person:          { slot: 7, shape: 'circle' },
  Tool:            { slot: 8, shape: 'circle' },
  Decision:        { slot: 1, shape: 'square' },
  Situation:       { slot: 2, shape: 'square' },
  Event:           { slot: 3, shape: 'square' },
  Value:           { slot: 4, shape: 'square' },
  Constraint:      { slot: 5, shape: 'square' },
  FinancialItem:   { slot: 6, shape: 'square' }
};
var CLASS_ORDER = Object.keys(CLASS_STYLE);
var RECENT_MS = 72 * 3600 * 1000;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

var nodes = [], edges = [], byId = {};
var hiddenClasses = {}, searchTerm = '';
var selected = null, hovered = null;
var mode = 'graph';                      /* 'graph' | 'timeline' */
var grain = 'day';                       /* 'day' | 'week' | 'month' */
var viewG = { x: 0, y: 0, k: 1 };        /* camera per view */
var viewT = { x: 0, y: 0, k: 1 };
function view() { return mode === 'graph' ? viewG : viewT; }

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function colorOf(cls) { var s = CLASS_STYLE[cls]; return s ? css('--c' + s.slot) : css('--ink-muted'); }
function shapeOf(cls) { var s = CLASS_STYLE[cls]; return s ? s.shape : 'circle'; }
function local(iri) { return iri && iri.indexOf(PC) === 0 ? iri.slice(PC.length) : iri; }
function fmt(ts) {
  if (!ts) return '—';
  var d = new Date(ts); if (isNaN(d)) return ts;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
function ago(ts) {
  if (!ts) return '—';
  var s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isRecent(ts) { return ts && (Date.now() - new Date(ts).getTime()) < RECENT_MS; }
function parseT(ts) { var t = Date.parse(ts); return isNaN(t) ? null : t; }

function parseRdf(text) {
  var doc = new DOMParser().parseFromString(text, 'application/xml');
  var root = doc.documentElement;
  var stamps = {};
  var i, el;
  var kids = root.children;
  for (i = 0; i < kids.length; i++) {
    el = kids[i];
    if (el.namespaceURI === RDF && el.localName === 'Statement') {
      var s = '', p = '', o = '', cr = '', mo = '';
      var cs = el.children;
      for (var j = 0; j < cs.length; j++) {
        var c = cs[j], res = c.getAttributeNS(RDF, 'resource');
        if (c.localName === 'subject') s = local(res);
        else if (c.localName === 'predicate') p = local(res);
        else if (c.localName === 'object') o = res ? local(res) : c.textContent;
        else if (c.namespaceURI === DCT && c.localName === 'created') cr = c.textContent;
        else if (c.namespaceURI === DCT && c.localName === 'modified') mo = c.textContent;
      }
      stamps[s + '|' + p + '|' + o] = { created: cr, modified: mo };
    }
  }
  for (i = 0; i < kids.length; i++) {
    el = kids[i];
    if (el.namespaceURI !== PC) continue;
    var id = local(el.getAttributeNS(RDF, 'about'));
    if (!id) continue;
    var node = { id: id, cls: el.localName, label: id, attrs: [], created: '', modified: '', out: [], inc: [] };
    var ch = el.children;
    for (var k = 0; k < ch.length; k++) {
      var c2 = ch[k];
      if (c2.namespaceURI === RDFS && c2.localName === 'label') node.label = c2.textContent;
      else if (c2.namespaceURI === DCT && c2.localName === 'created') node.created = c2.textContent;
      else if (c2.namespaceURI === DCT && c2.localName === 'modified') node.modified = c2.textContent;
      else if (c2.namespaceURI === PC) {
        var res2 = c2.getAttributeNS(RDF, 'resource');
        if (res2) {
          var okey = local(res2);
          var st = stamps[id + '|' + c2.localName + '|' + okey] || {};
          edges.push({ s: id, p: c2.localName, o: okey, created: st.created || node.created, modified: st.modified || node.modified });
        } else {
          var st2 = stamps[id + '|' + c2.localName + '|' + c2.textContent] || {};
          node.attrs.push({ p: c2.localName, v: c2.textContent, created: st2.created || node.created, modified: st2.modified || node.modified });
        }
      }
    }
    nodes.push(node); byId[id] = node;
  }
  edges = edges.filter(function (e) { return byId[e.s] && byId[e.o]; });
  edges.forEach(function (e) { byId[e.s].out.push(e); byId[e.o].inc.push(e); });
  nodes.forEach(function (nd) { nd.deg = nd.out.length + nd.inc.length; });
}

function visible(nd) { return !hiddenClasses[nd.cls]; }
function matches(nd) {
  if (!searchTerm) return true;
  return (nd.label + ' ' + nd.id + ' ' + nd.cls).toLowerCase().indexOf(searchTerm) !== -1;
}
function nodeR(nd) { return 6 + Math.min(6, Math.sqrt(nd.deg) * 2); }

/* The hover/selection focus: the focused node plus its direct neighbors. */
function focusSet() {
  var f = selected || hovered;
  if (!f) return null;
  var set = {}; set[f.id] = true;
  f.out.forEach(function (e) { set[e.o] = true; });
  f.inc.forEach(function (e) { set[e.s] = true; });
  return { id: f.id, set: set };
}

/* ============================ graph force layout ============================ */
function layoutInit() {
  /* Seed each node near a per-class anchor on a ring so the simulation untangles
     into class-coherent regions instead of a random hairball. */
  var present = CLASS_ORDER.filter(function (cls) {
    return nodes.some(function (nd) { return nd.cls === cls; });
  });
  var R = Math.sqrt(nodes.length) * 55 + 80;
  var anchor = {};
  present.forEach(function (cls, i) {
    var a = (i / Math.max(1, present.length)) * Math.PI * 2;
    anchor[cls] = { x: Math.cos(a) * R, y: Math.sin(a) * R };
  });
  nodes.forEach(function (d) {
    var a = anchor[d.cls] || { x: 0, y: 0 };
    d.x = a.x + (Math.random() - 0.5) * R * 0.6;
    d.y = a.y + (Math.random() - 0.5) * R * 0.6;
    d.vx = 0; d.vy = 0;
  });
}
var alpha = 1, didFitGraph = false;
function tick() {
  if (mode !== 'graph' || alpha < 0.005) return;
  alpha *= 0.99;
  var i, j, a, b, dx, dy, d2, d, f;
  for (i = 0; i < nodes.length; i++) {
    a = nodes[i];
    for (j = i + 1; j < nodes.length; j++) {
      b = nodes[j];
      dx = b.x - a.x; dy = b.y - a.y; d2 = dx * dx + dy * dy + 60;
      /* Degree-weighted repulsion so hubs claim more room than leaves. */
      f = 2400 * Math.sqrt((a.deg + 1) * (b.deg + 1)) / d2 * alpha;
      d = Math.sqrt(d2);
      dx /= d; dy /= d;
      a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
    }
  }
  edges.forEach(function (e) {
    a = byId[e.s]; b = byId[e.o];
    dx = b.x - a.x; dy = b.y - a.y; d = Math.sqrt(dx * dx + dy * dy) || 1;
    var rest = 70 + 10 * Math.sqrt(Math.max(a.deg, b.deg));
    f = (d - rest) * 0.06 * alpha / d;
    a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
  });
  nodes.forEach(function (nd) {
    nd.vx -= nd.x * 0.006 * alpha; nd.vy -= nd.y * 0.006 * alpha;
    if (nd === dragNode) return;
    nd.vx *= 0.85; nd.vy *= 0.85; nd.x += nd.vx; nd.y += nd.vy;
  });
  /* Collision pass: no two nodes may overlap (marks stay individually readable). */
  for (i = 0; i < nodes.length; i++) {
    a = nodes[i];
    for (j = i + 1; j < nodes.length; j++) {
      b = nodes[j];
      dx = b.x - a.x; dy = b.y - a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      var min = nodeR(a) + nodeR(b) + 8;
      if (d < min) {
        var push = (min - d) / d * 0.5;
        if (a !== dragNode) { a.x -= dx * push; a.y -= dy * push; }
        if (b !== dragNode) { b.x += dx * push; b.y += dy * push; }
      }
    }
  }
}

/* ============================== timeline layout ============================= */
var TL = null;
var COL_W = 96, ACT_H = 110, AXIS_H = 26, ROW_PITCH = 22, CELL_PAD = 8, DOT_PITCH = 20;

function floorBucket(t, g) {
  var d = new Date(t);
  if (g === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (g === 'week') {
    var wd = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function nextBucket(t, g) {
  var d = new Date(t);
  if (g === 'day') return t + 86400000;
  if (g === 'week') return t + 7 * 86400000;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
function bucketLabel(t, g) {
  var d = new Date(t);
  if (g === 'month') return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  var s = MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  return g === 'week' ? 'Wk ' + s : s;
}
function autoGrain(minT, maxT) {
  var days = (maxT - minT) / 86400000;
  if (days <= 35) return 'day';
  if (days <= 220) return 'week';
  return 'month';
}

function layoutTimeline() {
  TL = null;
  var vis = nodes.filter(visible);
  var times = [];
  vis.forEach(function (nd) {
    var c = parseT(nd.created), m = parseT(nd.modified);
    if (c !== null) times.push(c);
    if (m !== null) times.push(m);
  });
  if (!vis.length || !times.length) return;
  var minT = Math.min.apply(null, times), maxT = Math.max.apply(null, times);

  /* Guard against absurd bucket counts (e.g. day grain over years). */
  var g = grain;
  while (g !== 'month') {
    var n = 0;
    for (var t0 = floorBucket(minT, g); t0 <= maxT && n <= 400; t0 = nextBucket(t0, g)) n++;
    if (n <= 400) break;
    g = g === 'day' ? 'week' : 'month';
  }

  var buckets = [], idx = {};
  for (var t = floorBucket(minT, g); t <= maxT; t = nextBucket(t, g)) {
    idx[t] = buckets.length;
    buckets.push({ t: t, label: bucketLabel(t, g) });
  }
  function bucketOf(ts) {
    var p = parseT(ts);
    return p === null ? 0 : idx[floorBucket(p, g)];
  }

  /* Lanes: one per class present among visible nodes, in legend order. */
  var lanes = [], laneIdx = {};
  CLASS_ORDER.forEach(function (cls) {
    if (vis.some(function (nd) { return nd.cls === cls; })) {
      laneIdx[cls] = lanes.length;
      lanes.push({ cls: cls, count: 0, maxRows: 1, cells: {} });
    }
  });
  var perRow = Math.max(1, Math.floor((COL_W - 2 * CELL_PAD) / DOT_PITCH));
  vis.forEach(function (nd) {
    var lane = lanes[laneIdx[nd.cls]];
    var b = bucketOf(nd.created);
    var cell = lane.cells[b] || (lane.cells[b] = []);
    cell.push(nd);
    lane.count++;
    lane.maxRows = Math.max(lane.maxRows, Math.ceil(cell.length / perRow));
  });

  /* Vertical stacking: activity band, axis band, then the lanes. */
  var y = ACT_H + AXIS_H;
  lanes.forEach(function (lane) {
    lane.y0 = y;
    lane.h = 22 + lane.maxRows * ROW_PITCH;
    y += lane.h;
    Object.keys(lane.cells).forEach(function (b) {
      lane.cells[b].forEach(function (nd, i) {
        nd.tx = Number(b) * COL_W + CELL_PAD + (i % perRow) * DOT_PITCH + DOT_PITCH / 2;
        nd.ty = lane.y0 + 20 + Math.floor(i / perRow) * ROW_PITCH;
      });
    });
  });

  /* Activity: entities touched (created or modified) per bucket per class. */
  var touched = buckets.map(function () { return {}; });
  vis.forEach(function (nd) {
    var bc = bucketOf(nd.created), bm = bucketOf(nd.modified);
    (touched[bc][nd.cls] = touched[bc][nd.cls] || {})[nd.id] = true;
    if (bm !== bc) (touched[bm][nd.cls] = touched[bm][nd.cls] || {})[nd.id] = true;
  });
  var maxTotal = 1, cols = [];
  touched.forEach(function (perCls, b) {
    var segs = [], total = 0;
    CLASS_ORDER.forEach(function (cls) {
      var c = perCls[cls] ? Object.keys(perCls[cls]).length : 0;
      if (c) { segs.push({ cls: cls, count: c }); total += c; }
    });
    if (total) cols.push({ b: b, segs: segs, total: total });
    maxTotal = Math.max(maxTotal, total);
  });
  /* Column geometry: baseline at ACT_H, thin marks, 2px surface gaps between segments. */
  var scale = (ACT_H - 34) / maxTotal;
  cols.forEach(function (col) {
    var yTop = ACT_H, barW = Math.min(22, COL_W - 12);
    col.x = col.b * COL_W + COL_W / 2 - barW / 2;
    col.w = barW;
    col.segs.forEach(function (seg) {
      seg.y1 = yTop;
      seg.y0 = yTop - Math.max(2, seg.count * scale - 2);
      yTop = seg.y0 - 2;
    });
    col.yTop = yTop + 2;
  });

  TL = {
    grain: g, buckets: buckets, lanes: lanes, cols: cols, maxTotal: maxTotal,
    width: buckets.length * COL_W, height: y
  };
}

/* ================================ rendering ================================ */
var canvas = document.getElementById('canvas'), ctx = canvas.getContext('2d');
function resize() {
  var r = canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

function px(nd) { return mode === 'graph' ? nd.x : nd.tx; }
function py(nd) { return mode === 'graph' ? nd.y : nd.ty; }
function toScreen(wx, wy) {
  var v = view(), w = canvas.clientWidth, h = canvas.clientHeight;
  return { x: wx * v.k + w / 2 + v.x, y: wy * v.k + h / 2 + v.y };
}
function toWorld(sx, sy) {
  var v = view(), w = canvas.clientWidth, h = canvas.clientHeight;
  return { x: (sx - w / 2 - v.x) / v.k, y: (sy - h / 2 - v.y) / v.k };
}

/* Screen-space labels with occlusion culling: highest-priority labels win, the
   rest drop out instead of overprinting each other. */
var labelQ = [];
function queueLabel(wx, wy, text, pri, strong) {
  labelQ.push({ wx: wx, wy: wy, text: text, pri: pri, strong: strong });
}
function drawLabels() {
  var w = canvas.clientWidth, h = canvas.clientHeight;
  labelQ.sort(function (a, b) { return b.pri - a.pri; });
  var placed = [];
  ctx.save();
  labelQ.forEach(function (l) {
    var s = toScreen(l.wx, l.wy);
    if (s.x < -60 || s.x > w + 60 || s.y < -20 || s.y > h + 20) return;
    ctx.font = (l.strong ? '600 ' : '') + '11px system-ui, sans-serif';
    var tw = ctx.measureText(l.text).width;
    var rect = { x0: s.x - 2, x1: s.x + tw + 4, y0: s.y - 9, y1: s.y + 9 };
    for (var i = 0; i < placed.length; i++) {
      var r = placed[i];
      if (rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0) return;
    }
    placed.push(rect);
    ctx.strokeStyle = css('--page'); ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.strokeText(l.text, s.x, s.y + 4);
    ctx.fillStyle = l.strong ? css('--ink-1') : css('--ink-2');
    ctx.fillText(l.text, s.x, s.y + 4);
  });
  ctx.restore();
}

function fillShapeAt(cls, x, y, r) { pathShapeAt(cls, x, y, r); ctx.fill(); }
function strokeShapeAt(cls, x, y, r) { pathShapeAt(cls, x, y, r); ctx.stroke(); }
function pathShapeAt(cls, x, y, r) {
  ctx.beginPath();
  if (shapeOf(cls) === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
  else ctx.arc(x, y, r, 0, Math.PI * 2);
}

function drawNode(nd, r, focus, k) {
  var dimSearch = searchTerm && !matches(nd);
  var inF = !focus || focus.set[nd.id];
  ctx.globalAlpha = dimSearch ? 0.15 : (inF ? 1 : 0.12);
  if (isRecent(nd.modified)) {
    ctx.strokeStyle = css('--recent'); ctx.lineWidth = 2.5 / k;
    strokeShapeAt(nd.cls, px(nd), py(nd), r + 4 / k);
  }
  /* 2px surface ring keeps overlapping marks individually legible. */
  ctx.strokeStyle = css('--page'); ctx.lineWidth = 2 / k;
  strokeShapeAt(nd.cls, px(nd), py(nd), r + 1 / k);
  ctx.fillStyle = colorOf(nd.cls);
  fillShapeAt(nd.cls, px(nd), py(nd), r);
  if (nd === selected || nd === hovered) {
    ctx.strokeStyle = css('--ink-1'); ctx.lineWidth = 2 / k;
    strokeShapeAt(nd.cls, px(nd), py(nd), r + 3 / k);
  }
  if (!dimSearch && (!focus || inF)) {
    var pri = nd === selected ? 3e9 : nd === hovered ? 2e9 : (focus ? 1e6 : 0) + nd.deg;
    queueLabel(px(nd) + r + 6 / k, py(nd), nd.label, pri, nd === selected || nd === hovered);
  }
}

function drawGraph() {
  var v = viewG, w = canvas.clientWidth, h = canvas.clientHeight;
  var focus = focusSet();
  ctx.save();
  ctx.translate(w / 2 + v.x, h / 2 + v.y);
  ctx.scale(v.k, v.k);

  edges.forEach(function (e) {
    var a = byId[e.s], b = byId[e.o];
    if (!visible(a) || !visible(b)) return;
    var dimSearch = searchTerm && !(matches(a) || matches(b));
    var incident = focus && (e.s === focus.id || e.o === focus.id);
    var recent = isRecent(e.modified);
    if (focus && !incident) { ctx.globalAlpha = 0.05; }
    else if (dimSearch) { ctx.globalAlpha = 0.08; }
    else { ctx.globalAlpha = incident ? 0.95 : (recent ? 0.9 : 0.3); }
    ctx.strokeStyle = incident ? css('--ink-2') : (recent ? css('--recent') : css('--ink-muted'));
    ctx.lineWidth = (incident ? 1.8 : recent ? 2 : 1) / v.k;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (incident && !dimSearch) {
      queueLabel((a.x + b.x) / 2, (a.y + b.y) / 2, e.p, 1.5e9, false);
    }
  });

  nodes.forEach(function (nd) {
    if (!visible(nd)) return;
    drawNode(nd, nodeR(nd), focus, v.k);
  });
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawTimeline() {
  var v = viewT, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!TL) {
    ctx.fillStyle = css('--ink-2');
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('No dated entities to place on a timeline.', 24, 40);
    return;
  }
  var focus = focusSet();
  ctx.save();
  ctx.translate(w / 2 + v.x, h / 2 + v.y);
  ctx.scale(v.k, v.k);

  var i, b;
  /* Recessive vertical hairline per bucket boundary, through every band. */
  ctx.strokeStyle = css('--hairline'); ctx.lineWidth = 1 / v.k; ctx.globalAlpha = 0.55;
  for (i = 0; i <= TL.buckets.length; i++) {
    ctx.beginPath(); ctx.moveTo(i * COL_W, 0); ctx.lineTo(i * COL_W, TL.height); ctx.stroke();
  }
  /* Lane separators + labels. */
  ctx.globalAlpha = 1;
  TL.lanes.forEach(function (lane) {
    ctx.strokeStyle = css('--hairline'); ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.moveTo(0, lane.y0); ctx.lineTo(TL.width, lane.y0); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colorOf(lane.cls);
    pathShapeAt(lane.cls, -14, lane.y0 + lane.h / 2, 5); ctx.fill();
    ctx.fillStyle = css('--ink-2');
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(lane.cls + ' (' + lane.count + ')', -24, lane.y0 + lane.h / 2 + 4);
    ctx.textAlign = 'left';
  });
  ctx.strokeStyle = css('--hairline');
  ctx.beginPath(); ctx.moveTo(0, TL.height); ctx.lineTo(TL.width, TL.height); ctx.stroke();

  /* Activity band: baseline + max tick + the stacked columns. */
  ctx.strokeStyle = css('--hairline'); ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.moveTo(0, ACT_H); ctx.lineTo(TL.width, ACT_H); ctx.stroke();
  ctx.fillStyle = css('--ink-muted');
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right';
  ctx.fillText(String(TL.maxTotal), -8, 34 + 4);
  ctx.fillText('0', -8, ACT_H + 4);
  ctx.textAlign = 'left';
  ctx.fillText('ACTIVITY — entities touched per ' + TL.grain, 0, -10);
  TL.cols.forEach(function (col) {
    var colDim = focus || (searchTerm !== '');
    ctx.globalAlpha = colDim ? 0.35 : 1;
    col.segs.forEach(function (seg, si) {
      ctx.fillStyle = colorOf(seg.cls);
      var top = si === col.segs.length - 1;
      ctx.beginPath();
      if (top && ctx.roundRect) {
        ctx.roundRect(col.x, seg.y0, col.w, seg.y1 - seg.y0, [4, 4, 0, 0]);
      } else {
        ctx.rect(col.x, seg.y0, col.w, seg.y1 - seg.y0);
      }
      ctx.fill();
    });
  });
  ctx.globalAlpha = 1;

  /* Axis band: one label per bucket. */
  ctx.fillStyle = css('--ink-muted');
  ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
  for (i = 0; i < TL.buckets.length; i++) {
    b = TL.buckets[i];
    ctx.fillText(b.label, i * COL_W + COL_W / 2, ACT_H + 17);
  }
  ctx.textAlign = 'left';

  /* Edges as horizontal-flowing arcs between node positions. */
  edges.forEach(function (e) {
    var a = byId[e.s], c = byId[e.o];
    if (!visible(a) || !visible(c)) return;
    var dimSearch = searchTerm && !(matches(a) || matches(c));
    var incident = focus && (e.s === focus.id || e.o === focus.id);
    if (focus && !incident) { ctx.globalAlpha = 0.03; }
    else if (dimSearch) { ctx.globalAlpha = 0.04; }
    else { ctx.globalAlpha = incident ? 0.9 : 0.10; }
    ctx.strokeStyle = incident ? css('--ink-2') : css('--ink-muted');
    ctx.lineWidth = (incident ? 1.8 : 1) / v.k;
    var x1 = a.tx, y1 = a.ty, x2 = c.tx, y2 = c.ty;
    var bow = Math.max(28, Math.abs(x2 - x1) * 0.35);
    ctx.beginPath(); ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1 + bow, y1, x2 - bow, y2, x2, y2);
    ctx.stroke();
    if (incident && !dimSearch) {
      queueLabel((x1 + x2) / 2, (y1 + y2) / 2 - 6 / v.k, e.p, 1.5e9, false);
    }
  });
  ctx.globalAlpha = 1;

  nodes.forEach(function (nd) {
    if (!visible(nd) || nd.tx === undefined) return;
    drawNode(nd, 7, focus, v.k);
  });
  ctx.globalAlpha = 1;
  ctx.restore();
}

function draw() {
  var w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  labelQ = [];
  if (mode === 'graph') drawGraph(); else drawTimeline();
  drawLabels();
}

function fitView() {
  var w = canvas.clientWidth, h = canvas.clientHeight, v = view();
  var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  if (mode === 'timeline') {
    if (!TL) return;
    x0 = -170; x1 = TL.width + 20; y0 = -30; y1 = TL.height + 20;
  } else {
    nodes.forEach(function (nd) {
      if (!visible(nd)) return;
      x0 = Math.min(x0, nd.x); x1 = Math.max(x1, nd.x);
      y0 = Math.min(y0, nd.y); y1 = Math.max(y1, nd.y);
    });
    if (x0 === Infinity) return;
    x0 -= 60; x1 += 160; y0 -= 40; y1 += 40; /* room for labels on the right */
  }
  var k = Math.min(2, Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.96);
  v.k = Math.max(0.1, k);
  v.x = -((x0 + x1) / 2) * v.k;
  v.y = -((y0 + y1) / 2) * v.k;
}

function loop() {
  tick();
  if (mode === 'graph' && !didFitGraph && alpha < 0.03 && nodes.length) {
    didFitGraph = true; fitView();
  }
  draw();
  requestAnimationFrame(loop);
}

/* ================================ interaction =============================== */
var dragNode = null, panning = false, last = null;
function pick(sx, sy) {
  var p = toWorld(sx, sy), best = null, bd = 14 / view().k;
  nodes.forEach(function (nd) {
    if (!visible(nd)) return;
    var x = px(nd), y = py(nd);
    if (x === undefined) return;
    var d = Math.hypot(x - p.x, y - p.y);
    if (d < bd + 7) { best = nd; bd = d; }
  });
  return best;
}
function pickColumn(sx, sy) {
  if (mode !== 'timeline' || !TL) return null;
  var p = toWorld(sx, sy);
  if (p.y < 0 || p.y > ACT_H || p.x < 0 || p.x > TL.width) return null;
  var b = Math.floor(p.x / COL_W);
  for (var i = 0; i < TL.cols.length; i++) if (TL.cols[i].b === b) return TL.cols[i];
  return null;
}
canvas.addEventListener('mousedown', function (ev) {
  var nd = pick(ev.offsetX, ev.offsetY);
  if (nd && mode === 'graph') { dragNode = nd; alpha = Math.max(alpha, 0.15); }
  else { panning = { hit: nd }; }
  last = { x: ev.offsetX, y: ev.offsetY, sx: ev.offsetX, sy: ev.offsetY };
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', function (ev) {
  if (!last) {
    if (ev.target === canvas) hover(ev.offsetX, ev.offsetY);
    return;
  }
  var dx = ev.offsetX - last.x, dy = ev.offsetY - last.y;
  if (dragNode) {
    var p = toWorld(ev.offsetX, ev.offsetY);
    dragNode.x = p.x; dragNode.y = p.y; dragNode.vx = 0; dragNode.vy = 0;
    alpha = Math.max(alpha, 0.1);
  } else if (panning) { view().x += dx; view().y += dy; }
  last.x = ev.offsetX; last.y = ev.offsetY;
});
window.addEventListener('mouseup', function (ev) {
  if (last && ev.target === canvas) {
    var moved = Math.hypot(ev.offsetX - last.sx, ev.offsetY - last.sy);
    if (moved < 3) {
      var nd = dragNode || (panning && panning.hit) || pick(ev.offsetX, ev.offsetY);
      select(nd || null);
    }
  }
  dragNode = null; panning = false; last = null;
  canvas.style.cursor = 'grab';
});
canvas.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  var v = view();
  var k = Math.min(4, Math.max(0.1, v.k * (ev.deltaY < 0 ? 1.12 : 0.89)));
  /* Zoom toward the cursor, not the viewport center. */
  var p = toWorld(ev.offsetX, ev.offsetY);
  v.k = k;
  var w = canvas.clientWidth, h = canvas.clientHeight;
  v.x = ev.offsetX - w / 2 - p.x * k;
  v.y = ev.offsetY - h / 2 - p.y * k;
}, { passive: false });

var tooltip = document.getElementById('tooltip');
function hover(sx, sy) {
  var nd = pick(sx, sy);
  hovered = nd;
  if (nd) {
    var when = mode === 'timeline'
      ? 'created ' + fmt(nd.created) : 'updated ' + ago(nd.modified);
    tooltip.innerHTML =
      '<div class="tt-title">' + esc(nd.label) + '</div>' +
      '<div class="tt-sub">' + esc(nd.cls) + ' · ' + esc(when) + '</div>';
    canvas.style.cursor = 'pointer';
  } else {
    canvas.style.cursor = 'grab';
    var col = pickColumn(sx, sy);
    if (!col) { tooltip.style.display = 'none'; return; }
    var html = '<div class="tt-title">' + esc(TL.buckets[col.b].label) + '</div>' +
      '<div class="tt-sub">' + esc(col.total) + ' entit' + (col.total === 1 ? 'y' : 'ies') + ' touched</div>';
    for (var i = col.segs.length - 1; i >= 0; i--) {
      var seg = col.segs[i], st = CLASS_STYLE[seg.cls] || { slot: 0, shape: 'circle' };
      html += '<div class="tt-row"><span class="sw ' + st.shape + '" style="background:var(--c' + st.slot + ')"></span>' +
        esc(seg.cls) + '<span class="n">' + esc(seg.count) + '</span></div>';
    }
    tooltip.innerHTML = html;
  }
  tooltip.style.display = 'block';
  tooltip.style.left = (sx + 14) + 'px';
  tooltip.style.top = (sy + 10) + 'px';
}

var panel = document.getElementById('panel');
function select(nd) {
  selected = nd;
  if (!nd) { panel.classList.remove('open'); resize(); return; }
  var html = '<button id="close">✕</button><h2>' + esc(nd.label) + '</h2>' +
    '<div class="cls">' + esc(nd.cls) + ' · <code>' + esc(nd.id) + '</code></div>' +
    '<div class="stamp">created ' + esc(fmt(nd.created)) + '<br>modified ' + esc(fmt(nd.modified)) + ' (' + esc(ago(nd.modified)) + ')</div>';
  if (nd.attrs.length) {
    html += '<h3>Attributes</h3>';
    nd.attrs.forEach(function (a) {
      html += '<div class="row"><span class="k">' + esc(a.p) + '</span>: ' + esc(a.v) +
        '<div class="when">updated ' + esc(fmt(a.modified)) + '</div></div>';
    });
  }
  if (nd.out.length) {
    html += '<h3>Edges out</h3>';
    nd.out.forEach(function (e) {
      html += '<div class="row">' + esc(e.p) + ' → <span class="edge-target" data-id="' + esc(e.o) + '">' +
        esc(byId[e.o].label) + '</span><div class="when">updated ' + esc(fmt(e.modified)) + '</div></div>';
    });
  }
  if (nd.inc.length) {
    html += '<h3>Edges in</h3>';
    nd.inc.forEach(function (e) {
      html += '<div class="row"><span class="edge-target" data-id="' + esc(e.s) + '">' + esc(byId[e.s].label) +
        '</span> ' + esc(e.p) + ' → this<div class="when">updated ' + esc(fmt(e.modified)) + '</div></div>';
    });
  }
  panel.innerHTML = html;
  panel.classList.add('open');
  resize(); /* the stage narrows when the panel opens; keep the canvas in sync */
  panel.querySelector('#close').onclick = function () { select(null); };
  panel.querySelectorAll('.edge-target').forEach(function (elm) {
    elm.onclick = function () { select(byId[elm.getAttribute('data-id')]); };
  });
}

/* ===================== chrome: views / grain / legend / meta ================ */
var grainEl = document.getElementById('grain');
var didFitTimeline = false;
function setMode(m) {
  mode = m;
  document.querySelectorAll('#views button').forEach(function (bt) {
    bt.classList.toggle('on', bt.getAttribute('data-v') === m);
  });
  grainEl.classList.toggle('show', m === 'timeline');
  if (m === 'timeline') {
    if (!TL) layoutTimeline();
    if (!didFitTimeline) { didFitTimeline = true; fitView(); }
  }
}
document.querySelectorAll('#views button').forEach(function (bt) {
  bt.onclick = function () { setMode(bt.getAttribute('data-v')); };
});
function setGrain(g) {
  grain = g;
  document.querySelectorAll('#grain button').forEach(function (bt) {
    bt.classList.toggle('on', bt.getAttribute('data-g') === g);
  });
  layoutTimeline();
  if (mode === 'timeline') fitView();
}
document.querySelectorAll('#grain button').forEach(function (bt) {
  bt.onclick = function () { setGrain(bt.getAttribute('data-g')); };
});
document.getElementById('fit').onclick = fitView;

function buildLegend() {
  var lg = document.getElementById('legend'), html = '';
  CLASS_ORDER.forEach(function (cls) {
    var st = CLASS_STYLE[cls];
    var count = nodes.filter(function (nd) { return nd.cls === cls; }).length;
    html += '<div class="lg" data-cls="' + cls + '"><span class="sw ' + st.shape +
      '" style="background:var(--c' + st.slot + ')"></span>' + cls + (count ? ' (' + count + ')' : '') + '</div>';
  });
  lg.innerHTML = html;
  lg.querySelectorAll('.lg').forEach(function (elm) {
    elm.onclick = function () {
      var cls = elm.getAttribute('data-cls');
      hiddenClasses[cls] = !hiddenClasses[cls];
      elm.classList.toggle('off', !!hiddenClasses[cls]);
      layoutTimeline();
    };
  });
}
document.getElementById('search').addEventListener('input', function (ev) {
  searchTerm = ev.target.value.trim().toLowerCase();
});

function loadMeta() {
  fetch('/visual-ontologies/meta.json').then(function (r) { return r.json(); }).then(function (m) {
    document.getElementById('meta').innerHTML =
      'version <b>v' + esc(m.version) + '</b> · updated <b>' + esc(ago(m.updated_at)) + '</b> (' + esc(fmt(m.updated_at)) + ')' +
      ' · <b>' + esc(m.nodes) + '</b> nodes · <b>' + esc(m.edges) + '</b> edges' +
      ' · <a href="/visual-ontologies/ontology.rdf" style="color:var(--c1)">data.rdf</a>' +
      ' · <a href="/visual-ontologies/schema.owl" style="color:var(--c1)">schema.owl</a>';
    var pend = m.pending_guidance || [];
    var badge = document.getElementById('pending-badge');
    if (pend.length) {
      badge.style.display = 'inline-block';
      badge.textContent = pend.length + ' awaiting guidance';
      var list = document.getElementById('pending-list');
      var html = '<h3>Documents awaiting guidance (answer via ontology_sync)</h3>';
      pend.forEach(function (p) {
        html += '<div class="pg"><div class="p">' + esc(p.path) + ' · ' + esc(p.attempts) + ' attempts</div>' +
          esc(p.question) + '</div>';
      });
      list.innerHTML = html;
      badge.onclick = function () {
        list.style.display = list.style.display === 'block' ? 'none' : 'block';
      };
    }
  });
}

fetch('/visual-ontologies/ontology.rdf')
  .then(function (r) { return r.text(); })
  .then(function (text) {
    parseRdf(text);
    resize();
    if (!nodes.length) {
      var e = document.getElementById('empty');
      e.style.display = 'flex';
      e.textContent = 'The ontology is empty.\nRun the ontology_sync MCP tool (or wait for the hourly cron) to route vault content into it.';
    }
    var times = [];
    nodes.forEach(function (nd) {
      var t = parseT(nd.created); if (t !== null) times.push(t);
    });
    if (times.length) {
      setGrain(autoGrain(Math.min.apply(null, times), Math.max.apply(null, times)));
    } else {
      setGrain('day');
    }
    layoutInit(); buildLegend(); loadMeta(); loop();
  });
</script>
</body>
</html>
`;
