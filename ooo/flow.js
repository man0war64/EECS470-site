/* The pipeline layout: the whole machine as one strip, fetch on the
 * left to complete on the right, one column per stage, on a canvas that is
 * zoomed and panned — fit the whole pipeline on screen, or zoom into the
 * vertical slice that is one stage.
 *
 *            FETCH      RENAME & DISPATCH (D)    ISSUE (S)   EXECUTE (X)   MEMORY*    COMPLETE (C)
 *   flow   ┌ b.pred* ┐  ┌ phys. ┐ ┌ map   ┐     ┌ reserv. ┐ ┌ func.   ┐ ┌ d-cache* ┐ ┌ complete ┐
 *   lane   │ i-cache*│  │ regs  │ └ table ┘     │ stations│ │ units   │ │ store b.*│ │ buffer   │
 *          │ queue   │  └───────┘               └─────────┘ └─────────┘ └──────────┘ └──────────┘
 *   commit │ (room   │  ┌ free  ┐ ┌──── reorder buffer (R) ────┐              [arch state*]
 *   lane   └ to grow)┘  └ list ─┘ └────────────────────────────┘
 *     (the ROB is in no stage: it lies across rename & dispatch and issue, under the map table and the
 *      stations; the register file's column runs on down past it, with the free list under the register
 *      file; and the fetch column is free to grow downwards: predictor, cache, queue)
 *   bus    ══════════ CDB: a rail along the bottom, tapped straight up from wherever ══════════
 *   ┈┈┈ outside the canvas, not zoomed: the pipeline diagram and this cycle's events ┈┈┈
 *   (* planned: drawn only with "show planned stages", or when the machine has one)
 *
 * It is the second layout, beside the lecture slide.  The boxes that are not
 * tables of the viewer's — the queue, the register file, the units, the
 * complete buffer — are filled in by datapath.js; this file places them all
 * and draws the wires.
 *
 * What makes it extensible is that nothing is placed or drawn by hand:
 *
 *   STAGES   the columns, left to right
 *   STRUCTS  the boxes: which stage (and sub-column) or lane each is in
 *   WIRES    { id, from, to, label, on: [event kinds], stall }
 *   MOVES    which structures an instruction's token slides between
 *
 * The grid is generated from the first two (a gutter between every two
 * columns and a channel between every two lanes, sized by how many wires
 * run in them), and the wires are routed through those by flow-router.js.
 * A new stage is an entry in STAGES, its boxes in STRUCTS and its wires in
 * WIRES — see docs/ADDING_A_STAGE.md.
 */

'use strict';

window.Flow = (() => {
  const { S, $, el } = window.OoO;
  const Router = window.FlowRouter;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TAG_RE = /^p\d+$/;

  /* ---------------- the registry ---------------- */

  /* The columns.  `letter`: the column of the timing table that happens
   * here; `on`: the event kinds that light the stage's header. */
  const STAGES = [
    { id: 'fetch',    label: 'Fetch' },
    { id: 'rename',   label: 'Rename & dispatch', letter: 'D', on: ['DISPATCH'] },
    { id: 'issue',    label: 'Issue',             letter: 'S', on: ['ISSUE'] },
    { id: 'execute',  label: 'Execute',           letter: 'X', on: ['EXECUTE'] },
    { id: 'memory',   label: 'Memory' },
    { id: 'complete', label: 'Complete',          letter: 'C', on: ['COMPLETE'] },
  ];
  /* The commit lane: not a stage, and with no header of its own — the ROB
   * says what it is.  `R` still zooms in on it. */
  const COMMIT = { id: 'commit', label: 'Commit, in order', letter: 'R', on: ['RETIRE'] };

  /* The boxes.  A box of the flow lane names its `stage`, and its `sub`-column
   * there (boxes that share one stack, in this order); one of the commit lane
   * names what it sits `under` — stages, or 'stage:sub' for one sub-column —
   * and spans them: it belongs to no stage; `lane: 'bus'` is the rail.
   *   panel    the class of the element in index.html that is the box; without
   *            one a panel is generated, titled `title`, showing `text` or
   *            whatever `render(c, body, { blank })` draws
   *   planned  not in the machine yet: shown with "show planned stages", or
   *            once `enabled(config)` says the machine has one
   *   stall    the stall reason that means this box is full / empty / busy
   *   waits    instructions waiting for an operand are noted here
   *   token    the elements (each with data-insn) a token slides from and to */
  const STRUCTS = [
    { id: 'bpred',  stage: 'fetch', planned: true, title: 'Branch predictor',
      text: 'Guesses the next PC, so fetch does not wait for a branch to execute.' },
    { id: 'icache', stage: 'fetch', planned: true, title: 'Instruction cache',
      text: 'Fetch reads instructions from here; a miss stalls the front of the pipeline.' },
    { id: 'queue',  stage: 'fetch', panel: 'iq-panel', token: '#iq-items .iq-item[data-insn]' },
    { id: 'prf',    stage: 'rename', panel: 'prf-panel' },
    { id: 'free',   stage: 'rename', panel: 'free-panel', stall: 'FREE_LIST_EMPTY' },
    { id: 'map',    stage: 'rename', sub: 1, panel: 'map-panel', stall: 'REG_BUSY' },      // no renaming: the name is taken
    { id: 'rs',     stage: 'issue', panel: 'rs-panel', stall: 'RS_FULL', waits: true, token: '#rs-table tr[data-insn]' },
    { id: 'alu',    stage: 'execute', panel: 'alu-panel', stall: 'NO_FUNCTIONAL_UNIT', token: '#alu-units .alu-chip[data-insn]' },
    { id: 'dcache', stage: 'memory', planned: true, title: 'Data cache',
      text: 'Loads read it, at the address execute computed; a miss takes many cycles.' },
    { id: 'storebuf', stage: 'memory', planned: true, title: 'Store buffer',
      text: 'A store waits here until it retires: memory is only ever written in order.' },
    { id: 'cbuf',   stage: 'complete', panel: 'cbuf-panel', stall: 'CDB_BUSY', token: '#cbuf .cbuf-chip[data-insn]' },
    { id: 'rob',    lane: 'commit', under: ['rename:1', 'issue'], panel: 'rob-panel', stall: 'ROB_FULL', token: '#rob-table tr[data-insn]' },
    { id: 'archstate', lane: 'commit', under: ['memory'], planned: true, title: 'Architectural state',
      text: 'What is committed: the state to go back to after a misprediction or an exception.' },
    { id: 'cdb',    lane: 'bus', panel: 'cdb-panel' },
  ];

  /* The wires.  `on`: the event kinds that light it; `stall`: the stall
   * reason that paints it red (OPERAND_NOT_READY: a stall on a tag). */
  const WIRES = [
    { id: 'rename',    from: 'queue', to: 'map',  label: 'rename', on: ['DISPATCH'] },
    { id: 'newtag',    from: 'free',  to: 'map',  label: 'new T', on: ['DISPATCH'], stall: 'FREE_LIST_EMPTY' },
    { id: 'alloc',     from: 'queue', to: 'rob',  label: 'allocate (D): T, Told', on: ['DISPATCH'], stall: 'ROB_FULL' },
    { id: 'place',     from: 'map',   to: 'rs',   label: 'to a station: op, T, T1, T2', on: ['DISPATCH'], stall: 'RS_FULL' },
    { id: 'issue',     from: 'rs',    to: 'alu',  label: 'issue (S)', on: ['ISSUE', 'EXECUTE'], stall: 'NO_FUNCTIONAL_UNIT' },
    { id: 'operands',  from: 'prf',   to: 'alu',  label: 'read operands T1, T2', on: ['EXECUTE'] },
    { id: 'result',    from: 'alu',   to: 'cbuf', label: 'result', on: ['COMPLETE'] },
    { id: 'broadcast', from: 'cbuf',  to: 'cdb',  label: 'complete (C): broadcast T', on: ['COMPLETE'], stall: 'CDB_BUSY' },
    { id: 'writeback', from: 'cdb',   to: 'prf',  label: 'write value, set +', on: ['COMPLETE'] },
    { id: 'wakeup',    from: 'cdb',   to: 'rs',   label: 'wake up T1 / T2', on: ['COMPLETE'], stall: 'OPERAND_NOT_READY' },
    { id: 'mapready',  from: 'cdb',   to: 'map',  label: 'ready bit +', on: ['COMPLETE'] },
    { id: 'robdone',   from: 'cdb',   to: 'rob',  label: 'record C', on: ['COMPLETE'] },
    { id: 'retire',    from: 'rob',   to: 'free', label: 'retire (R): Told → free list', on: ['RETIRE'] },
    // Planned: drawn, faintly, when both ends are on screen; never lit.
    { id: 'nextpc',      from: 'bpred',    to: 'icache',    label: 'predicted PC', planned: true },
    { id: 'fetched',     from: 'icache',   to: 'queue',     label: 'instruction', planned: true },
    { id: 'redirect',    from: 'alu',      to: 'bpred',     label: 'branch resolved: redirect, train', planned: true },
    { id: 'address',     from: 'alu',      to: 'dcache',    label: 'address', planned: true },
    { id: 'loadvalue',   from: 'dcache',   to: 'cbuf',      label: 'load value', planned: true },
    { id: 'storewrite',  from: 'storebuf', to: 'dcache',    label: 'write', planned: true },
    { id: 'retirestore', from: 'rob',      to: 'storebuf',  label: 'retire a store', planned: true },
    { id: 'commitstate', from: 'rob',      to: 'archstate', label: 'commit', planned: true },
  ];

  /* Tokens: on an event of this kind the instruction's chip slides from where
   * it was drawn in `from` to where it is drawn now in `to` (`box: true`: to
   * the box itself — a retiring instruction hands its Told to the free list). */
  const MOVES = [
    { on: 'DISPATCH', from: 'queue', to: 'rob' },
    { on: 'DISPATCH', from: 'queue', to: 'rs' },
    { on: 'EXECUTE',  from: 'rs',    to: 'alu' },
    { on: 'COMPLETE', from: 'alu',   to: 'cbuf' },
    { on: 'RETIRE',   from: 'rob',   to: 'free', box: true },
  ];

  const ZOOM_MIN = 0.3, ZOOM_MAX = 3, ZOOM_STEP = 0.1, FIT_MAX = 1.25, FOCUS_MAX = 2.2;
  const GUTTER_MIN = 60, GUTTER_EMPTY = 40, CHANNEL_MIN = 38;
  const LABEL_H = 12, LABEL_CH = 5.9;         // the size of a label, for placing it: 10px bold sans
  const OPTS = Router.DEFAULTS;

  const on = () => S.view.layout === 'flow';
  const planned = () => !!S.view.flowPlanned;
  const node = (s) => s.node || (s.panel ? document.querySelector('.' + s.panel) : null);
  /** "what: detail" is drawn as two short lines, one either side of the
   *  wire, so a long label does not need a long run (or a wide gutter). */
  const labelLines = (text) => { const parts = text.split(/:\s+/); return parts.length === 2 ? parts : [text]; };
  const labelWidth = (text) => Math.max(...labelLines(text).map((t) => t.length)) * LABEL_CH + 6;

  function svgEl(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    return n;
  }

  /* ---------------- the grid, from the registry ---------------- */

  function enabled(s) {
    if (!s.planned) return true;
    if (planned()) return true;
    try { return !!(s.enabled && S.trace && s.enabled(S.trace.config)); } catch (_) { return false; }
  }

  /** The grid the registry describes right now:
   *    cols     [{ stage, sub, structs }]          left to right
   *    stages   [{ ...stage, first, last }]         the columns each spans
   *    place    { struct id: { c0, c1, lane, k } }  columns spanned, stack index
   *  Column i is grid column 2i + 2; gutter i, to its left, is 2i + 1.  Rows:
   *  1 the headers, 2 the top channel, 3 the flow lane, 4 the middle channel,
   *  5 the commit lane, 6 the low channel, 7 the bus.  The boxes of a column
   *  that has several are one item of the grid, a stack (build()), so how
   *  tall one column's boxes are never moves another column's. */
  function plan() {
    const structs = STRUCTS.filter(enabled);
    const cols = [], stages = [], place = {};
    for (const st of STAGES) {
      const mine = structs.filter((s) => s.stage === st.id);
      if (!mine.length) continue;
      const first = cols.length;
      for (const sub of [...new Set(mine.map((s) => s.sub || 0))].sort((a, b) => a - b)) {
        const stack = mine.filter((s) => (s.sub || 0) === sub);
        stack.forEach((s, k) => { place[s.id] = { c0: cols.length, c1: cols.length, lane: 'flow', k, of: stack.length }; });
        cols.push({ stage: st.id, sub, structs: stack });
      }
      stages.push({ ...st, first, last: cols.length - 1 });
    }
    for (const s of structs) {
      if (s.lane === 'commit') {
        // `under`: whole stages ('issue'), or one sub-column of one ('rename:1').
        const under = [];
        cols.forEach((col, i) => {
          if ((s.under || []).some((u) => u === col.stage || u === `${col.stage}:${col.sub}`)) under.push(i);
        });
        if (!under.length) continue;
        place[s.id] = { c0: Math.min(...under), c1: Math.max(...under), lane: 'commit' };
      } else if (s.lane === 'bus') {
        place[s.id] = { c0: 0, c1: Math.max(0, cols.length - 1), lane: 'bus' };
      }
    }
    // The commit lane is not a floor under the whole flow lane: a column with
    // nothing of the commit lane under it runs on down through it, so the
    // commit lane's boxes sit right under the (shorter) boxes they are under,
    // however tall a stack elsewhere is.
    cols.forEach((col, i) => {
      col.open = !Object.values(place).some((at) => at.lane === 'commit' && at.c0 <= i && i <= at.c1);
    });
    const rows = { head: 1, top: 2, lane: 3, mid: 4, commit: 5, low: 6, bus: 7 };
    return { structs: structs.filter((s) => place[s.id]), cols, stages, place, rows };
  }

  let built = null;               // { sig, plan, made: [generated elements], marks: { line id: element } }
  let sizes = { key: '', v: {}, h: {} };   // gutter widths and channel heights, from the last routing
  let lastAct = null, lastCycle = null, lastBlank = false;

  function signature() {
    return [STAGES.map((s) => s.id).join(','), STRUCTS.filter(enabled).map((s) => s.id).join(','),
            WIRES.length, planned() ? 'P' : ''].join('|');
  }

  function teardown() {
    if (!built) return;
    $('flow-wires').replaceChildren();
    $('flow-tokens').replaceChildren();
    if ($('flow-nav')) $('flow-nav').replaceChildren();
    $('flow-canvas').style.gridTemplateColumns = '';
    $('flow-canvas').style.gridTemplateRows = '';
    // The panels only this layout shows go back to being empty: hidden is
    // not enough in quiz mode, where the answers must not be in the page.
    for (const id of ['iq-items', 'alu-units', 'cbuf']) $(id).replaceChildren();
    $('prf').tBodies[0].replaceChildren();
    for (const id of ['prf', 'alu', 'cbuf']) { $(id + '-note').textContent = ''; $(id + '-panel').removeAttribute('title'); }
    // Out of the stacks, back to where each box was, last moved first.
    for (const m of [...built.moved].reverse()) m.parent.insertBefore(m.n, m.next);
    for (const n of built.made) n.remove();
    for (const s of STRUCTS) {
      const n = node(s);
      if (n && !s.node) {
        if (n.classList.contains('pipeline-only')) n.hidden = true;      // the slide layout does not have it
        n.removeAttribute('data-flow');
        n.style.removeProperty('--fc');
        n.style.removeProperty('--fr');
        n.classList.remove('stalled');
        delete n.dataset.stall;
      }
      delete s.node;
    }
    built = null;
  }

  /** Generate what is not in index.html — the stage bands and headers, the
   *  panels of the boxes that have none, the markers the gutters and channels
   *  are measured by — and tell every box its place in the grid. */
  function build() {
    const sig = signature();
    if (built && built.sig === sig) return built;
    teardown();
    const canvas = $('flow-canvas');
    const p = plan();
    const made = [], marks = {};
    const add = (n, col, row) => {
      n.classList.add('flow-only');
      n.style.gridColumn = col;
      n.style.gridRow = row;
      canvas.append(n);
      made.push(n);
      return n;
    };
    const gridCol = (i) => 2 * i + 2;

    p.stages.forEach((st, i) => {
      const span = `${gridCol(st.first)} / ${gridCol(st.last) + 1}`;
      const band = add(el('div', 'flow-band'), span, `${p.rows.head} / ${p.rows.bus}`);
      band.dataset.stage = st.id;
      if (!p.cols.slice(st.first, st.last + 1).some((c) => c.structs.some((s) => !s.planned))) band.classList.add('planned');
      add(stageButton(st, i + 1), span, String(p.rows.head));
    });

    // A column of several boxes is one item of the grid: a stack, which the
    // boxes are moved into (and out of again, to where they were, by teardown).
    const stacks = p.cols.map((c, i) => (c.structs.length > 1
      ? add(el('div', 'flow-stack'), String(gridCol(i)), `${p.rows.lane} / ${c.open ? p.rows.low : p.rows.mid}`) : null));
    const moved = [];
    for (const s of p.structs) {
      const at = p.place[s.id];
      let n = node(s);
      if (!n) {
        n = el('section', 'panel flow-gen' + (s.planned ? ' flow-ghost' : ''));
        n.append(el('h2', 'panel-h', s.title || s.id));
        if (s.planned) n.querySelector('h2').append(' ', el('span', 'dim', 'planned'));
        n.append(el('div', 'flow-gen-body', s.text || ''));
        n.classList.add('flow-only');
        canvas.append(n);
        made.push(n);
        s.node = n;
      }
      n.dataset.flow = s.id;
      const col = at.lane === 'bus' ? '1 / -1' : `${gridCol(at.c0)} / ${gridCol(at.c1) + 1}`;
      // A column with nothing of the commit lane under it runs on down past it.
      const row = at.lane === 'bus' ? String(p.rows.bus) : at.lane === 'commit' ? String(p.rows.commit)
        : `${p.rows.lane} / ${p.cols[at.c0].open ? p.rows.low : p.rows.mid}`;
      n.style.setProperty('--fc', col);
      n.style.setProperty('--fr', row);
      const stack = at.lane === 'flow' ? stacks[at.c0] : null;
      if (stack) {
        if (!s.node) moved.push({ n, parent: n.parentNode, next: n.nextSibling });
        stack.append(n);
      }
    }

    for (let i = 0; i <= p.cols.length; i++) {
      marks['V' + i] = add(el('i', 'flow-mark'), String(2 * i + 1), `${p.rows.top} / ${p.rows.bus}`);
    }
    for (const [id, row] of [['H0', p.rows.top], ['H1', p.rows.mid], ['H2', p.rows.low]]) {
      marks[id] = add(el('i', 'flow-mark'), '1 / -1', String(row));
    }
    built = { sig, plan: p, made, marks, moved };
    sizes = { key: '', v: {}, h: {} };
    applyTemplate();
    buildNav();
    return built;
  }

  function stageButton(st, n) {
    const b = el('button', 'flow-stage');
    b.type = 'button';
    b.dataset.stage = st.id;
    b.title = `Zoom in on ${st.label}${typeof n === 'number' && n <= 9 ? ` (key ${n})` : ''}`;
    b.append(el('span', 'flow-stage-n', String(n)), el('span', 'flow-stage-name', st.label));
    if (st.letter) {
      const k = el('span', 'flow-stage-key', st.letter);
      k.dataset.letter = st.letter;
      b.append(k);
    }
    b.addEventListener('click', () => focus(st.id));
    return b;
  }

  /** The buttons over the canvas: one per stage, and the whole pipeline. */
  function buildNav() {
    const nav = $('flow-nav');
    if (!nav) return;
    nav.replaceChildren();
    const fitB = el('button', 'flow-nav-b', 'Whole pipeline');
    fitB.type = 'button';
    fitB.title = 'Fit the whole pipeline on screen (0)';
    fitB.dataset.stage = '';
    fitB.addEventListener('click', fit);
    nav.append(fitB);
    built.plan.stages.forEach((st, i) => {
      const b = el('button', 'flow-nav-b', `${i + 1} ${st.label}`);
      b.type = 'button';
      b.dataset.stage = st.id;
      b.title = `Zoom in on ${st.label} (${i + 1})`;
      b.addEventListener('click', () => focus(st.id));
      nav.append(b);
    });
  }

  /** The grid's tracks: a gutter, a column, a gutter, …; the rows as plan()
   *  numbers them.  Gutters and channels are as wide as the last routing
   *  found they need to be. */
  function applyTemplate() {
    const p = built.plan, canvas = $('flow-canvas');
    const colsT = [];
    for (let i = 0; i <= p.cols.length; i++) {
      colsT.push(`${sizes.v['V' + i] || GUTTER_MIN}px`);
      if (i < p.cols.length) colsT.push('max-content');
    }
    // The flow lane is as tall as the boxes that have the commit lane under
    // them; the commit lane takes up whatever a taller column beside it needs.
    const rowsT = ['auto', `${sizes.h.H0 || CHANNEL_MIN}px`, 'auto', `${sizes.h.H1 || CHANNEL_MIN}px`, '1fr',
                   `${sizes.h.H2 || CHANNEL_MIN}px`, 'auto'];
    canvas.style.gridTemplateColumns = colsT.join(' ');
    canvas.style.gridTemplateRows = rowsT.join(' ');
  }

  /* ---------------- what happened: events -> lit wires, stages, stalls ---------------- */

  /** { lit: Set(wire id), stages: Set(stage id), stalls: Map(wire id -> [text]),
   *    boxes: Map(struct id -> [text]) } */
  function activity(c, blank) {
    const lit = new Set(), stages = new Set(), stalls = new Map(), boxes = new Map();
    const note = (map, key, text) => {
      const list = map.get(key) || [];
      if (text && !list.includes(text)) list.push(text);
      map.set(key, list);
    };
    if (blank) return { lit, stages, stalls, boxes };
    const D = window.Datapath;
    for (const e of D.eventsInScope(c)) {
      if (e.kind === 'STALL') {
        const why = e.blocking;
        if (why && TAG_RE.test(why)) {
          for (const w of WIRES) if (w.stall === 'OPERAND_NOT_READY') note(stalls, w.id, null);
          for (const s of STRUCTS) if (s.waits) note(boxes, s.id, `I${e.insn_idx} waits for ${why}`);
        } else if (why) {
          const what = D.stallText(why, e.insn_idx) || why;
          for (const s of STRUCTS) if (s.stall === why) note(boxes, s.id, what);
          for (const w of WIRES) if (w.stall === why) note(stalls, w.id, e.insn_idx === null ? what : `I${e.insn_idx}: ${what}`);
        }
        continue;
      }
      for (const w of WIRES) if (w.on && w.on.includes(e.kind)) lit.add(w.id);
      for (const st of [...STAGES, COMMIT]) if (st.on && st.on.includes(e.kind)) stages.add(st.id);
    }
    return { lit, stages, stalls, boxes };
  }

  /* ---------------- geometry ---------------- */

  /** Client rectangles come back scaled by the canvas's zoom; the overlays'
   *  own units are not. */
  function origin() {
    const r = $('flow-canvas').getBoundingClientRect();
    return { left: r.left, top: r.top, z: zoom() };
  }

  function rectOf(n, o) {
    const r = n.getBoundingClientRect();
    const left = (r.left - o.left) / o.z, top = (r.top - o.top) / o.z;
    const width = r.width / o.z, height = r.height / o.z;
    return { left, top, right: left + width, bottom: top + height, width, height,
             cx: left + width / 2, cy: top + height / 2 };
  }

  /** The boxes and lines the router works on, measured off the page. */
  function measure() {
    const o = origin();
    const boxes = {};
    for (const s of built.plan.structs) {
      const n = node(s);
      if (!n || n.hidden) continue;
      boxes[s.id] = rectOf(n, o);
      if (s.lane === 'bus') boxes[s.id].wide = true;
    }
    const m = {};
    for (const [id, n] of Object.entries(built.marks)) m[id] = rectOf(n, o);
    const rail = Object.values(boxes).find((b) => b.wide);
    const n = built.plan.cols.length;
    const lines = [];
    for (let i = 0; i <= n; i++) lines.push({ id: 'V' + i, o: 'v', c: m['V' + i].cx, a: m.H0.cy, b: rail ? rail.top : m.H2.cy });
    for (const id of ['H0', 'H1', 'H2']) lines.push({ id, o: 'h', c: m[id].cy, a: m.V0.cx, b: m['V' + n].cx });
    return { boxes, lines, marks: m };
  }

  /** How wide each gutter and how tall each channel has to be: a track per
   *  wire that runs in it, and room for the label of a wire that lives in
   *  that gutter alone (a straight wire between two neighbours). */
  function needed(routed, geo) {
    const v = {}, h = {};
    for (const [id, n] of Object.entries(routed.tracks)) {
      // A gutter nothing runs along is only a gap (or holds a straight wire
      // across it, whose label sizes it below).
      if (id[0] === 'V') v[id] = n ? Math.max(GUTTER_MIN, 36 + n * OPTS.trackV) : GUTTER_EMPTY;
      else h[id] = Math.max(CHANNEL_MIN, 22 + n * OPTS.trackH);
    }
    for (const wire of WIRES) {
      const r = routed.routes.get(wire.id);
      if (!r || r.pts.length < 2) continue;
      // A wire with a vertical run that holds its label needs no room
      // beside it: the label reads up the run.
      const w = labelWidth(wire.label);
      let across = 0, up = 0;
      r.pts.forEach((p, i) => {
        if (!i) return;
        across = Math.max(across, Math.abs(p.x - r.pts[i - 1].x));
        up = Math.max(up, Math.abs(p.y - r.pts[i - 1].y));
      });
      if (up >= w + 10) continue;
      // A short wire across one gutter: the gutter is as wide as lets the
      // wire's longest level run hold the label.  (What of that run is
      // outside the gutter does not change with the gutter, so this settles.)
      const xs = r.pts.map((p) => p.x), lo = Math.min(...xs), hi = Math.max(...xs);
      const crossed = Object.entries(geo.marks).filter(([id, m]) => id[0] === 'V' && m.right > lo + 1 && m.left < hi - 1);
      if (crossed.length !== 1) continue;
      const [id, m] = crossed[0];
      v[id] = Math.max(v[id] || GUTTER_EMPTY, Math.ceil(w + 24 - Math.max(0, across - m.width)));
    }
    return { v, h };
  }

  /* ---------------- the wires ---------------- */

  function visibleWires() {
    const have = new Set(built.plan.structs.map((s) => s.id));
    return WIRES.filter((w) => have.has(w.from) && have.has(w.to));
  }

  function drawWires(act) {
    const svg = $('flow-wires');
    svg.replaceChildren();
    if (!on() || !built) return;
    const wires = visibleWires();
    let geo = measure();
    let routed = Router.routeAll(wires, geo.boxes, geo.lines);
    // The gutters and channels are sized by what runs in them; when that
    // changed, lay the grid out again and route on the new geometry — which
    // may move a wire to another gutter, so until it settles (a few rounds).
    let resized = false;
    for (let round = 0; round < 4; round++) {
      const need = needed(routed, geo);
      const key = JSON.stringify(need);
      if (key === sizes.key) break;
      sizes = { key, v: need.v, h: need.h };
      applyTemplate();
      geo = measure();
      routed = Router.routeAll(wires, geo.boxes, geo.lines);
      resized = true;
    }
    if (resized) {
      // A canvas of another width fits at another zoom, and text does not
      // scale to the pixel: measure once more at the zoom it ends up at.
      const before = zoom();
      afterResize();
      if (zoom() !== before) {
        geo = measure();
        routed = Router.routeAll(wires, geo.boxes, geo.lines);
      }
    }

    const defs = svgEl('defs');
    for (const kind of ['plain', 'lit', 'stalled']) {
      const m = svgEl('marker', { id: 'flow-head-' + kind, viewBox: '0 0 10 10', refX: 9, refY: 5,
                                  markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
      m.setAttribute('class', 'head ' + kind);
      m.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z' }));
      defs.append(m);
    }
    svg.append(defs);
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const obstacles = Object.values(geo.boxes).map((b) => ({ left: b.left - 2, right: b.right + 2, top: b.top - 2, bottom: b.bottom + 2 }));
    // A label stays on the canvas: off its edges is as taken as a box is.
    const edge = rectOf($('flow-canvas'), origin()), FAR = 1e5;
    if (edge.width > 0) {
      obstacles.push({ left: -FAR, right: 2, top: -FAR, bottom: FAR }, { left: edge.width - 2, right: FAR, top: -FAR, bottom: FAR },
                     { left: -FAR, right: FAR, top: -FAR, bottom: 2 }, { left: -FAR, right: FAR, top: edge.height - 2, bottom: FAR });
    }

    // The wires that are lit or stalled go on top, and get first pick of
    // where their labels go.
    const active = (w) => act.lit.has(w.id) || act.stalls.has(w.id);
    const groups = new Map();
    for (const w of [...wires.filter(active), ...wires.filter((w) => !active(w))]) {
      const lit = act.lit.has(w.id), stalled = !lit && act.stalls.has(w.id);
      const r = routed.routes.get(w.id);
      const g = svgEl('g', { 'data-wire': w.id });
      g.setAttribute('class', 'wire' + (lit ? ' lit' : '') + (stalled ? ' stalled' : '') + (w.planned ? ' planned' : ''));
      let pts = r ? r.pts : null;
      if (!pts || pts.length < 2) {
        // No way through (or nothing measured): a straight line, centre to centre.
        const a = geo.boxes[w.from], b = geo.boxes[w.to];
        pts = [{ x: a ? a.cx : 0, y: a ? a.cy : 0 }, { x: b ? b.cx : 0, y: b ? b.cy : 0 }];
        if (!r) g.setAttribute('data-unrouted', '');
      }
      const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      g.append(svgEl('path', { d, 'marker-end': `url(#flow-head-${lit ? 'lit' : stalled ? 'stalled' : 'plain'})` }));
      const texts = labelLines(w.label);
      const L = Router.placeLabel(pts, labelWidth(w.label), LABEL_H, obstacles, texts.length);
      obstacles.push(L.rect);
      texts.forEach((text, k) => {
        const at = k ? L.second : L;
        const label = svgEl('text', { x: at.x.toFixed(1), y: at.y.toFixed(1), 'text-anchor': L.anchor });
        if (L.rotate) label.setAttribute('transform', `rotate(-90 ${at.x.toFixed(1)} ${at.y.toFixed(1)})`);
        label.setAttribute('class', 'label');
        label.textContent = text;
        g.append(label);
      });
      const why = act.stalls.get(w.id);
      if (why && why.length) {
        // Under the label; beside it (further from the wire's left) when it reads upwards.
        const last = L.second || L;
        const t = L.rotate ? svgEl('text', { x: (last.x + 13).toFixed(1), y: last.y.toFixed(1), 'text-anchor': L.anchor,
                                             transform: `rotate(-90 ${(last.x + 13).toFixed(1)} ${last.y.toFixed(1)})` })
          : svgEl('text', { x: last.x.toFixed(1), y: (last.y + 13).toFixed(1), 'text-anchor': L.anchor });
        t.setAttribute('class', 'stall-label');
        t.textContent = '⊘ ' + why.join(' · ');
        g.append(t);
      }
      if (lit && !reduced) {
        const dot = svgEl('circle', { r: 4 });
        dot.setAttribute('class', 'pulse');
        dot.append(svgEl('animateMotion', { dur: '1.1s', repeatCount: 'indefinite', path: d }));
        g.append(dot);
      }
      const title = svgEl('title');
      title.textContent = w.label + (w.planned ? ' (planned)' : '') + (why && why.length ? ' — ' + why.join('; ') : '');
      g.append(title);
      groups.set(w.id, g);
    }
    for (const w of [...wires.filter((w) => !active(w)), ...wires.filter(active)]) svg.append(groups.get(w.id));
  }

  /** Re-route after the boxes moved (a resize, a font load). */
  function layout() {
    if (on() && built && lastAct) { drawWires(lastAct); afterResize(); }
  }

  /** …and, a moment after the zoom changed: text does not scale to the pixel,
   *  so the boxes are not quite where they were measured. */
  let pending = null;
  function layoutSoon() {
    if (typeof setTimeout !== 'function') return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; layout(); }, 120);
  }

  /* ---------------- tokens: chips that slide between structures ---------------- */

  /** Where each instruction is drawn right now, keyed by structure. */
  function snapshot() {
    const out = new Map();
    if (!on() || !built) return out;
    const o = origin();
    for (const s of STRUCTS) {
      if (!s.token) continue;
      for (const n of document.querySelectorAll(s.token)) out.set(`${s.id}:${n.dataset.insn}`, rectOf(n, o));
    }
    return out;
  }

  function animateTokens(before, c) {
    const host = $('flow-tokens');
    host.replaceChildren();
    if (!before || !before.size) return;
    if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const now = snapshot();
    const o = origin();
    const duration = S.playing ? Math.min(450, Number($('speed').value) * 0.7) : 450;
    for (const e of c.events) {
      if (e.insn_idx === null) continue;
      if (e.kind === 'EXECUTE' && !/began execution/.test(e.detail)) continue;   // the X-bypass note
      for (const m of MOVES) {
        if (m.on !== e.kind) continue;
        const from = before.get(`${m.from}:${e.insn_idx}`);
        const target = STRUCTS.find((s) => s.id === m.to);
        const to = m.box ? (target && node(target) && rectOf(node(target), o)) : now.get(`${m.to}:${e.insn_idx}`);
        if (!from || !to) continue;
        const chip = el('span', 'token', `I${e.insn_idx}`);
        host.append(chip);
        const w = chip.offsetWidth || 28, h = chip.offsetHeight || 18;
        const x1 = from.left + Math.min(40, from.width / 2) - w / 2, y1 = from.cy - h / 2;
        const x2 = to.left + Math.min(40, to.width / 2) - w / 2, y2 = to.cy - h / 2;
        const anim = chip.animate([
          { transform: `translate(${x1}px, ${y1}px)`, opacity: 0.2 },
          { transform: `translate(${x1}px, ${y1}px)`, opacity: 1, offset: 0.15 },
          { transform: `translate(${x2}px, ${y2}px)`, opacity: 1, offset: 0.85 },
          { transform: `translate(${x2}px, ${y2}px)`, opacity: 0 },
        ], { duration, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
        anim.onfinish = () => chip.remove();
      }
    }
  }

  /* ---------------- the viewport: zoom, pan, focus a stage ---------------- */

  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  let fitZoom = 1;

  /** The zoom the canvas is drawn at: a number, or the one that fits the
   *  whole pipeline across the viewport ('fit', the default). */
  function zoom() {
    const z = S.view.flowZoom;
    return typeof z === 'number' && Number.isFinite(z) && z > 0 ? clampZoom(z) : fitZoom;
  }

  /** The canvas's own width, whatever it is zoomed to right now. */
  function naturalWidth() {
    const canvas = $('flow-canvas');
    const applied = Number(canvas.style.zoom) || 1;
    return canvas.getBoundingClientRect().width / applied;
  }

  function computeFit() {
    const vw = $('flow-viewport').clientWidth, w = naturalWidth();
    fitZoom = vw > 0 && w > 0 ? Math.min(FIT_MAX, clampZoom((vw - 4) / w)) : 1;
  }

  function applyZoom() {
    const canvas = $('flow-canvas');
    if (!on()) { canvas.style.zoom = ''; return; }
    canvas.style.zoom = String(Math.round(zoom() * 1000) / 1000);
    const fitted = typeof S.view.flowZoom !== 'number';
    $('zoom-readout').textContent = `${fitted ? 'fit ' : ''}${Math.round(zoom() * 100)}%`;
    $('zoom-readout').title = 'Fit the whole pipeline (0)';
    $('btn-zoom-in').disabled = zoom() >= ZOOM_MAX;
    $('btn-zoom-out').disabled = zoom() <= ZOOM_MIN;
    const nav = $('flow-nav');
    if (nav) for (const b of nav.children) b.classList.toggle('current', (b.dataset.stage || '') === (fitted ? '' : focused || '?'));
  }

  /** After the canvas changed size: the zoom that fits is another one. */
  function afterResize() {
    if (!on()) return;
    computeFit();
    applyZoom();
  }

  let focused = null;             // the stage zoomed in on, until the zoom changes by hand

  /** Zoom to `z`, keeping the point of the canvas at (cx, cy) of the
   *  viewport (its centre by default) where it is. */
  function setZoom(z, cx, cy) {
    const vp = $('flow-viewport');
    const before = zoom();
    if (cx === undefined) { cx = vp.clientWidth / 2; cy = vp.clientHeight / 2; }
    const px = (vp.scrollLeft + cx) / before, py = (vp.scrollTop + cy) / before;
    S.view.flowZoom = Math.round(clampZoom(z) * 100) / 100;
    focused = null;
    window.OoO.saveView();
    applyZoom();
    vp.scrollLeft = px * zoom() - cx;
    vp.scrollTop = py * zoom() - cy;
    layoutSoon();
  }

  const zoomBy = (steps) => setZoom(Math.round((zoom() + steps * ZOOM_STEP) * 10) / 10);

  /** The whole pipeline, side to side. */
  function fit() {
    S.view.flowZoom = 'fit';
    focused = null;
    window.OoO.saveView();
    computeFit();
    applyZoom();
    const vp = $('flow-viewport');
    vp.scrollLeft = 0;
    vp.scrollTop = 0;
  }

  /** Zoom in on one stage: its boxes fill the viewport.  'commit' is the
   *  commit lane's boxes. */
  function focus(stageId) {
    if (!on() || !built) return;
    const vp = $('flow-viewport'), o = origin();
    let targets;
    if (stageId === COMMIT.id) {
      targets = built.plan.structs.filter((s) => s.lane === 'commit' && !s.planned).map(node);
    } else {
      // The stage's own boxes, and what sits under it in the commit lane.
      targets = built.plan.structs.filter((s) => s.stage === stageId || (s.under || []).some((u) => u.split(':')[0] === stageId)).map(node);
    }
    targets = targets.filter(Boolean);
    if (!targets.length) return;
    const rs = targets.map((n) => rectOf(n, o));
    const left = Math.min(...rs.map((r) => r.left)), right = Math.max(...rs.map((r) => r.right));
    const top = Math.min(...rs.map((r) => r.top)), bottom = Math.max(...rs.map((r) => r.bottom));
    const margin = 48;
    // As large as shows the whole slice, side to side and top to bottom —
    // but never smaller than life: a slice taller than the window scrolls.
    const room = Math.max(vp.clientHeight, window.innerHeight * 0.7);
    const z = Math.min(FOCUS_MAX, clampZoom(Math.min(vp.clientWidth / (right - left + 2 * margin), room / (bottom - top + margin))));
    S.view.flowZoom = Math.round(Math.max(1, z) * 100) / 100;      // never smaller than life
    window.OoO.saveView();
    focused = stageId;
    applyZoom();
    const zz = zoom();
    layoutSoon();
    vp.scrollLeft = Math.max(0, ((left + right) / 2) * zz - vp.clientWidth / 2);
    vp.scrollTop = Math.max(0, (top - 70) * zz);          // room for the stage's header above its boxes
  }

  let wired = false;
  function wireViewport() {
    const vp = $('flow-viewport');
    if (!vp || wired) return;
    wired = true;
    // Ctrl / ⌘ + wheel (and a trackpad pinch, which arrives as one) zooms
    // about the pointer; a plain wheel scrolls, as anywhere.
    vp.addEventListener('wheel', (e) => {
      if (!on() || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      // A pinch arrives as many small steps, a wheel as a few big ones: no
      // single event changes the zoom by more than a quarter.
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.0035)));
      setZoom(zoom() * factor, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    // Drag pans — from anywhere that is not a control.
    let drag = null;
    vp.addEventListener('pointerdown', (e) => {
      if (!on() || e.button !== 0) return;
      if (e.target.closest && e.target.closest('button, input, select, textarea, a, label')) return;
      drag = { x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop, moved: false, id: e.pointerId };
    });
    vp.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        vp.classList.add('panning');
        if (vp.setPointerCapture) { try { vp.setPointerCapture(drag.id); } catch (_) { /* gone */ } }
      }
      vp.scrollLeft = drag.left - dx;
      vp.scrollTop = drag.top - dy;
    });
    const end = () => { drag = null; vp.classList.remove('panning'); };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);

    const box = $('flow-planned');
    if (box) box.addEventListener('change', () => window.OoO.setView({ flowPlanned: box.checked }));

    document.addEventListener('keydown', (e) => {
      if (!on() || !built || S.view.mode === 'lesson' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target.tagName;
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
      if (e.key === 'Escape') { fit(); e.preventDefault(); return; }
      if (e.key === 'r' || e.key === 'R') { focus(COMMIT.id); e.preventDefault(); return; }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= built.plan.stages.length) { focus(built.plan.stages[n - 1].id); e.preventDefault(); }
    });
    window.addEventListener('resize', () => { if (on()) { afterResize(); layout(); } });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout).catch(() => {});
  }

  /* ---------------- entry points ---------------- */

  /** Called by the viewer's applyView: the parts of the page that are this
   *  layout's alone. */
  function applyView() {
    const active = on();
    const bar = $('flow-bar');
    if (bar) bar.hidden = !active;
    const box = $('flow-planned');
    if (box) box.checked = planned();
    if (!active) { teardown(); $('flow-canvas').style.zoom = ''; $('zoom-readout').title = 'Back to 100%'; return; }
    wireViewport();
    applyZoom();
  }

  /** Called by the viewer after the tables are rendered.  `blank`: quiz mode and this cycle is the student's.  `before`: a
   *  snapshot() from just before the render, when stepping one cycle on. */
  function render(c, { blank = false, before = null } = {}) {
    if (!on()) { teardown(); return; }
    const D = window.Datapath;
    build();
    for (const s of built.plan.structs) {
      const n = node(s);
      if (n && s.panel) n.hidden = false;
    }
    D.renderQueue(c, blank);
    D.renderPRF(c, blank);
    D.renderUnits(c, blank);
    D.renderCbuf(c, blank);
    for (const s of built.plan.structs) {
      if (s.render && s.node) s.render(c, s.node.querySelector('.flow-gen-body'), { blank });
    }
    const act = activity(c, blank);
    lastAct = act; lastCycle = c; lastBlank = blank;
    for (const s of built.plan.structs) {
      const n = node(s);
      if (!n) continue;
      const why = act.boxes.get(s.id);
      n.classList.toggle('stalled', !!(why && why.length));
      if (why && why.length) n.dataset.stall = why.join(' · '); else delete n.dataset.stall;
    }
    for (const b of $('flow-canvas').querySelectorAll('.flow-stage')) b.classList.toggle('active', act.stages.has(b.dataset.stage));
    computeFit();
    applyZoom();
    drawWires(act);
    if (before) animateTokens(before, c);
  }

  /** After the registry changed (a stage, a box or a wire was added): build
   *  the grid again and redraw. */
  function rebuild() {
    teardown();
    if (on() && lastCycle) render(lastCycle, { blank: lastBlank });
  }

  const api = { render, applyView, snapshot, layout, rebuild, activity, plan, zoom, zoomBy, setZoom, fit, focus,
                STAGES, STRUCTS, WIRES, MOVES, COMMIT };

  // The viewer may have drawn its first cycle before this file was loaded.
  window.Flow = api;
  applyView();
  if (on() && S.trace && S.view.mode !== 'lesson') window.OoO.render();
  return api;
})();
