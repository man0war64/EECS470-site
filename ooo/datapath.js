/* The panels of the datapath that are not tables of the viewer's: the
 * instruction queue (fetch), the physical register file, the functional units
 * and the complete buffer.  The pipeline layout (flow.js) places them and
 * draws the wires between them; this file only fills them in.
 *
 * Everything is derived from the trace the viewer already holds — the model
 * and its trace format are untouched: the queue is the program from the first
 * instruction not yet dispatched; the ROB rows fill the functional units (each
 * row says which unit it issued to and when it finishes executing) and the
 * complete buffer; and the register file is read off the free list, the map
 * table and the ROB (its values from the ROB rows, remembered as they go by).
 * In quiz mode the queue, register file, units and buffer show '?' for a
 * cycle the student has to fill in.
 */

'use strict';

window.Datapath = (() => {
  const { S, $, el, unitsOf, describeUnits, DASH } = window.OoO;

  /* How a structural stall reads, on the box that is full / empty / busy. */
  const STALL_TEXT = {
    ROB_FULL: 'ROB full', RS_FULL: 'no free RS', FREE_LIST_EMPTY: 'free list empty',
    REG_BUSY: 'register still in use',
    NO_FUNCTIONAL_UNIT: 'all units busy', CDB_BUSY: 'CDB busy',
  };

  /* ---------------- what happened ---------------- */

  /** The badge for a structural stall.  A functional-unit stall names the
   *  kind of unit the instruction needs ("MUL busy"), since only that kind
   *  is full. */
  function stallText(why, insnIdx) {
    if (why === 'NO_FUNCTIONAL_UNIT' && insnIdx !== null && insnIdx !== undefined) {
      const p = S.trace.program[insnIdx];
      const u = p && unitsOf(S.trace.config).find((k) => k.kind === p.unit);
      if (u) return `${u.abbr}${u.count > 1 ? 's' : ''} busy`;
    }
    return STALL_TEXT[why];
  }

  /** The events that count right now: all of the cycle's, or, when stepping
   *  by event, those up to the current one. */
  function eventsInScope(c) {
    if (S.view.events && !S.quiz && S.sub >= 0) return c.events.slice(0, S.sub + 1);
    return c.events;
  }

  /* ---------------- the instruction queue (fetch) ---------------- */

  /** How many instructions the queue shows: a couple of dispatch groups, at
   *  least four, so the width of the queue does not depend on the program. */
  function queueDepth() {
    const w = S.trace.config.dispatch_width || 1;
    return Math.max(4, 2 * w);
  }

  /** The index of the next instruction to dispatch: the first one whose D
   *  is still in the future.  Dispatch is in program order, so this is
   *  exactly the model's fetch pointer. */
  function nextToDispatch(c) {
    const i = S.trace.program.findIndex((p) => S.trace.summary[p.idx].D === null || S.trace.summary[p.idx].D > c.cycle);
    return i < 0 ? S.trace.program.length : i;
  }

  /** One row per queue entry, the head (the next instruction to dispatch,
   *  marked PC) at the top; empty entries stay as rows so the table keeps
   *  its height. */
  function renderQueue(c, blank) {
    const host = $('iq-items');
    host.replaceChildren();
    const depth = queueDepth();
    const row = (cls, pc, slot, text) => {
      const tr = el('tr', cls);
      tr.append(el('td', 'iq-pc', pc), el('td', 'slot', String(slot)), el('td', 'ins', text));
      return tr;
    };
    if (blank) {
      for (let i = 0; i < depth; i++) host.append(row('iq-item none', i === 0 ? 'PC ▸' : '', i + 1, '?'));
      return;
    }
    const start = nextToDispatch(c);
    const items = S.trace.program.slice(start, start + depth);
    for (let i = 0; i < depth; i++) {
      const p = items[i];
      if (!p) {
        host.append(row('iq-item empty', i === 0 ? 'PC ▸' : '', i + 1, i === 0 ? 'all dispatched' : DASH));
        continue;
      }
      const tr = row('iq-item', i === 0 ? 'PC ▸' : '', i + 1, p.display);
      tr.dataset.insn = String(p.idx);
      if (i === 0) tr.classList.add('next');
      tr.title = i === 0 ? 'Next to dispatch' : `${i} behind the head of the queue`;
      host.append(tr);
    }
    // The tail line is always there (blank when nothing is behind), so the
    // queue is the same height every cycle.
    const more = S.trace.program.length - (start + items.length);
    const tr = el('tr', 'iq-more');
    const td = el('td', null, more > 0 ? `+${more} more behind` : '\u00a0');
    td.colSpan = 3;
    tr.append(td);
    host.append(tr);
  }

  /* ---------------- the physical register file ---------------- */

  /** The value each physical register holds, as of cycle `c`, read off the
   *  ROB rows as they go by (an entry carries its result from X onwards).
   *  At reset every architectural register R_i lives in p_i with its initial
   *  value (i, unless the machine says otherwise).  Display only. */
  const valueCache = { trace: null, upto: -1, values: {} };
  function valuesAt(c) {
    if (valueCache.trace !== S.trace || valueCache.upto > c.cycle) {
      valueCache.trace = S.trace;
      valueCache.upto = -1;
      valueCache.values = {};
      const cfg = S.trace.config;
      S.trace.cycles[0].map_table.forEach((m, i) => {
        const init = cfg.initial_values || {};
        valueCache.values[m.tag] = init[m.reg.toUpperCase()] ?? init[m.reg] ?? (i + 1);
      });
    }
    for (let k = valueCache.upto + 1; k <= c.cycle; k++) {
      for (const r of S.trace.cycles[k].rob) {
        if (r.busy && r.T && r.value !== null && r.value !== undefined) valueCache.values[r.T] = r.value;
      }
    }
    valueCache.upto = c.cycle;
    return valueCache.values;
  }

  /** The physical register file, one row per p_i, from the cycle's free
   *  list, map table and ROB: a register is free (on the free list, or just
   *  released by a retire and on it next cycle), mapped to an architectural
   *  register, or an older value a ROB entry still names as its Told.  It is
   *  ready once the map table or a station says so, or its producer has
   *  completed. */
  function physRows(c) {
    const n = S.trace.config.n_phys_regs;
    const free = new Set(c.free_list);
    const arch = Object.fromEntries(c.map_table.map((m) => [m.tag, m.reg]));
    const ready = new Set(c.map_table.filter((m) => m.ready).map((m) => m.tag));
    const producer = {};
    const told = new Set();
    const toldOf = {};                  // tag -> the youngest ROB entry naming it as Told
    for (const r of c.rob) {
      if (!r.busy) continue;
      if (r.T) { producer[r.T] = r; if (r.C !== null) ready.add(r.T); }
      if (r.Told) { told.add(r.Told); toldOf[r.Told] = r; }
    }
    for (const r of c.rs) {
      if (!r.busy) continue;
      if (r.T1 && r.T1_ready) ready.add(r.T1);
      if (r.T2 && r.T2_ready) ready.add(r.T2);
    }
    const values = valuesAt(c);
    return Array.from({ length: n }, (_, i) => {
      const tag = `p${i + 1}`;
      const p = producer[tag];
      const isFree = free.has(tag) || (!arch[tag] && !p && !told.has(tag));
      const isReady = !isFree && (ready.has(tag) || (!p && (arch[tag] !== undefined || told.has(tag))));
      return { tag, free: isFree, arch: arch[tag] || null, ready: isReady,
               value: isReady ? (values[tag] ?? null) : null, producer: p ? p.insn_idx : null,
               toldOf: toldOf[tag] ? toldOf[tag].insn_idx : null };
    });
  }

  /** One row per physical register: its tag, value, ready bit, and what it
   *  holds — the current value of an architectural register (and who wrote
   *  it, while that instruction is still in the ROB), an older value some
   *  ROB entry still names as its Told, or nothing (free). */
  function renderPRF(c, blank) {
    const body = $('prf').tBodies[0];
    body.replaceChildren();
    const n = S.trace.config.n_phys_regs;
    $('prf-note').textContent = `${n} registers`;
    $('prf-panel').title = `Physical register file: ${n} registers`;
    const cell = (cls, text) => el('td', cls, text);
    if (blank) {
      for (let i = 1; i <= n; i++) {
        const row = el('tr', 'preg none');
        row.append(cell('preg-tag', `p${i}`), cell('preg-val', '?'), cell('preg-ready', '?'), cell('preg-who', '?'));
        body.append(row);
      }
      return;
    }
    const prev = c.cycle > 0 ? S.trace.cycles[c.cycle - 1] : null;
    const before = prev ? Object.fromEntries(physRows(prev).map((r) => [r.tag, r])) : {};
    for (const r of physRows(c)) {
      const row = el('tr', 'preg');
      row.dataset.tag = r.tag;
      row.classList.add(r.free ? 'free' : r.ready ? 'ready' : 'pending');
      const p = before[r.tag];
      if (p && (p.free !== r.free || p.ready !== r.ready || p.value !== r.value || p.arch !== r.arch || p.toldOf !== r.toldOf)) row.classList.add('changed');
      row.append(cell('preg-tag', r.tag));
      row.append(cell('preg-val', r.free ? '–' : r.ready ? String(r.value ?? '') : '…'));
      row.append(cell('preg-ready', r.free ? '–' : r.ready ? '+' : ''));
      const who = cell('preg-who', '');
      if (r.free) who.textContent = 'free';
      else if (r.arch) {
        who.append(el('b', null, r.arch.toLowerCase()));
        if (r.producer !== null) who.append(` ← I${r.producer}`);
      } else if (r.toldOf !== null) who.textContent = `Told of I${r.toldOf}`;
      row.append(who);
      row.title = r.free ? `${r.tag}: free`
        : r.ready ? `${r.tag} = ${r.value}${r.arch ? ` (the current ${r.arch})` : ' (an older value, still needed until its Told is retired)'}`
        : `${r.tag}: allocated, value not ready yet${r.arch ? ` (will be ${r.arch})` : ''}`;
      if (!r.free && !r.ready && r.producer !== null) row.dataset.insn = String(r.producer);
      body.append(row);
    }
  }

  /* ---------------- the functional units ---------------- */

  /** ROB rows that have started executing and not completed, split into
   *  those still in a unit and those finished but waiting for the bus.
   *  `x_done` is the row's last execute cycle, from the model. */
  function inFlight(c) {
    const rows = c.rob.filter((r) => r.busy && r.X !== null && r.X <= c.cycle && r.C === null)
      .sort((a, b) => a.X - b.X || a.seq - b.seq);
    const executing = [], finished = [];
    for (const r of rows) {
      const done = r.x_done !== null && r.x_done !== undefined ? r.x_done : r.X;
      (c.cycle <= done ? executing : finished).push(r);
    }
    return { executing, finished };
  }

  function insnChip(r, cls) {
    const chip = el('div', cls);
    chip.dataset.insn = String(r.insn_idx);
    if (r.T) chip.dataset.tag = r.T;
    chip.append(el('b', null, `I${r.insn_idx}`));
    const tag = el('span', 'tag', r.T || '');
    if (r.T) tag.dataset.tag = r.T;
    chip.append(tag);
    return chip;
  }

  /** One group per kind of unit (integer ALU, multiplier, FP ALU), headed by
   *  its operators and timing, holding a box per unit of that kind.  Each
   *  executing ROB row goes into the unit the model issued it to.  (The CSS
   *  of the pipeline layout makes a thin column of it: the header down to the
   *  abbreviation and timing, a unit a small cell; the operators and the full
   *  description stay in the tooltips.) */
  function renderUnits(c, blank) {
    const host = $('alu-units');
    host.replaceChildren();
    const cfg = S.trace.config;
    const kinds = unitsOf(cfg);
    $('alu-note').textContent = describeUnits(cfg);
    $('alu-panel').title = `Functional units: ${describeUnits(cfg)}`;
    const slotsOf = new Map();          // "kind:fu" -> the unit's slot list
    for (const k of kinds) {
      const group = el('div', 'alu-kind');
      group.dataset.kind = k.kind;
      const notes = [k.abbr, (k.symbols || []).join(' ')];
      if (k.latency > 1) notes.push(`${k.latency} cyc`);
      if (!k.pipelined) notes.push('np');      // not pipelined
      const head = el('div', 'alu-kind-name');
      head.append(el('b', null, notes[0]));
      if (notes[1]) head.append(el('span', 'alu-ops', notes[1]));
      const timing = el('span', 'alu-timing');
      if (!k.pipelined) timing.title = 'np: not pipelined (held for the whole latency)';
      notes.slice(2).forEach((note, i) => {
        if (i) timing.append(el('span', 'alu-sep', ' · '));
        timing.append(el('span', null, note));
      });
      head.append(timing);
      const describe = `${k.label} (${notes[1]}): ${k.count} unit${k.count === 1 ? '' : 's'}, ${k.latency}-cycle latency, `
        + (k.pipelined ? 'takes a new instruction every cycle' : 'held for the whole latency');
      head.title = describe;
      group.append(head);
      const cells = el('div', 'alu-cells');   // the unit boxes of this kind
      group.append(cells);
      for (let u = 0; u < Math.max(1, k.count); u++) {
        const box = el('div', 'alu-unit');
        box.dataset.kind = k.kind;
        box.dataset.unit = String(u);
        box.title = k.count > 1 ? `${k.abbr} ${u + 1} of ${k.count}: ${describe}` : describe;
        if (k.count > 1) { box.dataset.n = String(u + 1); box.append(el('div', 'alu-name', `${k.abbr} ${u + 1}`)); }
        const slots = el('div', 'alu-slots');
        box.append(slots);
        cells.append(box);
        slotsOf.set(`${k.kind}:${u}`, slots);
      }
      host.append(group);
    }
    if (blank) {
      for (const slots of slotsOf.values()) slots.append(el('span', 'none', '?'));
      return;
    }
    for (const r of inFlight(c).executing) {
      const done = r.x_done !== null && r.x_done !== undefined ? r.x_done : r.X;
      const lat = done - r.X + 1;
      const elapsed = c.cycle - r.X + 1;
      const chip = insnChip(r, 'alu-chip');
      if (lat > 1) {
        chip.append(el('span', 'alu-stage', `${elapsed}/${lat}`));
        chip.title = elapsed < lat ? `${r.insn}: executing, cycle ${elapsed} of ${lat}`
          : `${r.insn}: last execute cycle (${elapsed} of ${lat}); its result goes to the complete buffer next`;
      } else {
        chip.append(el('span', 'alu-stage', 'X'));
        chip.title = `${r.insn}: executing; broadcasts on the CDB next cycle`;
      }
      if (r.X === c.cycle) chip.classList.add('changed');
      const key = `${r.unit || kinds[0].kind}:${r.fu || 0}`;
      (slotsOf.get(key) || slotsOf.values().next().value).append(chip);
    }
    for (const slots of slotsOf.values()) if (!slots.children.length) slots.append(el('span', 'none', 'idle'));
  }

  /* ---------------- the complete buffer / CDB arbiter ---------------- */

  function renderCbuf(c, blank) {
    const host = $('cbuf');
    host.replaceChildren();
    const width = S.trace.config.cdb_width || 1;
    $('cbuf-note').textContent = `width ${width}`;
    $('cbuf-panel').title = `Complete buffer, CDB width ${width}: results wait here when the CDB is busy — ${width === 1 ? 'one result' : `${width} results`} per cycle, oldest first`;
    if (blank) { host.append(el('span', 'none', '?')); return; }
    // Broadcasting now: the ROB rows whose C is this cycle.
    const now = c.rob.filter((r) => r.busy && r.C === c.cycle).sort((a, b) => a.seq - b.seq);
    for (const r of now) {
      const chip = insnChip(r, 'cbuf-chip changed');
      chip.append(el('span', 'cbuf-stage', '→ CDB'));
      chip.title = `${r.insn}: completed this cycle; ${r.T} is on the bus`;
      host.append(chip);
    }
    // Finished but not yet on the bus: the CDB was full.
    for (const r of inFlight(c).finished) {
      const chip = insnChip(r, 'cbuf-chip waiting');
      chip.append(el('span', 'cbuf-stage', 'waits for bus'));
      chip.title = `${r.insn}: finished executing, but the CDB was busy`;
      host.append(chip);
    }
    if (!host.children.length) host.append(el('span', 'none', 'idle'));
  }

  return { renderQueue, renderPRF, renderUnits, renderCbuf, eventsInScope, stallText,
           inFlight, queueDepth, nextToDispatch, physRows };
})();
