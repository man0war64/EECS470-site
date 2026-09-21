/* PARKED: quiz mode is not part of the current product.  Its toggle is
 * hidden in index.html, so nothing on screen turns it on; this file is kept,
 * and exercised by tests/viewer.test.mjs, for when it comes back.
 *
 * Quiz mode: blank every structure and let the student fill it in, cycle by
 * cycle, exactly as they would on a worksheet.  Answers persist in this
 * browser (localStorage, keyed by trace file) and can be downloaded as a JSON
 * submission for cli/grade.mjs.
 *
 * The expected answers and the normalisation of student input live in
 * quizkey.js, which the grader uses too: "what the viewer would have shown"
 * and "what counts as correct" are one piece of code.  tests/viewer.test.mjs
 * and tests/grade.test.mjs cross-check the page and the grader.
 */

'use strict';

window.Quiz = (() => {
  const { S, $, el, render, renderTimeline, STAGES, quizStart } = window.OoO;
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

  function load(traceKey) {
    file = traceKey;
    data = fresh();
    try {
      const raw = localStorage.getItem(key());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') data = { ...fresh(), ...parsed };
      }
    } catch (_) { /* private window, blocked storage: run without persistence */ }
    $('student-name').value = data.student || '';
  }

  function save() {
    try { localStorage.setItem(key(), JSON.stringify(data)); } catch (_) { /* ignore */ }
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

  const dragOn = () => !!S.view.quizDrag;
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
   *  DataTransfer.  Returns whether anything was accepted. */
  function dropValue(target, text, kind) {
    const t = String(text || '').trim();
    if (!t || !target || target.readOnly) return false;
    if (kind === 'program' && target.classList.contains('q-rob-insn')) {
      setValue(target, t);
      return true;
    }
    if (kind === 'rob' && target.classList.contains('q-rs-op')) {
      const short = shortInsn(t);
      if (!short) return false;
      setValue(target, short);
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

  /** Every cycle before the quiz's start cycle (S.view.quizStart, default 1:
   *  just the reset state) is *given*: shown worked out and read-only, as the
   *  starting point or a worked example.  A given cycle is never stored as an
   *  answer, so it cannot count towards a score. */
  const given = (cycle) => cycle < quizStart();

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

  function givenNote(cycle) {
    const start = quizStart();
    const what = start === 1 ? 'Cycle 0 is the reset state, given as your starting point.'
      : `Cycles 0–${start - 1} are given as a worked example.`;
    return `${what} ${cycle === start - 1 ? 'Step forward' : `Go to cycle ${start}`} to begin.`;
  }

  function renderAll(c) {
    const isGiven = given(c.cycle);
    const a = isGiven ? givenAnswers(c.cycle) : answers(c.cycle, true);
    renderROB(c, a);
    renderRS(c, a);
    renderMap(c, a);
    renderLists(c, a);
    renderSummary();
    if (isGiven) {
      for (const inp of document.querySelectorAll('.grid input.q:not(#summary-table input)')) {
        inp.readOnly = true;
        inp.classList.add('given');
        inp.tabIndex = -1;
      }
      $('quiz-score').textContent = givenNote(c.cycle);
    } else {
      $('quiz-score').textContent = '';
    }
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
    const start = quizStart();
    const cycles = [...Array.from({ length: start }, (_, i) => i), ...attemptedCycles()];
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

  function refreshProgress() {
    const done = attemptedCycles();
    const n = done.length;
    const range = n === 0 ? 'none yet'
      : n === 1 ? `cycle ${done[0]}`
      : `cycles ${done[0]}–${done[n - 1]}${done[n - 1] - done[0] + 1 !== n ? ' (with gaps)' : ''}`;
    $('quiz-progress').textContent = `Attempted: ${range}`;
  }

  /* ---------------- check / copy / clear ---------------- */

  function markInputs(result) {
    // Walk the rendered inputs in the same order compareCycle() emitted cells.
    const rob = [...$('rob-table').tBodies[0].rows];
    const map = [...$('map-table').tBodies[0].rows];
    const rs = [...$('rs-table').tBodies[0].rows];
    let i = 0;
    const mark = (inp, cell) => {
      inp.classList.toggle('ok', cell.correct);
      inp.classList.toggle('bad', !cell.correct);
      inp.title = cell.correct ? '' :
        `expected: ${cell.expected === '' ? '(blank)' : cell.expected}` +
        (cell.hint ? ` — ${cell.hint}` : '');
    };
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

  function buildSubmission() {
    const cycles = {};
    for (const c of attemptedCycles()) cycles[String(c)] = data.cycles[c];
    return {
      format: FORMAT,
      version: VERSION,
      trace: file,
      config: S.trace.config.name,
      ...window.OoO.submissionExtras(),
      student: data.student || '',
      saved_at: new Date().toISOString(),
      start_cycle: quizStart(),               // cycles before this were given, not answered
      cycles,
      summary: deriveSummary(),
      checks: data.checks,
    };
  }

  function download() {
    const name = ($('student-name').value || '').trim();
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
    const safe = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
    const machine = Object.keys(window.OoO.changedParams()).length ? 'custom-machine' : sub.config;
    const fname = `ooo-quiz_${machine}_${sub.program}_${safe}.json`;
    const text = JSON.stringify(sub, null, 1);
    if (typeof URL !== 'undefined' && URL.createObjectURL) {
      const a = el('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = fname;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    $('quiz-score').textContent = `Saved ${fname} — ${attemptedCycles().length} cycle(s) attempted.`;
    return { fname, text };
  }

  function loadSubmission(text) {
    let sub;
    try { sub = JSON.parse(text); } catch (_) { sub = null; }
    if (!sub || sub.format !== FORMAT) {
      $('quiz-score').textContent = 'That file is not a quiz submission.';
      return false;
    }
    if (sub.trace !== file) {
      $('quiz-score').textContent =
        `That submission is for ${sub.trace}; select the same program and machine settings first.`;
      return false;
    }
    data = { ...fresh(), student: sub.student || '', cycles: sub.cycles || {},
             summary: {}, checks: sub.checks || {} };
    // Restore the worked-example range the submission was made with.
    if (Number.isInteger(sub.start_cycle) && sub.start_cycle >= 0) window.OoO.setQuizStart(sub.start_cycle);
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
    $('load-submission').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      loadSubmission(await f.text());
      e.target.value = '';
    });
  }
  wire();

  return { load, renderAll, check, copyPrev, clearCycle, clearAll, expected, compareCycle, compareTiming,
           buildSubmission, download, loadSubmission, attemptedCycles, dropValue, deriveSummary, given,
           norm, normInsn, normHT, normBusy, normList,
           get data() { return data; } };
})();
