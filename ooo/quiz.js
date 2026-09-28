/* Quiz mode: blank every structure and let the student fill it in, cycle by
 * cycle, exactly as they would on a worksheet.  Answers persist in this
 * browser (localStorage, keyed by program and machine) and can be downloaded
 * as a JSON submission for cli/grade.mjs.
 *
 * The homework problems are handed in together: one homework file
 * (`ooo-homework-set`, quizkey.js) holds every problem's answers, whichever
 * problem is on screen and however far along each is, and names the problem
 * set they are for.  Only the cycles to fill in are in it: a given cycle is
 * never kept, so it cannot be handed in.  Loading the file puts the answers
 * back, in this browser or another, to carry on from; uploading it to
 * Gradescope hands it in.  It is the same file either way.
 *
 * This is how a homework problem is worked: the Homework tab (viewer.js
 * runHomework) turns quiz mode on for the problem's answer cycles, which
 * need not be a tail (cycles 0-2 given, 3 to fill in, 4 given as a
 * checkpoint, 5-6 to fill in).  A problem's recorded trace has those cycles
 * withheld (trace.withheld, the list), so there is nothing here to check an
 * answer against: "check this cycle" is hidden for one, and check() refuses.
 * The submission names the problem and its answer cycles, and only those
 * are graded (by the Gradescope autograder, against its answer keys).
 * The quiz toggle itself stays hidden in index.html: nothing on screen turns
 * quiz mode on for a lesson.
 *
 * A homework problem's cells are not free text: each is a control that takes
 * only what the cell can hold (h, t or ht for h/t, a checkbox for busy and
 * for a ready bit, a number with a range for an instruction, a physical
 * register or a cycle, a field per tag of the CDB and per slot of the free
 * list); see "a homework problem's cells" below.  What they save is what the
 * free-text cells saved ("I3", "p5+", "ht", "y", "p6 p7"), so the homework
 * file, the grader and the answer keys are as they were.
 *
 * The expected answers and the normalisation of student input live in
 * quizkey.js, which the grader uses too: "what the viewer would have shown"
 * and "what counts as correct" are one piece of code.  tests/viewer.test.mjs
 * and tests/grade.test.mjs cross-check the page and the grader.
 */

'use strict';

window.Quiz = (() => {
  const { S, $, el, render, renderTimeline, STAGES, quizStart, quizGiven, quizCycles, quizFirst,
          cycleList, ranges } = window.OoO;
  // The answer key (what is correct, how input is normalised) is quizkey.js,
  // shared with cli/grade.mjs so the page and the grader can never disagree.
  const K = window.QuizKey;
  const FORMAT = K.FORMAT;
  const VERSION = 1;

  let file = null;    // (program, machine) key; the storage key
  let data = null;    // { student, cycles: {c: answers}, summary: {idx: {D..R}}, checks: {c: n} }

  /* ---------------- persistence ---------------- */

  const fresh = () => ({ student: '', cycles: {}, summary: {}, checks: {} });
  const key = () => 'ooo-quiz:' + file;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** The answers kept under `traceKey`, on screen or not. */
  function read(traceKey) {
    try {
      const raw = localStorage.getItem('ooo-quiz:' + traceKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return { ...fresh(), ...parsed };
      }
    } catch (_) { /* private window, blocked storage: run without persistence */ }
    return fresh();
  }

  /** Keep `d` under `traceKey`; false when this browser keeps nothing. */
  function write(traceKey, d) {
    try { localStorage.setItem('ooo-quiz:' + traceKey, JSON.stringify(d)); return true; } catch (_) { return false; }
  }

  function load(traceKey) {
    file = traceKey;
    data = read(traceKey);
    $('student-name').value = data.student || '';
  }

  /** Keep the answers on screen.  They have changed, so what the homework
   *  page says of the last file saved or loaded no longer holds. */
  function save() {
    write(file, data);
    $('homework-set-note').textContent = '';
  }

  /* ---------------- answer shapes ---------------- */

  const blankCycle = () => K.blankCycle(S.trace);

  function answers(cycle, create) {
    const k = String(cycle);
    if (!data.cycles[k] && create) data.cycles[k] = blankCycle();
    return data.cycles[k] || null;
  }

  const isBlankCycle = (a) => K.isBlankCycle(a);

  function attemptedCycles() {
    return Object.keys(data.cycles).map(Number)
      .filter((c) => !given(c) && !isBlankCycle(data.cycles[c])).sort((a, b) => a - b);
  }

  /** Every cycle the student is to fill in: the problem's list, or every
   *  cycle from the start cycle to the end of the trace. */
  function answerCycles() {
    const set = quizCycles();
    if (set) return set.filter((c) => c < S.trace.cycles.length);
    const out = [];
    for (let c = quizStart(); c < S.trace.cycles.length; c++) out.push(c);
    return out;
  }

  /* ---------------- the key, from quizkey.js ---------------- */

  const norm = K.norm;
  const normInsn = (s) => K.normInsn(s, S.trace.program);
  const normHT = K.normHT;
  const normBusy = K.normBusy;
  const normList = K.normList;

  /** The expected answers for a trace cycle, in answer shape. */
  const expected = (c) => K.expectedCycle(S.trace, c);

  /** Compare the student's answers for cycle `c` with the key. */
  const compareCycle = (c) => K.compareCycle(S.trace, c, answers(c.cycle, false) || blankCycle());

  /* ---------------- rendering ---------------- */

  /* ---------------- drag & drop (optional; S.view.quizDrag) ----------------
   *
   * Two gestures, mirroring dispatch:
   *   program & timings table  ->  ROB "Insn" cell   (the whole expression)
   *   ROB "Insn" cell          ->  RS "op" cell      (just the number, "I0")
   * Nothing else can be dragged or dropped on.
   */

  /* PARKED: drag & drop is not part of the current product; the cells are
   * typed into.  Flip DRAG_ENABLED and take `hidden` off the "drag & drop"
   * checkbox in index.html to bring it back; everything below is in place. */
  const DRAG_ENABLED = false;

  const dragOn = () => DRAG_ENABLED && !!S.view.quizDrag;
  let drag = null;   // { kind: 'program' | 'rob', text }

  function setValue(inp, value) {
    inp.value = value;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** "I0: R3=R1+R2", "I0", "0" -> "I0"; anything else -> ''. */
  function shortInsn(text) {
    const m = normInsn(text).match(/^i(\d+)$/);
    return m ? `I${m[1]}` : '';
  }

  /** Apply a drop onto `target`.  Exposed for the tests, which cannot build a
   *  DataTransfer.  Returns whether anything was accepted.  A homework
   *  problem's cell is a number field: what arrives is the instruction's
   *  number ("I0: R3=R1+R2" as 0). */
  function dropValue(target, text, kind) {
    const t = String(text || '').trim();
    if (!t || !target || target.readOnly) return false;
    const number = target.type === 'number';
    const short = shortInsn(t);
    if (kind === 'program' && target.classList.contains('q-rob-insn')) {
      if (number && !short) return false;
      setValue(target, number ? short.slice(1) : t);
      return true;
    }
    if (kind === 'rob' && target.classList.contains('q-rs-op')) {
      if (!short) return false;
      setValue(target, number ? short.slice(1) : short);
      return true;
    }
    return false;
  }

  function wireDragSource(node, kind, getText) {
    node.addEventListener('dragstart', (e) => {
      const text = getText();
      if (!dragOn() || !text) { e.preventDefault(); return; }
      drag = { kind, text };
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', text);
        e.dataTransfer.effectAllowed = 'copy';
      }
    });
    node.addEventListener('dragend', () => { drag = null; });
  }

  /** A program-table row: draggable whenever drag & drop is on. */
  function makeProgramSource(node, text) {
    node.draggable = true;
    node.classList.add('q-dragsrc');
    node.dataset.dragText = text;
    node.title = 'Drag into a ROB slot';
    wireDragSource(node, 'program', () => text);
  }

  /** A ROB Insn cell: draggable while it holds an instruction. */
  function makeRobSource(inp) {
    inp.classList.add('q-rob-insn');
    const sync = () => { inp.draggable = dragOn() && !inp.readOnly && shortInsn(inp.value) !== ''; };
    inp.addEventListener('input', sync);
    wireDragSource(inp, 'rob', () => shortInsn(inp.value));
    sync();
  }

  function makeDropTarget(inp, accepts) {
    inp.classList.add(accepts === 'program' ? 'q-rob-insn' : 'q-rs-op');
    inp.addEventListener('dragover', (e) => {
      if (!dragOn() || !drag || drag.kind !== accepts || inp.readOnly) return;
      e.preventDefault();
      inp.classList.add('drop-ok');
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    inp.addEventListener('dragleave', () => inp.classList.remove('drop-ok'));
    inp.addEventListener('drop', (e) => {
      inp.classList.remove('drop-ok');
      if (!dragOn() || !drag) return;
      e.preventDefault();
      dropValue(inp, drag.text, drag.kind);
      drag = null;
    });
  }

  function input(cls, value, onInput, extra) {
    const inp = el('input', 'q ' + cls);
    inp.type = 'text';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.value = value || '';
    Object.assign(inp, extra || {});
    inp.addEventListener('input', () => {
      if (inp.readOnly) return;               // given cycles and the timing table are display only
      onInput(inp.value);
      refreshSummary();
      save();
      refreshProgress();
    });
    return inp;
  }

  function tdInput(cls, value, onInput, extra) {
    const td = el('td');
    td.append(input(cls, value, onInput, extra));
    return td;
  }

  /** A *given* cycle is shown worked out and read-only: every cycle before
   *  the quiz's start cycle (S.view.quizStart, default 1: just the reset
   *  state), or, for a homework problem, every cycle not in its list of
   *  answer cycles (a checkpoint between them included).  A given cycle is
   *  never stored as an answer, so it cannot count towards a score. */
  const given = (cycle) => quizGiven(cycle);

  /** A given cycle's contents, in answer shape. */
  const givenAnswers = (cycle) => expected(S.trace.cycles[cycle]);

  /** The answers for the cycle *before* `cycle` — the student's, or the given
   *  state when that is what precedes it. */
  function previousAnswers(cycle) {
    if (cycle <= 0) return null;
    if (given(cycle - 1)) return givenAnswers(cycle - 1);
    const a = answers(cycle - 1, false);
    return isBlankCycle(a) ? null : a;
  }

  /** What to say on a given cycle: which run of given cycles this is, and
   *  where the next cycle to fill in is. */
  function givenNote(cycle) {
    let a = cycle, b = cycle;
    while (a > 0 && given(a - 1)) a--;
    while (b + 1 < S.trace.cycles.length && given(b + 1)) b++;
    const next = answerCycles().find((c) => c > cycle);
    const run = a === b ? `Cycle ${a}` : `Cycles ${a}–${b}`;
    const what = a === 0
      ? (b === 0 ? 'Cycle 0 is the reset state, given as your starting point.' : `${run} are given as a worked example.`)
      : `${run} ${a === b ? 'is' : 'are'} given as a checkpoint: check your work against it and carry on from here.`;
    if (next === undefined) return `${what} There is nothing left to fill in after it.`;
    const verb = a === 0 ? 'begin' : 'continue';
    return `${what} ${cycle === b && next === b + 1 ? 'Step forward' : `Go to cycle ${next}`} to ${verb}.`;
  }

  function renderAll(c) {
    const isGiven = given(c.cycle);
    const byField = structured();
    document.body.classList.toggle('quiz-fields', byField);
    fields = [];
    numbers = [];
    let a = isGiven ? givenAnswers(c.cycle) : answers(c.cycle, true);
    if (byField) {
      // what the fields cannot hold (a cell typed before there were fields)
      // is dropped, so that what is kept is what is on screen
      const held = fieldCycle(a, c.cycle);
      if (!isGiven) {
        data.cycles[String(c.cycle)] = held;         // the fields write to it
        if (JSON.stringify(held) !== JSON.stringify(a)) write(file, data);
      }
      a = held;
      on = { cycle: c.cycle, locked: isGiven };
      fieldROB(a);
      fieldRS(a);
      fieldMap(a);
      fieldLists(a);
    } else {
      renderROB(c, a);
      renderRS(c, a);
      renderMap(c, a);
      renderLists(c, a);
    }
    refreshFaults();
    renderSummary();
    dragFromListing();
    if (isGiven) {
      for (const inp of document.querySelectorAll('.grid input.q:not(#summary-table input)')) {
        inp.readOnly = true;
        inp.classList.add('given');
        inp.tabIndex = -1;
      }
    }
    // PARKED: the note on a given cycle (#quiz-given-note, hidden in
    // index.html); the slide title's tag says that the cycle is given.
    $('quiz-given-note').textContent = isGiven ? givenNote(c.cycle) : '';
    $('quiz-score').textContent = '';
    $('btn-check-cycle').disabled = isGiven;
    $('btn-clear-cycle').disabled = isGiven;
    $('btn-copy-prev').disabled = previousAnswers(c.cycle) === null;
    refreshProgress();
  }

  function renderROB(c, a) {
    const body = $('rob-table').tBodies[0];
    body.replaceChildren();
    a.rob.forEach((row, i) => {
      const tr = el('tr');
      tr.dataset.qslot = String(i + 1);
      tr.append(tdInput('q-ht', row.ht, (v) => { row.ht = v; }, { maxLength: 2, placeholder: '' }));
      tr.append(el('td', 'slot', i + 1));
      const insn = tdInput('q-insn', row.insn, (v) => { row.insn = v; }, { placeholder: 'I?' });
      makeDropTarget(insn.querySelector('input'), 'program');
      makeRobSource(insn.querySelector('input'));
      tr.append(insn);
      tr.append(tdInput('q-tag', row.T, (v) => { row.T = v; }));
      const told = tdInput('q-tag', row.Told, (v) => { row.Told = v; });
      told.classList.add('told');
      tr.append(told);
      for (const f of ['S', 'X', 'C']) {
        tr.append(tdInput('q-num', row[f], (v) => { row[f] = v; }, { inputMode: 'numeric' }));
      }
      body.append(tr);
    });
  }

  function renderRS(c, a) {
    const body = $('rs-table').tBodies[0];
    body.replaceChildren();
    a.rs.forEach((row, i) => {
      const tr = el('tr');
      tr.dataset.qslot = String(i + 1);
      tr.append(el('td', 'slot', i + 1));
      tr.append(tdInput('q-busy', row.busy, (v) => { row.busy = v; }, { maxLength: 1, placeholder: '' }));
      const op = tdInput('q-insn', row.insn, (v) => { row.insn = v; }, { placeholder: 'I?' });
      makeDropTarget(op.querySelector('input'), 'rob');
      tr.append(op);
      tr.append(tdInput('q-tag', row.T, (v) => { row.T = v; }));
      // The tag and its ready-bit column, answered as one box: "p5+".
      for (const f of ['T1', 'T2']) {
        const td = tdInput('q-tag', row[f], (v) => { row[f] = v; });
        td.colSpan = 2;
        tr.append(td);
      }
      body.append(tr);
    });
  }

  function renderMap(c, a) {
    const body = $('map-table').tBodies[0];
    body.replaceChildren();
    for (const reg of Object.keys(a.map)) {
      const tr = el('tr');
      tr.dataset.qslot = reg;
      tr.append(el('td', 'ins reg', reg));
      tr.append(el('td', 'arrow', '→'));
      const tag = tdInput('q-tag', a.map[reg], (v) => { a.map[reg] = v; });
      tag.colSpan = 2;               // the tag and its ready-bit column: "p5+"
      tr.append(tag);
      body.append(tr);
    }
  }

  function renderLists(c, a) {
    const free = $('free-list');
    free.replaceChildren(input('q-list', a.free, (v) => { a.free = v; },
      { placeholder: 'e.g. p6 p7 p8 p9' }));
    const body = $('cdb-table').tBodies[0];
    const tr = el('tr');
    const td = el('td', 'ins');
    td.append(input('q-list', a.cdb, (v) => { a.cdb = v; }, { placeholder: 'tags broadcast' }));
    tr.append(td);
    body.replaceChildren(tr);
  }

  /* ---------------- a homework problem's cells: a control for each kind of value ----------------
   *
   *   ROB h/t                      typed: h, t or ht, or left blank
   *   busy, and every ready bit    a checkbox
   *   Insn, op                     a number, the instruction's (I3 is 3)
   *   T, Told, T1, T2, the map     a number, the physical register's (p5 is 5)
   *   S, X, C                      a number, the cycle
   *   CDB                          a register for each tag it can carry (cdb_width)
   *   free list                    a register for each one that can be free
   *
   * Every number has a range: the program's instructions, the machine's
   * physical registers, the cycles so far.  One outside it, or not a whole
   * number, is outlined and named under the quiz's buttons, and is not
   * kept: the cell is saved blank until it is put right.
   *
   * The answers are saved as the free-text cells saved them, so nothing that
   * reads them (the homework file, quizkey.js, the grader) knows of this.
   */

  /** Whether the cells on screen are a homework problem's. */
  const structured = () => !!S.trace && (Array.isArray(S.trace.withheld) || !!problem());

  /** The kinds of number: the letter it is written with, its range while
   *  `cycle` is filled in, and what it is called. */
  const NUMBERS = {
    insn:  { pre: 'I', range: () => [0, S.trace.program.length - 1], is: 'an instruction of this program',
             hint: 'An instruction, by its number' },
    tag:   { pre: 'p', range: () => [1, S.trace.config.n_phys_regs], is: 'a physical register of this machine',
             hint: 'A physical register, by its number' },
    stage: { pre: '', range: (cycle) => [1, Math.max(1, cycle)], is: 'a cycle so far',
             hint: 'The cycle it happened in' },
  };

  /** "p1 to p9". */
  function span(kind, cycle) {
    const [lo, hi] = NUMBERS[kind].range(cycle);
    return `${NUMBERS[kind].pre}${lo} to ${NUMBERS[kind].pre}${hi}`;
  }

  /** What is wrong with `raw` as a number of this kind, or ''.  `junk`: the
   *  browser is holding something that is not a number at all. */
  function faultOf(kind, raw, cycle, junk) {
    const t = String(raw ?? '').trim();
    if (t === '') return junk ? `not a number (${span(kind, cycle)})` : '';
    if (!/^\d+$/.test(t)) return `${t} is not a whole number (${span(kind, cycle)})`;
    const [lo, hi] = NUMBERS[kind].range(cycle);
    const n = Number(t);
    return n < lo || n > hi ? `${NUMBERS[kind].pre}${n} is not ${NUMBERS[kind].is} (${span(kind, cycle)})` : '';
  }

  /** The number in a saved answer ("I3", "p5+", "4"), as its field shows it:
   *  '' when there is none, or none that the field would take. */
  function numberOf(kind, saved, cycle) {
    const m = kind === 'insn' ? /^i(\d+)$/.exec(normInsn(saved))
      : kind === 'tag' ? /^p(\d+)\+?$/.exec(norm(saved))
      : /^(\d+)$/.exec(norm(saved));
    const n = m ? String(Number(m[1])) : '';
    return n !== '' && faultOf(kind, n, cycle) === '' ? n : '';
  }

  /** A number as it is saved: 3 as "I3", 5 as "p5", a cycle as itself. */
  const written = (kind, n) => (n === '' ? '' : NUMBERS[kind].pre + n);
  const readyOf = (saved) => /\+$/.test(norm(saved));

  /** The CDB carries as many tags as the machine completes in a cycle. */
  const cdbSlots = () => Math.max(1, S.trace.config.cdb_width || 1);
  /** Every register that can be free: the architectural ones are always mapped. */
  const freeSlots = () => Math.max(1, (S.trace.config.n_phys_regs || 0) - (S.trace.config.n_arch_regs || 0));

  /** A cycle's answers as the fields hold them: what they cannot hold (a
   *  register the machine does not have, a word) is left out. */
  function fieldCycle(a, cycle) {
    const out = pour(S.trace, a);
    const num = (kind, v) => written(kind, numberOf(kind, v, cycle));
    const tag = (v) => { const t = num('tag', v); return t && readyOf(v) ? `${t}+` : t; };
    const list = (v, n) => normList(v).map((t) => num('tag', t)).filter(Boolean).slice(0, n).join(' ');
    for (const r of out.rob) {
      r.ht = normHT(r.ht);
      r.insn = num('insn', r.insn);
      for (const f of ['T', 'Told']) r[f] = num('tag', r[f]);
      for (const f of ['S', 'X', 'C']) r[f] = num('stage', r[f]);
    }
    for (const r of out.rs) {
      r.busy = normBusy(r.busy);
      r.insn = num('insn', r.insn);
      r.T = num('tag', r.T);
      for (const f of ['T1', 'T2']) r[f] = tag(r[f]);
    }
    for (const reg of Object.keys(out.map)) out.map[reg] = tag(out.map[reg]);
    out.free = list(out.free, freeSlots());
    out.cdb = list(out.cdb, cdbSlots());
    return out;
  }

  let on = { cycle: 0, locked: false };   // the cycle the fields are for, and whether it is given
  let fields = [];                        // the cells on screen: { key, nodes }, a cell's controls
  let numbers = [];                       // the fields on screen that are typed in: the numbers, and h/t

  /** A cell of the answer: `key` is how compareCycle() names it. */
  const cellAt = (struct, slot, field) =>
    ({ key: `${struct}.${slot ?? ''}.${field}`, label: K.cellLabel({ struct, slot, field }) });

  function register(cell, nodes) {
    const f = { key: cell.key, nodes };
    fields.push(f);
    return f;
  }

  /** A given cycle's control: there to be read. */
  function lock(node) {
    node.classList.add('given');
    node.tabIndex = -1;
    node.readOnly = true;
    if (node.type === 'checkbox') node.disabled = true;   // a checkbox has no read-only
  }

  /** The answers have changed: as typing in a free-text cell. */
  function commit() {
    refreshSummary();
    save();
    refreshProgress();
    refreshFaults();
  }

  /** The ROB's h/t column takes h, t or ht, in either case; nothing else. */
  const HT = ['h', 't', 'ht'];
  const htOf = (raw) => String(raw ?? '').trim().toLowerCase();
  const htFault = (raw) => (htOf(raw) === '' || HT.includes(htOf(raw)) ? '' : `${String(raw).trim()} is not h, t or ht`);

  const faultIn = (inp) => (inp.dataset.kind === 'ht' ? htFault(inp.value)
    : faultOf(inp.dataset.kind, inp.value, on.cycle, !!(inp.validity && inp.validity.badInput)));

  /** What a number field saves: nothing while what is in it is not valid. */
  const valueIn = (inp) =>
    (inp.value.trim() === '' || faultIn(inp) ? '' : written(inp.dataset.kind, String(Number(inp.value))));

  /** A number field, the letter it is written with before it. */
  function numberField(kind, saved, label) {
    const [lo, hi] = NUMBERS[kind].range(on.cycle);
    const inp = el('input', `q q-f q-f-${kind}`);
    inp.type = 'number';
    inp.min = String(lo);
    inp.max = String(hi);
    inp.step = '1';
    inp.inputMode = 'numeric';
    inp.autocomplete = 'off';
    inp.dataset.kind = kind;
    inp.dataset.hint = `${label}. ${NUMBERS[kind].hint}: ${span(kind, on.cycle)}`;
    inp.setAttribute('aria-label', label);
    inp.value = numberOf(kind, saved, on.cycle);
    const box = el('label', 'q-box');
    if (NUMBERS[kind].pre) box.append(el('span', 'q-pre', NUMBERS[kind].pre));
    box.append(inp);
    if (on.locked) lock(inp);
    numbers.push(inp);
    return { box, inp };
  }

  function checkbox(label, checked) {
    const box = el('input', 'q q-f q-f-check');
    box.type = 'checkbox';
    box.checked = !!checked;
    box.setAttribute('aria-label', label);
    if (on.locked) lock(box);
    return box;
  }

  /** A cell that is one number; `store` is given what to save. */
  function numberCell(kind, cell, saved, store) {
    const { box, inp } = numberField(kind, saved, cell.label);
    inp.addEventListener('input', () => {
      if (inp.readOnly) return;
      store(valueIn(inp));
      commit();
    });
    const td = el('td', 'q-cell');
    td.append(box);
    return { td, inp, field: register(cell, [inp]) };
  }

  /** A cell that is a yes or a no, saved as `yes` or blank. */
  function checkCell(cell, saved, yes, store) {
    const box = checkbox(cell.label, saved !== '');
    box.addEventListener('change', () => {
      store(box.checked ? yes : '');
      commit();
    });
    const td = el('td', 'q-cell q-cell-check');
    td.append(box);
    register(cell, [box]);
    return td;
  }

  /** The ROB's h/t column: head, tail, both or neither, typed as on the
   *  slides (h, t, ht, or left blank).  Anything else is outlined and named
   *  as a number out of range is (refreshFaults), and not saved. */
  function htCell(cell, saved, store) {
    const inp = el('input', 'q q-f q-f-ht');
    inp.type = 'text';
    inp.maxLength = 2;
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.setAttribute('autocapitalize', 'off');
    inp.dataset.kind = 'ht';
    inp.dataset.hint = `${cell.label}. h for the head, t for the tail, ht for both; blank for neither`;
    inp.setAttribute('aria-label', cell.label);
    inp.value = normHT(saved);
    if (on.locked) lock(inp);
    inp.addEventListener('input', () => {
      if (inp.readOnly) return;
      store(htFault(inp.value) ? '' : htOf(inp.value));
      commit();
    });
    const td = el('td', 'q-cell q-cell-ht');
    td.append(inp);
    numbers.push(inp);
    register(cell, [inp]);
    return td;
  }

  /** A register and its ready bit, as the two cells the table has for them:
   *  a number and a checkbox, saved as one answer ("p5+").  The bit is a
   *  register's: there is none to set while the cell names no register. */
  function readyCells(cell, saved, store) {
    const locked = on.locked;
    const bit = checkbox(`${cell.label}, ready bit`, false);
    const put = () => {
      const tag = valueIn(tagCell.inp);
      if (tagCell.inp.value.trim() === '' && !faultIn(tagCell.inp)) bit.checked = false;
      bit.disabled = locked || tag === '';
      bit.title = tag === '' && !locked ? 'The ready bit of the register in this cell: enter the register first' : '';
      store(tag && bit.checked ? `${tag}+` : tag);
    };
    const tagCell = numberCell('tag', cell, saved, put);
    bit.classList.add('q-f-rdy');
    bit.checked = tagCell.inp.value !== '' && readyOf(saved);
    bit.disabled = locked || tagCell.inp.value === '';
    if (bit.disabled && !locked) bit.title = 'The ready bit of the register in this cell: enter the register first';
    bit.addEventListener('change', () => {
      put();
      commit();
    });
    const td = el('td', 'q-cell q-cell-check rdy');
    td.append(bit);
    tagCell.field.nodes.push(bit);
    return [tagCell.td, td];
  }

  /** A list of registers, a field for each it can hold: saved in the order
   *  of the fields, the empty ones left out. */
  function listFields(cell, saved, slots, what, store) {
    const tags = normList(saved);
    const inputs = [];
    const boxes = [];
    for (let i = 0; i < slots; i++) {
      const { box, inp } = numberField('tag', tags[i] || '', `${cell.label}, ${what} ${i + 1}`);
      inp.addEventListener('input', () => {
        if (inp.readOnly) return;
        store(inputs.map(valueIn).filter(Boolean).join(' '));
        commit();
      });
      inputs.push(inp);
      boxes.push(box);
    }
    register(cell, inputs);
    return boxes;
  }

  function fieldROB(a) {
    const body = $('rob-table').tBodies[0];
    body.replaceChildren();
    a.rob.forEach((row, i) => {
      const at = (f) => cellAt('rob', i + 1, f);
      const tr = el('tr');
      tr.dataset.qslot = String(i + 1);
      tr.append(htCell(at('ht'), row.ht, (v) => { row.ht = v; }));
      tr.append(el('td', 'slot', i + 1));
      const insn = numberCell('insn', at('insn'), row.insn, (v) => { row.insn = v; });
      makeDropTarget(insn.inp, 'program');
      makeRobSource(insn.inp);
      tr.append(insn.td);
      tr.append(numberCell('tag', at('T'), row.T, (v) => { row.T = v; }).td);
      const told = numberCell('tag', at('Told'), row.Told, (v) => { row.Told = v; }).td;
      told.classList.add('told');
      tr.append(told);
      for (const f of ['S', 'X', 'C']) {
        tr.append(numberCell('stage', at(f), row[f], (v) => { row[f] = v; }).td);
      }
      body.append(tr);
    });
  }

  function fieldRS(a) {
    const body = $('rs-table').tBodies[0];
    body.replaceChildren();
    a.rs.forEach((row, i) => {
      const at = (f) => cellAt('rs', i + 1, f);
      const tr = el('tr');
      tr.dataset.qslot = String(i + 1);
      tr.append(el('td', 'slot', i + 1));
      tr.append(checkCell(at('busy'), row.busy, 'y', (v) => { row.busy = v; }));
      const op = numberCell('insn', at('insn'), row.insn, (v) => { row.insn = v; });
      makeDropTarget(op.inp, 'rob');
      tr.append(op.td);
      tr.append(numberCell('tag', at('T'), row.T, (v) => { row.T = v; }).td);
      for (const f of ['T1', 'T2']) {
        tr.append(...readyCells(at(f), row[f], (v) => { row[f] = v; }));
      }
      body.append(tr);
    });
  }

  function fieldMap(a) {
    const body = $('map-table').tBodies[0];
    body.replaceChildren();
    for (const reg of Object.keys(a.map)) {
      const tr = el('tr');
      tr.dataset.qslot = reg;
      tr.append(el('td', 'ins reg', reg));
      tr.append(el('td', 'arrow', '→'));
      tr.append(...readyCells(cellAt('map', reg, 'tag'), a.map[reg], (v) => { a.map[reg] = v; }));
      body.append(tr);
    }
  }

  function fieldLists(a) {
    $('free-list').replaceChildren(
      ...listFields(cellAt('free', null, 'list'), a.free, freeSlots(), 'slot', (v) => { a.free = v; }));
    // the CDB: a row for each tag it can carry, as the worked-out table has
    const rows = listFields(cellAt('cdb', null, 'list'), a.cdb, cdbSlots(), 'tag', (v) => { a.cdb = v; })
      .map((box) => {
        const tr = el('tr');
        const td = el('td', 'ins q-cell');
        td.append(box);
        tr.append(td);
        return tr;
      });
    $('cdb-table').tBodies[0].replaceChildren(...rows);
  }

  /** Outline the fields that hold what they cannot (a number out of range,
   *  a word in the h/t column), and name them under the bar. */
  function refreshFaults() {
    const out = [];
    for (const inp of numbers) {
      const fault = faultIn(inp);
      const was = inp.classList.contains('invalid');
      inp.classList.toggle('invalid', fault !== '');
      if (fault) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
      if (fault) inp.title = `${fault}. Not saved.`;
      else if (was || !inp.title) inp.title = inp.dataset.hint;
      if (fault) out.push(`${inp.getAttribute('aria-label')}: ${fault}`);
    }
    const note = $('quiz-invalid');
    note.hidden = !out.length;
    note.textContent = out.length
      ? `Not saved, and left blank in your answers until put right: ${out.join('; ')}.` : '';
  }

  /** The program beside the tables (viewer.js renderReference, when it is
   *  shown there): with drag & drop on, an instruction is dragged from it
   *  into a ROB slot, as from the timing table's program column. */
  function dragFromListing() {
    if (!dragOn()) return;
    const rows = document.querySelectorAll('#ref-program tbody tr[data-insn]');
    for (const tr of rows) {
      const p = S.trace.program[Number(tr.dataset.insn)];
      if (p && tr.cells[1]) makeProgramSource(tr.cells[1], p.display);
    }
  }

  /* ---------------- the timing table: derived, never typed ----------------
   *
   * D/S/X/C/R follow from what the student put in the ROB, cycle by cycle:
   *   D  the first cycle the instruction appears in a ROB slot
   *   S, X, C  the values in that instruction's ROB row (latest cycle wins)
   *   R  the first later cycle in which it is gone from the ROB
   * Only the given cycles and the cycles the student has actually filled in
   * are consulted.  The result is stored in data.summary so submissions and
   * grading are unchanged.
   */
  function deriveSummary() {
    const derived = {};
    for (const p of S.trace.program) derived[p.idx] = { D: '', S: '', X: '', C: '', R: '' };
    const attempted = attemptedCycles();
    const cycles = [];                        // the given cycles and the attempted ones, in order
    for (let c = 0; c < S.trace.cycles.length; c++) if (given(c) || attempted.includes(c)) cycles.push(c);
    const present = {};                       // idx -> last consulted cycle it was in the ROB
    for (const c of cycles) {
      const a = given(c) ? givenAnswers(c) : data.cycles[c];
      const seen = new Set();
      for (const row of a.rob) {
        const m = normInsn(row.insn).match(/^i(\d+)$/);
        if (!m) continue;
        const idx = Number(m[1]);
        if (!derived[idx]) continue;
        seen.add(idx);
        if (derived[idx].D === '') derived[idx].D = String(c);
        for (const f of ['S', 'X', 'C']) derived[idx][f] = String(row[f] || '').trim();
        present[idx] = c;
      }
      for (const idxStr of Object.keys(present)) {
        const idx = Number(idxStr);
        if (!seen.has(idx) && derived[idx].R === '' && present[idx] < c) derived[idx].R = String(c);
      }
    }
    data.summary = derived;
    return derived;
  }

  /** The pipeline diagram, drawn from the student's timing table rather than
   *  the trace's, so it grows as the ROB answers do (and shows the given
   *  cycles' stages from the start). */
  function renderQuizTimeline(derived) {
    const numeric = {};
    for (const idx of Object.keys(derived)) {
      numeric[idx] = Object.fromEntries(STAGES.map((f) => {
        const v = String(derived[idx][f] || '').trim();
        return [f, /^\d+$/.test(v) ? Number(v) : null];
      }));
    }
    renderTimeline(S.trace.cycles[S.cycle], numeric);
  }

  function renderSummary() {
    const body = $('summary-table').tBodies[0];
    body.replaceChildren();
    const derived = deriveSummary();
    renderQuizTimeline(derived);
    for (const p of S.trace.program) {
      const row = derived[p.idx];
      const tr = el('tr');
      const ins = el('td', 'ins', p.display);
      // The program listing is where instructions come from: with drag & drop
      // on, each one can be dragged into a ROB slot, whole expression and all.
      if (dragOn()) makeProgramSource(ins, p.display);
      tr.append(ins);
      for (const f of STAGES) {
        const td = tdInput('q-num q-derived', row[f], () => {}, { inputMode: 'numeric' });
        const inp = td.querySelector('input');
        inp.dataset.key = `${p.idx}.${f}`;
        inp.readOnly = true;
        inp.tabIndex = -1;
        inp.title = 'Filled in from your ROB answers';
        tr.append(td);
      }
      body.append(tr);
    }
  }

  /** Re-derive the timing table in place (cheaper than a full re-render). */
  function refreshSummary() {
    const derived = deriveSummary();
    renderQuizTimeline(derived);
    for (const inp of document.querySelectorAll('#summary-table input[data-key]')) {
      const [idx, f] = inp.dataset.key.split('.');
      const v = (derived[Number(idx)] || {})[f] || '';
      if (inp.value !== v) { inp.value = v; inp.classList.remove('ok', 'bad'); inp.title = 'Filled in from your ROB answers'; }
    }
  }

  /** The answer cycles with nothing in them yet. */
  const blankCycles = () => answerCycles().filter((c) => isBlankCycle(answers(c, false)));

  function refreshProgress() {
    const done = attemptedCycles();
    const left = blankCycles();
    const text = `Attempted: ${done.length ? cycleList(done) : 'none yet'}` +
      (quizCycles() ? ` · still blank: ${left.length ? cycleList(left) : 'none'}` : '');
    $('quiz-progress').textContent = text;
    // a homework problem's is shown beside its name, in short: what is left
    const short = $('homework-strip-progress');
    short.textContent = !quizCycles() ? text : left.length ? `blank: ${ranges(left)}` : 'none blank';
    short.title = text;
  }

  /* ---------------- check / copy / clear ---------------- */

  function markInputs(result) {
    const mark = (inp, cell) => {
      inp.classList.toggle('ok', cell.correct);
      inp.classList.toggle('bad', !cell.correct);
      inp.title = cell.correct ? '' :
        `expected: ${cell.expected === '' ? '(blank)' : cell.expected}` +
        (cell.hint ? ` — ${cell.hint}` : '');
    };
    if (structured()) {
      // a homework problem's cells: each is filed under the cell's name
      const by = new Map(fields.map((f) => [f.key, f.nodes]));
      for (const cell of result.cells) {
        for (const node of by.get(`${cell.struct}.${cell.slot ?? ''}.${cell.field}`) || []) mark(node, cell);
      }
      return;
    }
    // Walk the rendered inputs in the same order compareCycle() emitted cells.
    const rob = [...$('rob-table').tBodies[0].rows];
    const map = [...$('map-table').tBodies[0].rows];
    const rs = [...$('rs-table').tBodies[0].rows];
    let i = 0;
    for (const tr of rob) for (const inp of tr.querySelectorAll('input')) mark(inp, result.cells[i++]);
    for (const tr of map) mark(tr.querySelector('input'), result.cells[i++]);
    mark($('free-list').querySelector('input'), result.cells[i++]);
    mark($('cdb-table').querySelector('input'), result.cells[i++]);
    for (const tr of rs) {
      for (const inp of tr.querySelectorAll('input')) mark(inp, result.cells[i++]);
    }
  }

  /** Timing-table cells the machine has reached by cycle `c`: expected value,
   *  or blank when that stage is still in the future.  Matches how the viewer
   *  fills the table in as the slider advances, and how cli/grade.mjs grades it
   *  "through" the last graded cycle. */
  function compareTiming(cycle) {
    const cells = [];
    for (const p of S.trace.program) {
      const s = S.trace.summary[p.idx];
      const got = data.summary[p.idx] || {};
      for (const f of STAGES) {
        const want = s[f] !== null && s[f] <= cycle ? String(s[f]) : '';
        cells.push({ idx: p.idx, field: f, expected: want, answer: got[f] || '',
                     correct: norm(want) === norm(got[f]) });
      }
    }
    return { cells, correct: cells.filter((x) => x.correct).length, total: cells.length };
  }

  function markTiming(result) {
    for (const cell of result.cells) {
      const inp = document.querySelector(`#summary-table input[data-key="${cell.idx}.${cell.field}"]`);
      if (!inp) continue;
      inp.classList.toggle('ok', cell.correct);
      inp.classList.toggle('bad', !cell.correct);
      inp.title = cell.correct ? '' : `expected: ${cell.expected === '' ? '(blank — not yet)' : cell.expected}`;
    }
  }

  function check() {
    const c = S.trace.cycles[S.cycle];
    if (given(c.cycle)) return null;
    // a homework problem: the answers for this cycle are not in the page
    if (Array.isArray(S.trace.withheld)) return null;
    const result = compareCycle(c);
    const timing = compareTiming(c.cycle);
    markInputs(result);
    markTiming(timing);
    const k = String(c.cycle);
    data.checks[k] = (data.checks[k] || 0) + 1;
    save();
    $('quiz-score').textContent =
      `cycle ${c.cycle}: ${result.correct} / ${result.total} structure cells, ` +
      `${timing.correct} / ${timing.total} timing cells through this cycle`;
    result.timing = timing;
    return result;
  }

  function copyPrev() {
    const prev = previousAnswers(S.cycle);
    if (!prev) return;
    const cur = answers(S.cycle, true);
    const fillRow = (dst, src) => {
      for (const f of Object.keys(dst)) if (dst[f] === '' && src && src[f]) dst[f] = src[f];
    };
    cur.rob.forEach((r, i) => fillRow(r, prev.rob[i]));
    cur.rs.forEach((r, i) => fillRow(r, prev.rs[i]));
    fillRow(cur.map, prev.map);
    if (cur.free === '') cur.free = prev.free;
    // The CDB is per-cycle by nature: never carry it forward.
    save();
    render();
  }

  function clearCycle() {
    if (given(S.cycle)) return;
    delete data.cycles[String(S.cycle)];
    save();
    render();
  }

  function clearAll() {
    const student = data.student;
    data = { ...fresh(), student };
    save();
    render();
  }

  /* ---------------- submission ---------------- */

  /** The homework problem being worked, if any (viewer.js). */
  const problem = () => (window.OoO.homeworkForCurrent ? window.OoO.homeworkForCurrent() : null);

  /** The cycles attempted; for a problem, every one of its answer cycles
   *  as well, blank or not (a blank one is visibly unanswered). */
  function buildSubmission() {
    const cycles = {};
    const listed = quizCycles();                // a problem's answer cycles, or null for a plain quiz
    const answer = listed ? answerCycles() : [];
    for (const c of [...new Set([...answer, ...attemptedCycles()])].sort((a, b) => a - b)) {
      cycles[String(c)] = data.cycles[c] || blankCycle();
    }
    const h = problem();
    return {
      format: FORMAT,
      version: VERSION,
      trace: file,
      config: S.trace.config.name,
      ...window.OoO.submissionExtras(),
      homework: h ? h.id : '',                // the problem this answers; what the autograder matches on
      student: data.student || '',
      saved_at: new Date().toISOString(),
      start_cycle: quizFirst(),               // the first cycle answered; older graders read this
      answer_cycles: listed ? answer : null,  // the cycles that count; the rest were given
      cycles,
      summary: deriveSummary(),
      checks: data.checks,
    };
  }

  /** The file name a submission is saved under: a homework problem's is the
   *  problem's id, so the student knows what to upload and it is obvious
   *  which file is which; the autograder matches on the file's contents. */
  function submissionName(sub) {
    if (sub.homework) return `${sub.homework}.json`;
    const safe = (sub.student || 'quiz').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
    const machine = Object.keys(window.OoO.changedParams()).length ? 'custom-machine' : sub.config;
    return `ooo-quiz_${machine}_${sub.program}_${safe}.json`;
  }

  function saveFile(fname, text) {
    if (typeof URL === 'undefined' || !URL.createObjectURL) return;
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = fname;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Save the answers as a file.  A homework problem's go in the homework
   *  file, with every other problem's (the name is optional: Gradescope
   *  knows who submitted); a plain quiz's needs a name to be filed under. */
  function download() {
    const name = ($('student-name').value || '').trim();
    if (problem()) return downloadSet();
    if (!name) {
      $('student-name').focus();
      $('student-name').classList.add('bad');
      $('quiz-score').textContent = 'Enter your name or ID before downloading.';
      return null;
    }
    $('student-name').classList.remove('bad');
    data.student = name;
    save();
    const sub = buildSubmission();
    const fname = submissionName(sub);
    const text = JSON.stringify(sub, null, 1);
    saveFile(fname, text);
    const left = blankCycles();
    const warn = left.length ? ` ${cycleList(left).replace(/^c/, 'C')} ${left.length === 1 ? 'is' : 'are'} still blank.` : '';
    $('quiz-score').textContent = `Saved ${fname} — ${attemptedCycles().length} cycle(s) attempted.${warn}`;
    return { fname, text };
  }

  /* ---------------- the homework file: every problem's answers ---------------- */

  const assigned = () => window.OoO.homework();

  /** The problem set on the page (`{id, title}`), or null. */
  const pageSet = () => (window.OoO.homeworkSet ? window.OoO.homeworkSet() : null);

  /** The name the homework file is saved under: the set's, so that the
   *  files of two homeworks are told apart. */
  const setName = () => (pageSet() ? `ooo-homework-${pageSet().id}.json` : 'ooo-homework.json');

  /** A problem's answers: the ones on screen, or the ones this browser kept. */
  const answersOf = (h) => (h === problem() ? data : read(window.OoO.homeworkKey(h)));

  /** How much of a problem is filled in: `{filled, total}`, in cycles. */
  function progress(h) {
    const d = answersOf(h);
    const cycles = isObj(d.cycles) ? d.cycles : {};
    return { filled: h.deck.blank.filter((c) => !isBlankCycle(cycles[c])).length, total: h.deck.blank.length };
  }

  /** "1 of 10 problems complete, 2 in progress". */
  function setSummary() {
    const all = assigned().map(progress);
    const complete = all.filter((p) => p.filled === p.total).length;
    const started = all.filter((p) => p.filled > 0 && p.filled < p.total).length;
    return `${complete} of ${all.length} problem${all.length === 1 ? '' : 's'} complete` +
      (started ? `, ${started} in progress` : '');
  }

  /** What the last download or load came to, where it can be seen: under the
   *  quiz's buttons, and on the homework page. */
  function say(text) {
    $('quiz-score').textContent = text;
    $('homework-set-note').textContent = text;
  }

  /** The submission of a problem that need not be on screen, from the
   *  answers `d` kept for it: what buildSubmission() makes of the one that is. */
  function problemSubmission(h, d, savedAt) {
    const trace = window.OoO.homeworkTrace(h);
    const kept = isObj(d.cycles) ? d.cycles : {};
    const answer = h.deck.blank.filter((c) => !trace || c < trace.cycles.length);
    const beyond = Object.keys(kept).filter((k) => /^\d+$/.test(k)).map(Number)
      .filter((c) => c > h.deck.to && !isBlankCycle(kept[c]));
    const cycles = {};
    for (const c of [...new Set([...answer, ...beyond])].sort((a, b) => a - b)) {
      cycles[String(c)] = kept[c] || (trace ? K.blankCycle(trace) : {});
    }
    return {
      format: FORMAT,
      version: VERSION,
      trace: window.OoO.homeworkKey(h),
      config: trace ? trace.config.name : '',
      ...window.OoO.homeworkExtras(h),
      homework: h.id,
      student: d.student || '',
      saved_at: savedAt,
      start_cycle: answer[0],
      answer_cycles: answer,
      cycles,
      summary: isObj(d.summary) ? d.summary : {},
      checks: isObj(d.checks) ? d.checks : {},
    };
  }

  /** The homework file: every assigned problem, blank or not. */
  function buildSet() {
    const savedAt = new Date().toISOString();
    const current = problem();
    const problems = {};
    for (const h of assigned()) {
      problems[h.id] = h === current ? { ...buildSubmission(), saved_at: savedAt }
        : problemSubmission(h, answersOf(h), savedAt);
    }
    const student = (data && data.student) || (Object.values(problems).find((p) => p.student) || {}).student || '';
    for (const p of Object.values(problems)) p.student = student;
    return { format: K.SET_FORMAT, version: VERSION, set: pageSet() ? pageSet().id : '', saved_at: savedAt, student, problems };
  }

  function downloadSet() {
    $('student-name').classList.remove('bad');
    if (problem()) {
      data.student = ($('student-name').value || '').trim();
      save();
    }
    const text = JSON.stringify(buildSet(), null, 1);
    const fname = setName();
    saveFile(fname, text);
    say(`Saved ${fname}: ${setSummary()}. Load it here to carry on later, or upload it to Gradescope to hand it in.`);
    return { fname, text };
  }

  /** A cycle's answers out of a file, poured into the tables this machine
   *  has: whatever else the file holds there is dropped. */
  function pour(trace, a) {
    const out = K.blankCycle(trace);
    if (!isObj(a)) return out;
    const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
    const fillRows = (rows, from) => rows.forEach((row, i) => {
      const r = Array.isArray(from) ? from[i] : null;
      if (isObj(r)) for (const f of Object.keys(row)) row[f] = str(r[f]);
    });
    fillRows(out.rob, a.rob);
    fillRows(out.rs, a.rs);
    if (isObj(a.map)) for (const reg of Object.keys(out.map)) out.map[reg] = str(a.map[reg]);
    out.free = str(a.free);
    out.cdb = str(a.cdb);
    return out;
  }

  /** Put a homework file's answers back, each problem's under its own key.
   *  A problem the file has answers for is replaced by them; one it has none
   *  for keeps what this browser has.  A file saved for another problem set
   *  is refused whole. */
  function loadSet(set) {
    const current = problem();
    const loaded = [], skipped = [];
    const of = K.setOf(set);
    if (of && pageSet() && of !== pageSet().id) {
      say(`That file is for another homework (${of}), not this one (${pageSet().title}). Nothing was loaded.`);
      return false;
    }
    for (const { id, sub } of K.unpackSet(set)) {
      const h = assigned().find((x) => x.id === id);
      if (!h) { skipped.push(`${id} (not one of these problems)`); continue; }
      if (sub.trace !== window.OoO.homeworkKey(h)) { skipped.push(`${id} (saved for an earlier version of the problem)`); continue; }
      const trace = window.OoO.homeworkTrace(h);
      const from = isObj(sub.cycles) ? sub.cycles : {};
      const cycles = {};
      for (const c of h.deck.blank) {
        if (trace && !isBlankCycle(from[c])) cycles[String(c)] = pour(trace, from[c]);
      }
      if (!Object.keys(cycles).length) continue;
      const d = { ...fresh(), student: String(sub.student || set.student || ''), cycles,
                  summary: isObj(sub.summary) ? sub.summary : {}, checks: isObj(sub.checks) ? sub.checks : {} };
      if (h === current) {
        data = d;
        deriveSummary();
        $('student-name').value = data.student;
        save();
      } else if (!write(window.OoO.homeworkKey(h), d)) {
        skipped.push(`${id} (this browser is not keeping answers: open the problem first)`);
        continue;
      }
      loaded.push(id);
    }
    render();
    const n = loaded.length;
    say((n ? `Loaded your answers for ${n} problem${n === 1 ? '' : 's'}: ${setSummary()}.` : 'That file has no answers in it for these problems.') +
        (skipped.length ? ` Left out: ${skipped.join('; ')}.` : ''));
    return n > 0;
  }

  function loadSubmission(text) {
    let sub;
    try { sub = JSON.parse(text); } catch (_) { sub = null; }
    if (isObj(sub) && sub.format === K.SET_FORMAT) return loadSet(sub);
    if (!sub || sub.format !== FORMAT) {
      say('That file is not a homework file or a quiz submission.');
      return false;
    }
    // One problem's file (an older download): it goes to its problem, on screen or not.
    if (sub.homework && assigned().some((h) => h.id === sub.homework)) {
      return loadSet({ format: K.SET_FORMAT, student: sub.student, saved_at: sub.saved_at, problems: { [sub.homework]: sub } });
    }
    if (sub.trace !== file) {
      $('quiz-score').textContent =
        `That submission is for ${sub.trace}; select the same program and machine settings first.`;
      return false;
    }
    data = { ...fresh(), student: sub.student || '', cycles: sub.cycles || {},
             summary: {}, checks: sub.checks || {} };
    // Restore which cycles were to be filled in.  A recorded problem's trace
    // says so itself; otherwise the submission's list, or its start cycle.
    if (!Array.isArray(S.trace.withheld)) {
      if (Array.isArray(sub.answer_cycles) && sub.answer_cycles.length) window.OoO.setQuizCycles(sub.answer_cycles);
      else if (Number.isInteger(sub.start_cycle) && sub.start_cycle >= 0) window.OoO.setQuizStart(sub.start_cycle);
    }
    deriveSummary();
    $('student-name').value = data.student;
    save();
    render();
    $('quiz-score').textContent = `Loaded ${attemptedCycles().length} cycle(s).`;
    return true;
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    $('btn-check-cycle').addEventListener('click', check);
    $('btn-copy-prev').addEventListener('click', copyPrev);
    $('btn-clear-cycle').addEventListener('click', clearCycle);
    $('btn-clear-all').addEventListener('click', clearAll);
    $('btn-download').addEventListener('click', download);
    $('student-name').addEventListener('input', (e) => {
      data.student = e.target.value;
      e.target.classList.remove('bad');
      save();
    });
    // the same file is loaded from the quiz's buttons and from the homework page
    for (const id of ['load-submission', 'load-set']) {
      $(id).addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        loadSubmission(await f.text());
        e.target.value = '';
      });
    }
    $('btn-download-set').addEventListener('click', downloadSet);
  }
  wire();

  return { load, renderAll, check, copyPrev, clearCycle, clearAll, expected, compareCycle, compareTiming,
           buildSubmission, download, loadSubmission, attemptedCycles, answerCycles, blankCycles,
           problemSubmission, buildSet, downloadSet, loadSet, progress, setSummary,
           dropValue, deriveSummary, given,
           structured, fieldCycle, faultOf, numberOf, cdbSlots, freeSlots,
           norm, normInsn, normHT, normBusy, normList,
           get data() { return data; } };
})();
