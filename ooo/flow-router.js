/* The wire router of the pipeline layout (flow.js).
 *
 * Pure geometry, no DOM: given the rectangles of the structures and the
 * shared lines the wires may run along — a vertical *gutter* between every
 * two columns, a horizontal *channel* between every two lanes — it finds an
 * orthogonal path for each wire, and then keeps the wires apart:
 *
 *   1. every wire is routed by shortest path (length plus a price per bend)
 *      over the graph of the lines; a wire leaves and enters a structure
 *      along a *ray* cast square out of one of its sides, which stops at the
 *      first structure it meets (so a ray that meets the wire's other end is
 *      a straight wire);
 *   2. wires that ended up on the same side of the same structure are spread
 *      along that side, and everything is routed again with the ports fixed;
 *   3. wires that share a stretch of a gutter or a channel each get a track
 *      of their own in it.
 *
 * Nothing here knows what a reorder buffer is: a new structure is one more
 * rectangle and a new wire one more { id, from, to }, which is what lets the
 * layout grow by a stage without anyone re-drawing the wires by hand.
 *
 *   boxes   { id: { left, top, right, bottom, wide? } }   `wide`: a rail (the
 *           CDB) — it has no ports of its own; a wire joins it wherever a
 *           line or the other end's ray meets its edge
 *   lines   [{ id, o: 'v' | 'h', c, a, b }]   at x = c from y = a to b ('v'),
 *           or at y = c from x = a to b ('h')
 *   wires   [{ id, from, to, fromSide?, toSide? }]   sides: 'left' | 'right' |
 *           'top' | 'bottom', or a list of them, to restrict the router
 */

(function (root) {
'use strict';

const E = 0.5;
const DEFAULTS = { pad: 10, portGap: 18, trackV: 12, trackH: 16, bend: 28 };
const SIDES = ['left', 'right', 'top', 'bottom'];
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const horiz = (side) => side === 'left' || side === 'right';
const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

/** Does the segment at x = c (o 'v') or y = c (o 'h'), from a to b, pass
 *  through the inside of the box?  Running along an edge does not count. */
function crosses(box, o, c, a, b) {
  if (o === 'v') return c > box.left + E && c < box.right - E && Math.min(b, box.bottom - E) - Math.max(a, box.top + E) > 0;
  return c > box.top + E && c < box.bottom - E && Math.min(b, box.right - E) - Math.max(a, box.left + E) > 0;
}

function sidesOf(spec) {
  if (!spec) return SIDES;
  return Array.isArray(spec) ? spec : [spec];
}

/** Where on `side` of `box` a wire to `other` leaves: opposite the middle of
 *  what the two have in common when they face each other (a straight wire),
 *  else the middle of the side. */
function portCoord(box, side, other, pad) {
  if (horiz(side)) {
    const facing = side === 'right' ? other.left >= box.right - E : other.right <= box.left + E;
    const lo = Math.max(box.top, other.top), hi = Math.min(box.bottom, other.bottom);
    const c = facing && hi - lo >= 2 * pad ? (lo + hi) / 2 : (box.top + box.bottom) / 2;
    return clamp(c, box.top + pad, box.bottom - pad);
  }
  const facing = side === 'bottom' ? other.top >= box.bottom - E : other.bottom <= box.top + E;
  const lo = Math.max(box.left, other.left), hi = Math.min(box.right, other.right);
  const c = facing && hi - lo >= 2 * pad && !other.wide ? (lo + hi) / 2 : (box.left + box.right) / 2;
  return clamp(c, box.left + pad, box.right - pad);
}

/** The ray out of `side` of `box` at `coord`: a line from the box's edge to
 *  the first box in the way (`hit`, its id), or to the frame. */
function castRay(id, box, side, coord, boxes, frame) {
  let end, hit = null;
  if (side === 'right' || side === 'left') {
    const right = side === 'right';
    end = right ? Math.max(frame.right, box.right) : Math.min(frame.left, box.left);
    for (const [oid, o] of Object.entries(boxes)) {
      if (oid === id || !(coord > o.top + E && coord < o.bottom - E)) continue;
      if (right && o.left >= box.right - E && o.left < end + E) { end = o.left; hit = oid; }
      if (!right && o.right <= box.left + E && o.right > end - E) { end = o.right; hit = oid; }
    }
    const start = right ? box.right : box.left;
    return { o: 'h', c: coord, a: Math.min(start, end), b: Math.max(start, end), base: null, side, hit,
             start: { x: start, y: coord }, end: { x: end, y: coord } };
  }
  const down = side === 'bottom';
  end = down ? Math.max(frame.bottom, box.bottom) : Math.min(frame.top, box.top);
  for (const [oid, o] of Object.entries(boxes)) {
    if (oid === id || !(coord > o.left + E && coord < o.right - E)) continue;
    if (down && o.top >= box.bottom - E && o.top < end + E) { end = o.top; hit = oid; }
    if (!down && o.bottom <= box.top + E && o.bottom > end - E) { end = o.bottom; hit = oid; }
  }
  const start = down ? box.bottom : box.top;
  return { o: 'v', c: coord, a: Math.min(start, end), b: Math.max(start, end), base: null, side, hit,
           start: { x: coord, y: start }, end: { x: coord, y: end } };
}

/** Where the shared lines end on an edge of `box`: a way into a rail. */
function touches(box, lines, pad) {
  const out = [];
  lines.forEach((l, i) => {
    if (l.base === null) return;
    if (l.o === 'v' && l.c >= box.left + pad && l.c <= box.right - pad) {
      if (Math.abs(l.b - box.top) < 1) out.push({ x: l.c, y: box.top, line: i, side: 'top' });
      if (Math.abs(l.a - box.bottom) < 1) out.push({ x: l.c, y: box.bottom, line: i, side: 'bottom' });
    }
    if (l.o === 'h' && l.c >= box.top + pad && l.c <= box.bottom - pad) {
      if (Math.abs(l.b - box.left) < 1) out.push({ x: box.left, y: l.c, line: i, side: 'left' });
      if (Math.abs(l.a - box.right) < 1) out.push({ x: box.right, y: l.c, line: i, side: 'right' });
    }
  });
  return out;
}

/** One wire: the cheapest orthogonal path from `wire.from` to `wire.to`.
 *  `fixed`, from an earlier pass: { from: { side, c, own }, to: … } pins each
 *  end to a side and a place on it (`own`: the port is a ray of that box; when
 *  not, the end was reached by the other end's ray or by a shared line, and
 *  stays that way).  Null when there is no way through. */
function routeOne(wire, boxes, baseLines, frame, opts, fixed) {
  const A = boxes[wire.from], B = boxes[wire.to];
  if (!A || !B) return null;
  const lines = baseLines.map((l) => ({ ...l, base: l.id }));
  const sources = [], targets = [];
  const rays = (id, box, other, otherId, spec, pin, mine, theirs, otherSpec) => {
    if (box.wide || (pin && !pin.own)) return;
    for (const side of pin ? [pin.side] : sidesOf(spec)) {
      const coord = pin ? pin.c : portCoord(box, side, other, opts.pad);
      const ray = castRay(id, box, side, coord, boxes, frame);
      lines.push(ray);
      const line = lines.length - 1;
      mine.push({ x: ray.start.x, y: ray.start.y, line, side, c: coord, own: true });
      // A ray that meets the other end is a wire already.
      if (ray.hit === otherId && sidesOf(otherSpec).includes(OPPOSITE[side])) {
        theirs.push({ x: ray.end.x, y: ray.end.y, line, side: OPPOSITE[side], c: coord, own: false });
      }
    }
  };
  rays(wire.from, A, B, wire.to, wire.fromSide, fixed && fixed.from, sources, targets, wire.toSide);
  rays(wire.to, B, A, wire.from, wire.toSide, fixed && fixed.to, targets, sources, wire.fromSide);
  for (const t of touches(A, lines, opts.pad)) sources.push({ ...t, c: horiz(t.side) ? t.y : t.x, own: false });
  for (const t of touches(B, lines, opts.pad)) targets.push({ ...t, c: horiz(t.side) ? t.y : t.x, own: false });
  if (!sources.length || !targets.length) return null;

  // The graph: a point wherever two lines cross and at every port; an edge
  // between neighbouring points of a line, unless a box is in the way.
  const points = [], index = new Map(), onLine = lines.map(() => []);
  const point = (x, y) => {
    const key = `${Math.round(x * 2)},${Math.round(y * 2)}`;
    if (!index.has(key)) { index.set(key, points.length); points.push({ x, y }); }
    return index.get(key);
  };
  lines.forEach((v, vi) => {
    if (v.o !== 'v') return;
    lines.forEach((h, hi) => {
      if (h.o !== 'h') return;
      if (v.c < h.a - E || v.c > h.b + E || h.c < v.a - E || h.c > v.b + E) return;
      const p = point(v.c, h.c);
      onLine[vi].push(p);
      onLine[hi].push(p);
    });
  });
  for (const t of [...sources, ...targets]) { t.p = point(t.x, t.y); onLine[t.line].push(t.p); }
  const edges = points.map(() => []);
  const all = Object.values(boxes);
  lines.forEach((l, li) => {
    const along = (p) => (l.o === 'v' ? points[p].y : points[p].x);
    const ps = [...new Set(onLine[li])].sort((p, q) => along(p) - along(q));
    for (let k = 0; k + 1 < ps.length; k++) {
      const a = along(ps[k]), b = along(ps[k + 1]);
      if (all.some((box) => crosses(box, l.o, l.c, a, b))) continue;
      edges[ps[k]].push({ to: ps[k + 1], w: b - a, o: l.o, line: li });
      edges[ps[k + 1]].push({ to: ps[k], w: b - a, o: l.o, line: li });
    }
  });

  // Dijkstra over (point, direction of travel), so a bend has a price.
  const state = (p, o) => p * 2 + (o === 'v' ? 1 : 0);
  const dist = new Array(points.length * 2).fill(Infinity);
  const prev = new Array(points.length * 2).fill(null);
  const done = new Array(points.length * 2).fill(false);
  const startOf = new Map();
  for (const s of sources) {
    const st = state(s.p, lines[s.line].o);
    // Where a ray of each end arrives at the other's port, the wire is one
    // straight ray: it is the `from` end's (its own port), and the `to` end
    // takes it where it lands — so the two ends never both move it.
    if (dist[st] > 0 || (s.own && !startOf.get(st).own)) { dist[st] = 0; startOf.set(st, s); }
  }
  const goal = new Map();
  for (const t of targets) {
    const st = state(t.p, lines[t.line].o);
    if (!goal.has(st) || (!t.own && goal.get(st).own)) goal.set(st, t);
  }
  let found = null;
  for (;;) {
    let u = -1;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) break;
    if (goal.has(u)) { found = u; break; }
    done[u] = true;
    const p = u >> 1, o = u & 1 ? 'v' : 'h';
    for (const e of edges[p]) {
      const v = state(e.to, e.o);
      const d = dist[u] + e.w + (e.o === o ? 0 : opts.bend);
      if (d < dist[v] - 1e-9) { dist[v] = d; prev[v] = { from: u, line: e.line }; }
    }
  }
  if (found === null) return null;

  // Walk back, then merge the steps of each straight run into a segment.  A
  // segment is `on` a shared line only when every step of it was: a run that
  // includes a port's ray stays where the port is.
  const steps = [];
  let u = found;
  while (prev[u]) { steps.unshift({ p: u >> 1, line: prev[u].line }); u = prev[u].from; }
  const source = startOf.get(u), target = goal.get(found);
  const pts = [{ ...points[u >> 1] }], segs = [];
  let last = null;
  for (const s of steps) {
    const l = lines[s.line];
    if (last && last.o === l.o) {
      pts[pts.length - 1] = { ...points[s.p] };
      if (last.line !== l.base) last.line = null;
    } else {
      pts.push({ ...points[s.p] });
      last = { o: l.o, line: l.base };
      segs.push(last);
    }
  }
  return { id: wire.id, pts, segs,
           from: { side: source.side, c: source.c, own: source.own },
           to: { side: target.side, c: target.c, own: target.own } };
}

/** Wires that share a side of a box, spread along it (in the order of where
 *  they go next, so they fan out without crossing). */
function spreadPorts(routes, wires, boxes, opts) {
  const groups = new Map();
  for (const w of wires) {
    const r = routes.get(w.id);
    if (!r) continue;
    for (const end of ['from', 'to']) {
      const key = `${w[end]}|${r[end].side}`;
      if (!groups.has(key)) groups.set(key, []);
      // Where the wire goes after its stub: the second corner from this end.
      const pts = end === 'from' ? r.pts : [...r.pts].reverse();
      const next = pts[Math.min(2, pts.length - 1)];
      groups.get(key).push({ r, end, box: boxes[w[end]], toward: horiz(r[end].side) ? next.y : next.x });
    }
  }
  const entry = new Map();                 // "wire id|end" -> its entry, to find a wire's other end
  for (const list of groups.values()) for (const g of list) entry.set(`${g.r.id}|${g.end}`, g);
  const isOwn = (g) => g.r[g.end].own;
  const other = (g) => entry.get(`${g.r.id}|${g.end === 'from' ? 'to' : 'from'}`);
  const span = (g) => {
    const side = g.r[g.end].side;
    return [(horiz(side) ? g.box.top : g.box.left) + opts.pad, (horiz(side) ? g.box.bottom : g.box.right) - opts.pad];
  };
  // 1. The ports a box casts from one side, spread evenly about its middle.
  for (const list of groups.values()) {
    const own = list.filter(isOwn).sort((p, q) => p.toward - q.toward);
    own.forEach((g, k) => {
      const [lo, hi] = span(g);
      if (own.length < 2) { g.c = clamp(g.r[g.end].c, lo, hi); return; }
      const gap = Math.min(opts.portGap, Math.max(4, (hi - lo) / (own.length - 1)));
      const centre = clamp((lo + hi) / 2, lo + gap * (own.length - 1) / 2, hi - gap * (own.length - 1) / 2);
      g.c = clamp(centre + (k - (own.length - 1) / 2) * gap, lo, hi);
    });
  }
  // 2. A wire that arrives on a side by the other end's ray lands where that
  //    ray now is; the box's own ports there keep clear of it, moving to the
  //    side of it they go off to, so the two do not cross.  (A port whose own
  //    ray is such a wire stays put: the far end is counting on it.)
  for (const list of groups.values()) {
    const taken = [];
    for (const g of list) {
      if (isOwn(g)) continue;
      const o = other(g);
      g.c = o && isOwn(o) && o.c !== undefined ? o.c : g.r[g.end].c;
      taken.push(g.c);
    }
    const own = list.filter(isOwn);
    for (const g of own) { const o = other(g); if (o && !isOwn(o)) taken.push(g.c); }
    for (const g of own) {
      const o = other(g);
      if (o && !isOwn(o)) continue;
      const [lo, hi] = span(g);
      const gap = Math.min(opts.portGap, Math.max(4, (hi - lo) / Math.max(1, list.length - 1)));
      let c = g.c;
      for (let tries = 0; tries < list.length + 1; tries++) {
        const near = taken.find((t) => Math.abs(c - t) < gap - 0.01);
        if (near === undefined) break;
        const dir = g.toward >= near ? 1 : -1;
        const next = near + dir * gap;
        c = next < lo || next > hi ? near - dir * gap : next;       // no room that way: the other
      }
      g.c = clamp(c, lo, hi);
      taken.push(g.c);
    }
  }
  const fixed = new Map();
  for (const list of groups.values()) {
    for (const g of list) {
      const f = fixed.get(g.r.id) || {};
      f[g.end] = { side: g.r[g.end].side, c: g.c, own: isOwn(g) };
      fixed.set(g.r.id, f);
    }
  }
  return fixed;
}

/** Give every wire on a shared line a track of its own where it runs beside
 *  another; returns { line id: tracks needed }. */
function assignTracks(routes, baseLines, opts) {
  const byLine = new Map();
  for (const r of routes.values()) {
    r.segs.forEach((s, i) => {
      if (s.line === null || s.line === undefined) return;
      const p = r.pts[i], q = r.pts[i + 1];
      const a = s.o === 'v' ? Math.min(p.y, q.y) : Math.min(p.x, q.x);
      const b = s.o === 'v' ? Math.max(p.y, q.y) : Math.max(p.x, q.x);
      if (!byLine.has(s.line)) byLine.set(s.line, []);
      byLine.get(s.line).push({ r, i, a, b, o: s.o });
    });
  }
  const counts = {};
  for (const l of baseLines) counts[l.id] = 0;
  const MARGIN = 6;
  for (const [line, items] of byLine) {
    items.sort((p, q) => p.a - q.a || p.b - q.b);
    // Clusters of segments that overlap, directly or through one another.
    let cluster = [], reach = -Infinity;
    const clusters = [];
    for (const it of items) {
      if (cluster.length && it.a > reach + MARGIN) { clusters.push(cluster); cluster = []; reach = -Infinity; }
      cluster.push(it);
      reach = Math.max(reach, it.b);
    }
    if (cluster.length) clusters.push(cluster);
    for (const cl of clusters) {
      const ends = [];                       // per track: where its last segment ends
      for (const it of cl) {
        let t = ends.findIndex((e) => e + MARGIN < it.a);
        if (t < 0) { t = ends.length; ends.push(it.b); } else ends[t] = it.b;
        it.track = t;
      }
      counts[line] = Math.max(counts[line] || 0, ends.length);
      const gap = cl[0].o === 'v' ? opts.trackV : opts.trackH;
      for (const it of cl) {
        const off = (it.track - (ends.length - 1) / 2) * gap;
        if (!off) continue;
        const p = it.r.pts[it.i], q = it.r.pts[it.i + 1];
        if (it.o === 'v') { p.x += off; q.x += off; } else { p.y += off; q.y += off; }
      }
    }
  }
  return counts;
}

/** Route every wire.  → { routes: Map(id → { pts: [{x, y}], from, to }),
 *  tracks: { line id: n }, unrouted: [id] } */
function routeAll(wires, boxes, lines, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const xs = [], ys = [];
  for (const b of Object.values(boxes)) { xs.push(b.left, b.right); ys.push(b.top, b.bottom); }
  for (const l of lines) { (l.o === 'v' ? xs : ys).push(l.c); (l.o === 'v' ? ys : xs).push(l.a, l.b); }
  const frame = opts.frame || { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };

  const first = new Map();
  for (const w of wires) {
    const r = routeOne(w, boxes, lines, frame, opts, null);
    if (r) first.set(w.id, r);
  }
  const fixed = spreadPorts(first, wires, boxes, opts);
  const routes = new Map(), unrouted = [];
  for (const w of wires) {
    if (!boxes[w.from] || !boxes[w.to]) continue;
    const r = (first.has(w.id) && routeOne(w, boxes, lines, frame, opts, fixed.get(w.id))) || first.get(w.id);
    if (r) routes.set(w.id, r); else unrouted.push(w.id);
  }
  const tracks = assignTracks(routes, lines, opts);
  return { routes, tracks, unrouted };
}

/* ---------------- labels ---------------- */

const overlap = (p, q) => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;

/** Where a wire's label goes: on a horizontal run long enough to hold it
 *  (above the wire, or below), else beside a vertical run, else — in a gutter,
 *  where there is no room beside — turned to read up a vertical run; the
 *  first place clear of the boxes and of the labels already placed.  `w`, `h`:
 *  the size of one line; with `lines` 2 the label is two lines of that size,
 *  one either side of the wire (or stacked, beside a vertical run), and the
 *  place has a `second` { x, y } for the second line.
 *  → { x, y (baseline), anchor, rotate (the text reads upwards, about x, y), second?, rect } */
function placeLabel(pts, w, h, obstacles, lines) {
  const two = lines === 2;
  const runs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const vertical = Math.abs(p.x - q.x) < E;
    runs.push({ p, q, vertical, len: Math.abs(p.x - q.x) + Math.abs(p.y - q.y) });
  }
  runs.sort((r, s) => s.len - r.len);
  const FRACS = [0.5, 0.3, 0.7, 0.15, 0.85];
  const at = (r, f) => ({ x: r.p.x + (r.q.x - r.p.x) * f, y: r.p.y + (r.q.y - r.p.y) * f });
  const above = (x, y) => ({ x, y: y - 5, anchor: 'middle', rotate: false, rect: { left: x - w / 2, right: x + w / 2, top: y - h - 3, bottom: y - 2 } });
  const below = (x, y) => ({ x, y: y + h + 1, anchor: 'middle', rotate: false, rect: { left: x - w / 2, right: x + w / 2, top: y + 2, bottom: y + h + 3 } });
  const astride = (x, y) => ({ ...above(x, y), second: { x, y: y + h + 1 }, rect: { left: x - w / 2, right: x + w / 2, top: y - h - 3, bottom: y + h + 3 } });
  const beside = (x, y, right) => {
    const top = two ? y - h : y - h / 2, bottom = two ? y + h : y + h / 2;
    const place = right
      ? { x: x + 7, y: top + h - 2, anchor: 'start', rotate: false, rect: { left: x + 5, right: x + 9 + w, top, bottom } }
      : { x: x - 7, y: top + h - 2, anchor: 'end', rotate: false, rect: { left: x - 9 - w, right: x - 5, top, bottom } };
    if (two) place.second = { x: place.x, y: place.y + h };
    return place;
  };
  const upLeft = (x, y) => ({ x: x - 5, y, anchor: 'middle', rotate: true, rect: { left: x - 5 - h, right: x - 3, top: y - w / 2, bottom: y + w / 2 } });
  const upRight = (x, y) => ({ x: x + h + 1, y, anchor: 'middle', rotate: true, rect: { left: x + 3, right: x + 5 + h, top: y - w / 2, bottom: y + w / 2 } });
  const upAstride = (x, y) => ({ ...upLeft(x, y), second: { x: x + h + 1, y }, rect: { left: x - 5 - h, right: x + 5 + h, top: y - w / 2, bottom: y + w / 2 } });
  const places = [];
  // 1. along a horizontal run that holds it
  for (const r of runs) if (!r.vertical && r.len >= w + 10) for (const f of FRACS) {
    const { x, y } = at(r, f);
    if (two) places.push(astride(x, y)); else places.push(above(x, y), below(x, y));
  }
  // 2. beside a vertical run
  for (const r of runs) if (r.vertical && r.len >= (two ? 2 : 1) * h + 8) for (const f of FRACS) {
    const { x, y } = at(r, f);
    places.push(beside(x, y, true), beside(x, y, false));
  }
  // 3. up a vertical run that holds it
  for (const r of runs) if (r.vertical && r.len >= w + 10) for (const f of FRACS) {
    const { x, y } = at(r, f);
    if (two) places.push(upAstride(x, y)); else places.push(upLeft(x, y), upRight(x, y));
  }
  // 4. whatever run is left, fitting or not
  for (const r of runs) if (!r.vertical) {
    const { x, y } = at(r, 0.5);
    places.push(two ? astride(x, y) : above(x, y));
  }
  for (const place of places) if (!obstacles.some((o) => overlap(place.rect, o))) return place;
  // Nowhere at all (a wire of no length): at its start.
  const p = pts[0] || { x: 0, y: 0 };
  return places[0] || (two ? astride(p.x, p.y) : above(p.x, p.y));
}

const FlowRouter = { routeAll, routeOne, placeLabel, crosses, castRay, DEFAULTS };
root.FlowRouter = FlowRouter;
if (typeof module !== 'undefined' && module.exports) module.exports = FlowRouter;
})(typeof window !== 'undefined' ? window : globalThis);
