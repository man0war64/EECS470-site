/* Out-of-order simulator viewer.
 *
 * This file contains ZERO simulator semantics.  It is a table renderer with a
 * cycle slider: everything it shows comes out of a trace, and the "changed
 * since last cycle" highlighting is computed here by diffing adjacent cycle
 * objects — the model never emits highlight hints.
 *
 * Traces come from window.OOO: paramsPayload() gives the knobs and the
 * bundled programs, simulate() a trace.  In the live version that is model.js,
 * the simulator itself running in the page, and every change in the machine
 * panel re-simulates on the spot.  In the static walkthrough it is player.js
 * (OOO.recorded), which has only the lessons' recorded traces (traces.js):
 * there is no model in the page, the machine panel is left out, and the page
 * opens on the lesson list.  Either way the page works opened straight from
 * disk: no server.
 *
 * quiz.js (loaded after this file) takes over table rendering in quiz mode.
 * PARKED: quiz mode and "print this cycle" are not part of the current
 * product.  Their controls are hidden in index.html; the code (setQuiz,
 * quiz.js, btn-print, the print stylesheet, cli/grade.mjs) is kept and still
 * covered by the tests, but nothing on screen reaches it.
 * lessons.js (loaded before it) is the data behind the "Programs" mode: a
 * list of example programs, each paired with the machine feature it shows.
 */

'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const DASH = '—';
const STAGES = ['D', 'S', 'X', 'C', 'R'];
const MACHINE_TITLE = 'R10K';
const VIEW_KEY = 'ooo-view';
const MACHINE_KEY = 'ooo-machine';
const PROGRAM_KEY = 'ooo-custom-program';   // ':selected' remembers the program on screen
const DEFAULT_VIEW = { layout: 'slide', changes: true, events: false, zoom: 1, flowZoom: 'fit', flowPlanned: false, compare: '',
                       showLog: true, showDeps: false, logDefault: 2,
                       quizDrag: false, quizStart: 1,
                       mode: 'run', lesson: '' };
/** The pipeline diagram always shows at least this many cycle columns, so the
 *  length of the run is not given away by the width of the table. */
const MIN_TIMELINE_CYCLES = 20;

/* Handy starting points for the machine panel.  Each is a *patch* over the
 * default machine; the server remains the authority on what is valid. */
const PRESETS = [
  { id: 'default', label: 'Lecture R10K (default)', params: {} },
  { id: 'wide2', label: '2-wide superscalar',
    params: { dispatch_width: 2, issue_width: 2, cdb_width: 2, retire_width: 2, n_alu: 2,
              rob_size: 8, n_rs: 8, n_phys_regs: 12 } },
  { id: 'wide4', label: '4-wide superscalar',
    params: { dispatch_width: 4, issue_width: 4, cdb_width: 4, retire_width: 4, n_alu: 4,
              rob_size: 16, n_rs: 16, n_phys_regs: 20 } },
  { id: 'tiny', label: 'Tiny window (ROB 2, RS 2)', params: { rob_size: 2, n_rs: 2 } },
  { id: 'starved', label: 'Register-starved (5 physical)', params: { n_phys_regs: 5 } },
  { id: 'onecdb', label: '2 ALUs sharing 1 CDB', params: { n_alu: 2, issue_width: 2, cdb_width: 1 } },
  { id: 'bypass', label: 'X bypass', params: { x_bypass: true } },
  { id: 'lat3', label: '3-cycle ALU latency', params: { alu_latency: 3 } },
  { id: 'slowmul', label: 'Slow multiplier (4-cycle, not pipelined)',
    params: { mul_latency: 4, mul_pipelined: false } },
  { id: 'units', label: 'Real latencies: MUL 4, FP 3, 2-wide',
    params: { dispatch_width: 2, issue_width: 2, cdb_width: 2, retire_width: 2,
              rob_size: 8, n_rs: 8, n_phys_regs: 12,
              mul_latency: 4, mul_pipelined: false, fpu_latency: 3 } },
];

const S = {
  api: null,        // OOO.paramsPayload(): { params, defaults, programs, limits }
  params: {},       // the current machine parameters (full set)
  program: 'lecture_example',
  trace: null,      // the loaded trace document
  key: null,        // identifies (program, machine) for quiz storage / submissions
  cycle: 0,
  sub: -1,          // event index within the cycle when stepping by event; -1 = whole cycle
  playing: false,
  timer: null,
  quiz: false,
  view: { ...DEFAULT_VIEW },
  compareTrace: null,
  compareCache: Object.create(null),
  loading: 0,
};

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

async function boot() {
  loadView();
  wireControls();
  applyView();
  try {
    S.api = await fetchAPI();
  } catch (err) {
    return showLoadError(err);
  }
  loadMachine();
  if (recorded()) $('machine').hidden = true;
  else buildMachinePanel();
  chooseProgram();
  // A recording has the lessons' machines and no others: start from a lesson.
  if (S.view.mode === 'lesson' || recorded()) await setMode('lesson');
  else await loadSelected();
}

/** Whether window.OOO is a recording (player.js) rather than the model: the
 *  machine cannot be changed, only the recorded lessons stepped through. */
function recorded() {
  return !!(window.OOO && window.OOO.recorded);
}

/** The knobs, their defaults and the bundled programs, from the model in
 *  the page.  Async only so the callers read the same as when this was a
 *  request. */
async function fetchAPI() {
  if (!window.OOO || typeof window.OOO.paramsPayload !== 'function') {
    throw new Error('traces.js and player.js did not load');
  }
  const data = window.OOO.paramsPayload();
  if (!Array.isArray(data.params) || !Array.isArray(data.programs)) {
    throw new Error('paramsPayload: unexpected response');
  }
  return data;
}

/** Run `programText` on the machine `params`; the trace, or an error whose
 *  message is the model's own (err.api marks it as such). */
async function simulate(params, programText) {
  const [status, body] = window.OOO.simulate({ program: programText, params });
  if (status !== 200) {
    const err = new Error((body && body.error) || `simulate: status ${status}`);
    err.api = true;
    throw err;
  }
  return body;
}

function showLoadError(err) {
  const box = $('load-error');
  box.hidden = false;
  box.textContent =
    `The simulator did not load.\n\n${err}\n\n` +
    `This page needs traces.js and player.js next to index.html (both are\n` +
    `part of web/). Reload the page; if that does not help, the copy of web/\n` +
    `is incomplete.`;
}

/** The program on screen when the page opens: the one from last time if it
 *  is still bundled, else the first.  Programs are chosen from the Programs
 *  tab (each lesson runs its own) or through the API; there is no picker. */
function chooseProgram() {
  const names = S.api.programs.map((p) => p.name);
  const remembered = loadRememberedProgram();
  S.program = names.includes(remembered) ? remembered : names[0];
}

function currentProgramText() {
  const hit = S.api.programs.find((p) => p.name === S.program);
  return hit ? hit.text : '';
}

/** Which (program, machine) pair is on screen — the key for quiz answers. */
function quizKey() {
  const changed = changedParams();
  if (Object.keys(changed).length === 0) return `r10k_${S.program}`;
  const sig = Object.keys(changed).sort().map((k) => `${k}=${changed[k]}`).join(',');
  return `r10k[${sig}]_${S.program}`;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

async function loadSelected(keepCycle) {
  const previous = S.cycle;
  const token = ++S.loading;
  let trace;
  try {
    trace = await simulate(S.params, currentProgramText());
  } catch (err) {
    if (token !== S.loading) return;
    return reportFailure(err);
  }
  if (token !== S.loading) return;          // a newer request superseded this one
  S.trace = trace;
  S.key = quizKey();
  $('load-error').hidden = true;
  setMachineError('');
  const max = S.trace.cycles.length - 1;
  $('cycle-slider').max = String(max);
  $('cycle-max').textContent = String(max);
  S.cycle = keepCycle ? Math.min(previous, max) : Math.min(1, max);
  S.sub = -1;
  if (window.Quiz) window.Quiz.load(S.key);
  describeConfig();
  // The comparison with a lesson's other machine lives only while the
  // lesson's machine is on screen: pick another program or turn a knob by
  // hand and it is dropped, so a stale machine is never compared.
  if (!lessonForCurrent() && S.view.compare) { S.view.compare = ''; saveView(); }
  await loadCompare();
  render();
}

function reportFailure(err) {
  if (!err.api) return showLoadError(err);
  if (recorded()) {                          // no machine panel to show it in
    $('load-error').hidden = false;
    $('load-error').textContent = String(err.message || err).replace(/^(machine|program):\s*/, '');
    return;
  }
  const msg = String(err.message || err);
  // The programs are bundled, so a "does not fit" complaint about one is
  // something to fix in the machine.
  setMachineError(msg.replace(/^(machine|program):\s*/, ''));
  $('machine').open = true;
}

/** The other machine of the lesson on screen, `{label, params}` with the
 *  full parameter set, or null: the lesson page shows the program's full run
 *  on both.  Stored in the view as `{label, params}` with a patch. */
function compareTarget() {
  const v = S.view.compare;
  if (!v || !S.api) return null;
  if (typeof v === 'object' && v.params) {
    return { label: String(v.label || 'the other machine'), params: { ...S.api.defaults, ...v.params } };
  }
  return null;
}

/* A lesson may name a *contrast* machine: the same program on two machines
 * (the R10K by hand, 1-wide and 2-way superscalar).  The contrast is simulated
 * alongside, and the lesson page shows the two side by side — a column each
 * among the knobs, the "Result" block (both full runs), and a button to run
 * either — and the strip swaps between them.  A lesson without a contrast has
 * none of that.  S.comparison false switches it all off (setComparison). */
S.comparison = true;
async function setComparison(on) {
  S.comparison = !!on;
  await loadCompare();
  if (S.trace) render();
}

async function loadCompare() {
  S.compareTrace = null;
  const target = S.comparison ? compareTarget() : null;
  if (!target) return;
  const text = currentProgramText();
  const k = hash(text + '\n' + JSON.stringify(target.params));
  try {
    if (!S.compareCache[k]) S.compareCache[k] = await simulate(target.params, text);
    S.compareTrace = S.compareCache[k];
  } catch (_) {
    S.compareTrace = null;
  }
}

/** The functional units of a trace's config: `[{kind, abbr, label, symbols,
 *  count, latency, pipelined}]`.  The model writes the list into every trace;
 *  the fallback keeps an old trace with only `n_alu` readable. */
function unitsOf(c) {
  if (Array.isArray(c.units) && c.units.length) return c.units;
  return [{ kind: 'alu', abbr: 'ALU', label: 'integer ALU', symbols: ['+', '-'],
            count: c.n_alu || 1, latency: c.alu_latency || 1, pipelined: c.alu_pipelined !== false }];
}

/** "2 ALUs · 1 MUL (4-cycle, np) · 1 FPU (3-cycle)"; np = not pipelined */
function describeUnits(c) {
  return unitsOf(c).map((u) => {
    const notes = [];
    if (u.latency > 1) notes.push(`${u.latency}-cycle`);
    if (!u.pipelined) notes.push('np');
    return `${u.count} ${u.abbr}${u.count > 1 ? 's' : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  }).join(' · ');
}

/** The machine summary as DOM: one nowrap item per " · "-separated part, each
 *  carrying its own separator, with a plain space between them, so a line can
 *  break only after a "·" and never inside "1 MUL".  The textContent is the
 *  text, unchanged.  The items sit in one block because #config-summary is a
 *  -webkit-box (for its two-line clamp), which would stack them as children. */
function summaryLine(text) {
  const line = el('div', 'config-line');
  const items = text.split(' · ');
  items.forEach((item, i) => {
    if (i) line.append(' ');
    line.append(el('span', 'config-bit', i < items.length - 1 ? `${item} ·` : item));
  });
  return line;
}

function describeConfig() {
  const c = S.trace.config;
  const bits = [
    `${c.rob_size}-entry ROB`, `${c.n_rs} RS`,
    `${c.n_phys_regs} pregs / ${c.n_arch_regs} arch`,
    describeUnits(c),
    `widths D${c.dispatch_width} S${c.issue_width} CDB${c.cdb_width} R${c.retire_width}`,
  ];
  if (c.renaming === false) bits.push('no renaming');
  if (c.x_bypass) bits.push('X bypass');
  if (!c.c_bypass_to_s) bits.push('no C→S bypass');
  if (c.same_cycle_resource_reuse) bits.push('same-cycle reuse');
  if (c.free_list_order === 'lowest_index') bits.push('lowest-index free list');
  if (c.rs_alloc_order === 'lowest_index') bits.push('lowest-index RS');
  $('config-summary').replaceChildren(summaryLine(bits.join(' · ')));
  $('config-summary').title = unitsOf(c).some((u) => !u.pipelined) ? 'np: not pipelined (the unit is held for its whole latency)' : '';
}

/* ------------------------------------------------------------------ */
/* the machine panel (live mode)                                       */
/* ------------------------------------------------------------------ */

function loadMachine() {
  S.params = { ...S.api.defaults };
  if (recorded()) return;                     // a saved machine may not be a recorded one
  try {
    const raw = localStorage.getItem(MACHINE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const p of S.api.params) if (saved && saved[p.name] !== undefined) S.params[p.name] = saved[p.name];
    }
  } catch (_) { /* defaults */ }
}

function saveMachine() {
  if (recorded()) return;
  try { localStorage.setItem(MACHINE_KEY, JSON.stringify(changedParams())); } catch (_) { /* ignore */ }
}

function loadRememberedProgram() {
  try { return localStorage.getItem(PROGRAM_KEY + ':selected'); } catch (_) { return null; }
}

function rememberProgram() {
  try { localStorage.setItem(PROGRAM_KEY + ':selected', S.program); } catch (_) { /* ignore */ }
}

function changedParams() {
  const out = {};
  if (!S.api) return out;
  for (const p of S.api.params) {
    if (S.params[p.name] !== S.api.defaults[p.name]) out[p.name] = S.params[p.name];
  }
  return out;
}

function matchPreset() {
  const changed = changedParams();
  for (const preset of PRESETS) {
    const keys = Object.keys(preset.params);
    if (keys.length !== Object.keys(changed).length) continue;
    if (keys.every((k) => changed[k] === preset.params[k])) return preset.id;
  }
  return '';
}

const GROUP_TITLES = { sizes: 'Structure sizes', widths: 'Superscalar widths',
                       units: 'Functional units', policy: 'Policy' };
const UNIT_FACETS = [['count', 'how many'], ['latency', 'latency'], ['pipelined', 'pipelined']];

function paramInput(p) {
  let input;
  if (p.kind === 'int') {
    input = el('input', 'machine-num');
    input.type = 'number';
    input.min = String(p.min);
    input.max = String(p.max);
    input.step = '1';
    input.inputMode = 'numeric';
  } else if (p.kind === 'bool') {
    input = el('input', 'machine-bool');
    input.type = 'checkbox';
  } else {
    input = el('select', 'machine-choice');
    for (const c of p.choices) input.append(new Option(c.replace(/_/g, ' '), c));
  }
  input.id = 'param-' + p.name;
  input.dataset.param = p.name;
  input.title = p.help || '';
  input.addEventListener('change', () => onParamInput(p, input));
  return input;
}

/** The functional units as a grid: a row per kind of unit (with the
 *  operators it executes), a column per knob — count, latency, pipelined. */
function buildUnitsGrid(box, params) {
  const table = el('table', 'machine-units');
  const head = table.createTHead().insertRow();
  head.append(el('th', null, ''));
  for (const [, title] of UNIT_FACETS) head.append(el('th', null, title));
  const body = table.createTBody();
  const units = (S.api.units && S.api.units.length) ? S.api.units
    : [...new Set(params.map((p) => p.unit))].map((kind) => ({ kind, abbr: kind.toUpperCase(), label: kind, symbols: [] }));
  for (const u of units) {
    const tr = body.insertRow();
    tr.dataset.kind = u.kind;
    const th = el('th', 'machine-unit', u.abbr);
    th.title = u.label;
    if (u.symbols && u.symbols.length) th.append(el('span', 'machine-ops', u.symbols.join(' ')));
    tr.append(th);
    for (const [facet] of UNIT_FACETS) {
      const p = params.find((q) => q.unit === u.kind && q.facet === facet);
      const td = tr.insertCell();
      if (p) td.append(paramInput(p));
    }
  }
  box.append(table);
}

function buildMachinePanel() {
  const root = $('machine-groups');
  root.replaceChildren();
  for (const [group, title] of Object.entries(GROUP_TITLES)) {
    const params = S.api.params.filter((p) => p.group === group);
    if (!params.length) continue;
    const box = el('fieldset', 'machine-group ' + group);
    box.append(el('legend', null, title));
    if (group === 'units' && params.every((p) => p.unit && p.facet)) {
      buildUnitsGrid(box, params);
    } else {
      for (const p of params) {
        const row = el('label', 'machine-row');
        row.title = p.help || '';
        row.append(el('span', 'machine-label', p.label));
        row.append(paramInput(p));
        box.append(row);
      }
    }
    root.append(box);
  }
  const presetSel = $('machine-preset');
  presetSel.replaceChildren(new Option('— custom —', ''));
  for (const preset of PRESETS) presetSel.append(new Option(preset.label, preset.id));
  syncMachinePanel();
}

/** Push S.params into the inputs (after a preset, a reset, or a reload). */
function syncMachinePanel() {
  for (const p of S.api.params) {
    const input = $('param-' + p.name);
    if (!input) continue;
    if (p.kind === 'bool') input.checked = !!S.params[p.name];
    else input.value = String(S.params[p.name]);
    input.classList.toggle('non-default', S.params[p.name] !== S.api.defaults[p.name]);
  }
  $('machine-preset').value = matchPreset();
  const n = Object.keys(changedParams()).length;
  $('machine-summary').textContent = n ? `⚙ machine (${n} changed)` : '⚙ machine';
  $('machine-summary').classList.toggle('changed-machine', n > 0);
}

function onParamInput(p, input) {
  let v;
  if (p.kind === 'bool') v = input.checked;
  else if (p.kind === 'int') {
    v = Number(input.value);
    if (!Number.isFinite(v) || input.value.trim() === '') { input.value = String(S.params[p.name]); return; }
    v = Math.max(p.min, Math.min(p.max, Math.round(v)));
  } else v = input.value;
  setParams({ [p.name]: v });
}

/** Change machine parameters and re-simulate, keeping the cycle where possible. */
function setParams(patch, replace) {
  S.params = replace ? { ...S.api.defaults, ...patch } : { ...S.params, ...patch };
  saveMachine();
  syncMachinePanel();
  stop();
  return loadSelected(true);
}

function applyPreset(id) {
  const preset = PRESETS.find((x) => x.id === id);
  if (!preset) return Promise.resolve();
  return setParams(preset.params, true);
}

function setMachineError(msg) {
  const box = $('machine-error');
  box.hidden = !msg;
  box.textContent = msg || '';
  $('machine-summary').classList.toggle('error', !!msg);
}

/* ------------------------------------------------------------------ */
/* view options                                                        */
/* ------------------------------------------------------------------ */

function loadView() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // The old boolean "cycle 0 given" became "start at cycle 1 (or 0)".
      if (parsed.quizStart === undefined && parsed.quizGiven0 !== undefined) parsed.quizStart = parsed.quizGiven0 ? 1 : 0;
      delete parsed.quizGiven0;
      // "What happened this cycle" became on by default: a view saved before
      // that starts with it on, once; turning it off after that sticks.
      if (parsed.logDefault !== DEFAULT_VIEW.logDefault) parsed.showLog = true;
      S.view = { ...DEFAULT_VIEW, ...parsed };
    }
  } catch (_) { /* no storage: defaults */ }
  const cmp = S.view.compare;
  if (cmp && !(typeof cmp === 'object' && cmp.params && typeof cmp.params === 'object')) {
    S.view.compare = '';
  }
  // Gone: the dashboard layout, the ready-bit colour switch (always on) and
  // large text (zoom instead).
  if (S.view.layout === 'dashboard') S.view.layout = 'slide';
  // Gone too: the older datapath layout; the pipeline layout (flow.js) replaced it.
  if (S.view.layout === 'pipeline') S.view.layout = 'flow';
  if (S.view.layout !== 'flow') S.view.layout = 'slide';
  delete S.view.ready;
  delete S.view.big;
  delete S.view.showTimeline;             // the pipeline diagram is always shown
  if (S.view.mode !== 'lesson') S.view.mode = 'run';
  if (typeof S.view.lesson !== 'string') S.view.lesson = '';
  S.view.quizStart = Math.max(0, Math.floor(Number(S.view.quizStart)) || 0);
}

/** The first cycle the student fills in themselves in quiz mode; every cycle
 *  before it is shown worked out, as a given starting point.  0 gives nothing
 *  away; 1 (the default) gives the reset state; 5 gives cycles 0–4 as a worked
 *  example.  Clamped so the last cycle is always left to fill in. */
function quizStart() {
  const max = S.trace ? S.trace.cycles.length - 1 : 0;
  return Math.max(0, Math.min(max, Math.floor(Number(S.view.quizStart)) || 0));
}

/** In quiz mode, is this cycle one the student fills in (answers hidden)? */
function quizBlank(cycle) {
  return S.quiz && cycle >= quizStart();
}

function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(S.view)); } catch (_) { /* ignore */ }
}

function applyView() {
  const v = S.view;
  document.body.classList.toggle('layout-slide', v.layout === 'slide');
  document.body.classList.toggle('layout-flow', v.layout === 'flow');
  document.body.classList.toggle('mode-lesson', v.mode === 'lesson');
  $('lesson-view').hidden = v.mode !== 'lesson';
  $('lesson-view').style.zoom = String(zoomLevel());
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === v.mode;
  document.body.classList.toggle('no-changes', !v.changes);
  // The pipeline layout zooms its own canvas (flow.js), not the grid: the
  // record of the run under it stays life-size.
  $('grid').style.zoom = v.layout === 'flow' ? '1' : String(zoomLevel());
  $('zoom-readout').textContent = `${Math.round(zoomLevel() * 100)}%`;
  $('btn-zoom-in').disabled = zoomLevel() >= ZOOM_MAX;
  $('btn-zoom-out').disabled = zoomLevel() <= ZOOM_MIN;
  for (const r of document.querySelectorAll('input[name="layout"]')) r.checked = r.value === v.layout;
  $('opt-changes').checked = !!v.changes;
  $('opt-events').checked = !!v.events;
  $('panel-log').checked = !!v.showLog;
  $('panel-deps').checked = !!v.showDeps;
  $('quiz-drag').checked = !!v.quizDrag;
  $('quiz-start').value = String(Math.max(0, Math.floor(Number(v.quizStart)) || 0));
  $('quiz-drag-hint').hidden = !v.quizDrag;
  if (!v.events) S.sub = -1;
  if (window.Flow) window.Flow.applyView();
}

function setView(patch) {
  Object.assign(S.view, patch);
  saveView();
  applyView();
  if (S.trace) render();
}

/* Zoom.  The slide layout is scaled as one: the grid carries the CSS zoom, so
 * the controls stay put.  The pipeline layout zooms its own canvas instead
 * (flow.js), from fitting the whole pipeline to one stage filling the window. */
const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
function zoomLevel() {
  const z = Number(S.view.zoom);
  return Number.isFinite(z) && z > 0 ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1;
}
/** Back to 100% — or, in the pipeline layout, to the whole pipeline. */
function resetZoom() {
  if (S.view.layout === 'flow' && window.Flow) window.Flow.fit(); else setView({ zoom: 1 });
}
function zoomBy(steps) {
  if (S.view.layout === 'flow' && window.Flow) { window.Flow.zoomBy(steps); return; }
  const z = Math.round((zoomLevel() + steps * ZOOM_STEP) * 10) / 10;
  setView({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) });
}

/* ------------------------------------------------------------------ */
/* display rules — the only place trace fields become slide notation   */
/* ------------------------------------------------------------------ */

function operandText(r, which) {
  if (!r.busy) return '';
  if (which === 2 && r.n_srcs < 2) return DASH;
  const tag = which === 1 ? r.T1 : r.T2;
  const ready = which === 1 ? r.T1_ready : r.T2_ready;
  if (tag === null) return DASH;
  return tag + (ready ? '+' : '');
}

function mapText(m) {
  if (m.tag === null) return DASH;
  return m.tag + (m.ready ? '+' : '');
}

function htText(r) {
  return (r.head ? 'h' : '') + (r.tail ? 't' : '');
}

/** Which instruction produces `tag` in this cycle, or null if it is retired /
 *  architectural.  Derived from the ROB — the trace carries no producer map. */
function producerOf(c, tag) {
  const row = c.rob.find((r) => r.busy && r.T === tag);
  return row ? row.insn_idx : null;
}

/* ------------------------------------------------------------------ */
/* diffing: flatten a cycle into { cellKey: displayedText }             */
/* ------------------------------------------------------------------ */

function cellValues(c) {
  const v = Object.create(null);
  for (const r of c.rob) {
    const k = `rob.${r.slot}.`;
    v[k + 'ht'] = htText(r);
    v[k + 'insn'] = r.insn || '';
    v[k + 'T'] = r.T || '';
    v[k + 'Told'] = r.Told || '';
    for (const f of ['S', 'X', 'C']) v[k + f] = r[f] === null ? '' : String(r[f]);
  }
  for (const m of c.map_table) v['map.' + m.reg] = mapText(m);
  v['free'] = c.free_list.join(',');
  v['cdb'] = c.cdb.join(',');
  for (const r of c.rs) {
    const k = `rs.${r.slot}.`;
    v[k + 'busy'] = r.busy ? 'y' : '';
    v[k + 'insn'] = r.busy ? r.op : '';
    v[k + 'T'] = r.T || '';
    v[k + 'T1'] = operandText(r, 1);
    v[k + 'T2'] = operandText(r, 2);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

let PREV = Object.create(null);
let NOW = Object.create(null);
let LAST_RENDERED = -1;   // the cycle on screen before this render (for the datapath tokens)

function cell(key, text, tag) {
  const td = el('td');
  const span = el('span', 'cell', text === '' ? '' : text);
  if (NOW[key] !== undefined && PREV[key] !== undefined && NOW[key] !== PREV[key]) {
    span.classList.add('changed');
  }
  if (tag) span.dataset.tag = tag;
  if (text === '' || text === DASH) td.classList.add('empty');
  td.append(span);
  return td;
}

/** A tag and its ready bit, as two cells: the bit is a column of its own, a
 *  one-bit register beside the tag, lit green while it is set.  `text` is the
 *  slide notation ("p5+", "p5", a dash or nothing) stored under `key`; each
 *  cell is marked changed only for its own half of it. */
function tagCells(key, text, tag) {
  const bare = (s) => s.replace(/\+$/, '');
  const now = NOW[key], prev = PREV[key];
  const known = now !== undefined && prev !== undefined;
  const td = cell(key, bare(text), tag);
  td.querySelector('.cell').classList.toggle('changed', known && bare(now) !== bare(prev));
  const bit = el('td', 'rdy');
  if (!tag) bit.classList.add('empty');
  else if (text.endsWith('+')) { bit.classList.add('on'); bit.textContent = '+'; bit.title = `${tag} is ready: its value has been computed`; }
  else bit.classList.add('off');
  if (known && now.endsWith('+') !== prev.endsWith('+')) bit.classList.add('changed');
  return [td, bit];
}

function waitingTitle(c, tag) {
  const p = producerOf(c, tag);
  return p === null ? `waiting on ${tag}` : `waiting on ${tag}, produced by I${p}`;
}

function render() {
  if (S.view.mode === 'lesson') { renderLesson(); return; }
  const c = S.trace.cycles[S.cycle];
  // Stepping one cycle on in the pipeline layout: remember where every
  // instruction was drawn, so the datapath can slide it to where it goes.
  const flow = S.view.layout === 'flow' && window.Flow ? window.Flow : null;       // the pipeline layout (flow.js)
  const stepped = flow && !S.quiz && LAST_RENDERED === S.cycle - 1;
  const before = stepped ? flow.snapshot() : null;
  LAST_RENDERED = S.cycle;
  NOW = cellValues(c);
  PREV = S.cycle > 0 ? cellValues(S.trace.cycles[S.cycle - 1]) : Object.create(null);

  const cfg = S.trace.config;
  $('cycle-number').textContent = String(c.cycle);
  $('cycle-slider').value = String(S.cycle);
  $('btn-back').disabled = S.cycle === 0 && S.sub < 0;
  $('btn-forward').disabled = S.cycle >= S.trace.cycles.length - 1;
  $('slide-title').textContent = `${MACHINE_TITLE} Cycle # ${c.cycle}`;
  $('event-readout').textContent = S.view.events && !S.quiz && S.sub >= 0
    ? `· event ${S.sub + 1}/${c.events.length}` : '';

  document.body.classList.toggle('quiz', S.quiz);
  $('quiz-bar').hidden = !S.quiz;
  const blank = quizBlank(c.cycle);       // quiz mode, and this cycle is the student's to fill in
  $('events-panel').hidden = blank || !S.view.showLog;
  $('deps-panel').hidden = !S.view.showDeps;
  $('cycle-max-wrap').hidden = S.quiz;
  $('rob-occupancy').textContent = S.quiz ? '' : `${c.rob_count}/${cfg.rob_size} used`;
  renderLessonStrip(c);

  if (S.quiz) {
    // Hidden is not enough: the answers must not even be in the DOM.  A given
    // cycle is the exception: it is a worked example, so its log is shown
    // alongside it.  The pipeline diagram stays, drawn from the student's own
    // timing table (quiz.js renders it, and redraws it as they type).
    if (blank) $('events').replaceChildren(); else renderEvents(c);
    renderDeps(c);                 // when blank: structure only, no stages, no blocking edges
    window.Quiz.renderAll(c);
    if (window.Flow) window.Flow.render(c, { blank });
    return;
  }
  renderROB(c);
  renderRS(c);
  renderMap(c);
  renderFree(c);
  renderCDB(c);
  renderEvents(c);
  renderSummary(c);
  renderTimeline(c);
  renderDeps(c);
  if (window.Flow) window.Flow.render(c, { before });
  applyEventFocus(c);
}

function renderROB(c) {
  const body = $('rob-table').tBodies[0];
  body.replaceChildren();
  for (const r of c.rob) {
    const k = `rob.${r.slot}.`;
    const tr = el('tr');
    if (!r.busy) tr.classList.add('free');
    if (r.head) tr.classList.add('head-row');
    if (r.tail) tr.classList.add('tail-row');
    tr.dataset.slot = String(r.slot);
    if (r.busy) tr.dataset.insn = String(r.insn_idx);
    if (r.T) tr.dataset.producesTag = r.T;

    const ht = el('td', 'ht');
    const htSpan = el('span', 'cell');
    if (r.head) htSpan.append(el('b', 'h', 'h'));
    if (r.tail) htSpan.append(el('b', 't', 't'));
    if (NOW[k + 'ht'] !== PREV[k + 'ht'] && PREV[k + 'ht'] !== undefined) {
      htSpan.classList.add('changed');
    }
    ht.append(htSpan);
    tr.append(ht);

    tr.append(el('td', 'slot', r.slot));

    const insn = cell(k + 'insn', r.insn || DASH);
    insn.classList.add('ins');
    tr.append(insn);

    tr.append(cell(k + 'T', r.T || DASH, r.T || undefined));
    const told = cell(k + 'Told', r.Told || DASH, r.Told || undefined);
    told.classList.add('told');
    tr.append(told);
    for (const f of ['S', 'X', 'C']) {
      tr.append(cell(k + f, r[f] === null ? DASH : r[f]));
    }
    body.append(tr);
  }
}

function renderRS(c) {
  const body = $('rs-table').tBodies[0];
  body.replaceChildren();
  for (const r of c.rs) {
    const k = `rs.${r.slot}.`;
    const tr = el('tr');
    if (!r.busy) tr.classList.add('free');
    if (r.busy) tr.dataset.insn = String(r.insn_idx);
    if (r.busy && r.issued) tr.classList.add('issued');
    tr.append(el('td', 'slot', r.slot));
    const busy = cell(k + 'busy', r.busy ? 'y' : DASH);
    busy.classList.add('busy');
    tr.append(busy);
    const insn = cell(k + 'insn', r.busy ? r.op : DASH);
    insn.classList.add('ins');
    if (r.busy && r.issued) {
      const pill = el('span', 'pill', 'issued');
      pill.title = 'Issued; the station is released when execution begins next cycle';
      insn.append(pill);
    }
    tr.append(insn);
    tr.append(cell(k + 'T', r.T || DASH, r.T || undefined));
    for (const which of [1, 2]) {
      const text = operandText(r, which) || DASH;
      const tag = which === 1 ? r.T1 : r.T2;
      const ready = which === 1 ? r.T1_ready : r.T2_ready;
      const [td, bit] = tagCells(k + 'T' + which, text, (r.busy && tag) || undefined);
      tr.append(td, bit);
      // A busy, not-yet-issued entry whose operand is missing is the thing a
      // student most wants to interrogate: make the row itself a hover target.
      if (r.busy && !r.issued && tag && !ready) {
        tr.dataset.blocking = tag;
        td.title = bit.title = waitingTitle(c, tag);
      }
    }
    body.append(tr);
  }
  wireHover(body);
}

function renderMap(c) {
  const body = $('map-table').tBodies[0];
  body.replaceChildren();
  for (const m of c.map_table) {
    const tr = el('tr');
    tr.append(el('td', 'ins reg', m.reg));
    tr.append(el('td', 'arrow', '→'));
    const text = mapText(m);
    const [td, bit] = tagCells('map.' + m.reg, text, m.tag || undefined);
    td.classList.add('ins');
    if (m.tag && !m.ready) {
      td.title = bit.title = waitingTitle(c, m.tag);
      const p = producerOf(c, m.tag);
      if (p !== null) tr.dataset.insn = String(p);
    }
    tr.append(td, bit);
    body.append(tr);
  }
}

/** The free list has a slot for every register that can ever be free (the
 *  physical registers less the architectural ones, which are always mapped),
 *  so the panel is the same size every cycle: the free tags, oldest first,
 *  then an empty slot for each register in use.  The slide layout shows the
 *  tags alone, as the slides do. */
function renderFree(c) {
  const node = $('free-list');
  node.replaceChildren();
  const cfg = S.trace.config;
  const capacity = Math.max(c.free_list.length, (cfg.n_phys_regs || 0) - (cfg.n_arch_regs || 0));
  node.style.setProperty('--free-cols', String(Math.min(capacity, 4)));
  if (!c.free_list.length) node.append(el('span', 'none', 'empty'));
  const before = new Set((PREV.free || '').split(',').filter(Boolean));
  c.free_list.forEach((t, i) => {
    const chip = el('span', 'tag', t);
    chip.dataset.tag = t;
    if (PREV.free !== undefined && !before.has(t)) chip.classList.add('changed');
    if (i === 0) {
      chip.classList.add('next');
      chip.title = 'Next register to be allocated';
    }
    node.append(chip);
  });
  for (let i = c.free_list.length; i < capacity; i++) {
    const slot = el('span', 'free-slot', '–');
    slot.title = 'A register in use';
    node.append(slot);
  }
}

function renderCDB(c) {
  const body = $('cdb-table').tBodies[0];
  body.replaceChildren();
  if (!c.cdb.length) {
    const tr = el('tr', 'free');
    const td = el('td', 'ins empty');
    td.append(el('span', 'none', 'idle'));
    tr.append(td);
    body.append(tr);
    return;
  }
  const before = new Set((PREV.cdb || '').split(',').filter(Boolean));
  for (const t of c.cdb) {
    const tr = el('tr');
    const td = el('td', 'ins');
    const chip = el('span', 'tag', t);
    chip.dataset.tag = t;
    if (PREV.cdb !== undefined && !before.has(t)) chip.classList.add('changed');
    const p = producerOf(c, t);
    if (p !== null) tr.dataset.insn = String(p);
    td.append(chip);
    tr.append(td);
    body.append(tr);
  }
}

const TAG_RE = /^p\d+$/;

function renderEvents(c) {
  const list = $('events');
  list.replaceChildren();
  if (!c.events.length) {
    const li = el('li');
    li.append(el('span', 'quiet', c.cycle === 0
      ? 'Reset state — nothing has been dispatched yet.'
      : 'Nothing happened this cycle.'));
    list.append(li);
    return;
  }
  c.events.forEach((e, i) => {
    const li = el('li');
    li.dataset.index = String(i);
    li.append(el('span', 'kind ' + e.kind, e.kind));
    li.append(el('span', 'detail', e.detail));
    if (e.insn_idx !== null) li.dataset.insn = String(e.insn_idx);
    if (e.blocking && TAG_RE.test(e.blocking)) li.dataset.blocking = e.blocking;
    list.append(li);
  });
  wireHover(list);
}

/** Step-by-event mode: emphasise one event and the rows it touches. */
function applyEventFocus(c) {
  for (const n of document.querySelectorAll('.focus-insn')) n.classList.remove('focus-insn');
  for (const n of document.querySelectorAll('.focus-tag')) n.classList.remove('focus-tag');
  const items = document.querySelectorAll('#events li');
  const on = S.view.events && S.sub >= 0 && S.sub < c.events.length;
  items.forEach((li, i) => {
    li.classList.toggle('current', on && i === S.sub);
    li.classList.toggle('dimmed', on && i !== S.sub);
  });
  if (!on) return;
  const e = c.events[S.sub];
  if (e.insn_idx !== null) {
    for (const n of document.querySelectorAll(`[data-insn="${CSS.escape(String(e.insn_idx))}"]`)) {
      n.classList.add('focus-insn');
    }
  }
  if (e.blocking && TAG_RE.test(e.blocking)) {
    for (const n of document.querySelectorAll(`[data-tag="${CSS.escape(e.blocking)}"]`)) {
      n.classList.add('focus-tag');
    }
  }
}

function renderSummary(c) {
  const body = $('summary-table').tBodies[0];
  body.replaceChildren();
  for (const p of S.trace.program) {
    const s = S.trace.summary[p.idx];
    const tr = el('tr');
    tr.dataset.insn = String(p.idx);
    if (s.R !== null && s.R <= c.cycle) tr.classList.add('retired-row');
    if (STAGES.some((f) => s[f] === c.cycle)) tr.classList.add('current-insn');
    tr.append(el('td', 'ins', p.display));
    for (const f of STAGES) {
      const td = el('td');
      // Show a timing only once the machine has actually reached it: the table
      // fills in as the cycle slider advances, exactly like working the slides.
      const known = s[f] !== null && s[f] <= c.cycle;
      const span = el('span', 'cell', known ? s[f] : DASH);
      if (known && s[f] === c.cycle) span.classList.add('changed');
      if (!known) td.classList.add('empty');
      td.append(span);
      tr.append(td);
    }
    body.append(tr);
  }
}

/* ------------------------------------------------------------------ */
/* dependences                                                         */
/* ------------------------------------------------------------------ */

/** The register dependences of a program, each to its *nearest* partner:
 *  RAW from the last writer of a register to each later reader of that
 *  version; WAW from the previous writer to the next; WAR from every reader
 *  of a version to the instruction that overwrites it. */
function computeDeps(program) {
  const edges = [];
  const lastWriter = Object.create(null);     // reg -> insn idx
  const readersSince = Object.create(null);   // reg -> [insn idx] since the last write
  for (const p of program) {
    for (const r of p.srcs) {
      if (lastWriter[r] !== undefined) edges.push({ kind: 'raw', from: lastWriter[r], to: p.idx, reg: r });
      (readersSince[r] = readersSince[r] || []).push(p.idx);
    }
    if (p.dest) {
      for (const i of readersSince[p.dest] || []) {
        if (i !== p.idx) edges.push({ kind: 'war', from: i, to: p.idx, reg: p.dest });
      }
      if (lastWriter[p.dest] !== undefined) edges.push({ kind: 'waw', from: lastWriter[p.dest], to: p.idx, reg: p.dest });
      lastWriter[p.dest] = p.idx;
      readersSince[p.dest] = [];
    }
  }
  return edges;
}

/** RAW edges whose consumer is sitting in a reservation station right now,
 *  waiting for that producer's tag. */
function blockingPairs(c) {
  const pairs = new Set();
  for (const r of c.rs) {
    if (!r.busy || r.issued) continue;
    for (const [tag, ready] of [[r.T1, r.T1_ready], [r.T2, r.T2_ready]]) {
      if (!tag || ready) continue;
      const p = producerOf(c, tag);
      if (p !== null) pairs.add(`${p}>${r.insn_idx}`);
    }
  }
  return pairs;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  return n;
};

function stageAt(s, cycle) {
  let stage = null;
  for (const f of STAGES) if (s[f] !== null && s[f] <= cycle) stage = f;
  return stage;
}

/* ------------------------------------------------------------------ */
/* the dependence graph: a tree, the parallelism the program allows    */
/* ------------------------------------------------------------------ */

/** How deep each instruction sits in the RAW graph: 0 when it waits for
 *  nothing, else one past its deepest producer.  Name dependences do not
 *  count: renaming removes them.  This is the step an ideal machine (no
 *  resource limits, every instruction one step long) would run it in. */
function computeLevels(program) {
  const level = program.map(() => 0);
  for (const e of computeDeps(program)) {   // edges come in order of their consumer
    if (e.kind === 'raw') level[e.to] = Math.max(level[e.to], level[e.from] + 1);
  }
  return level;
}

/** One column per level, left to right; the instructions of a level stacked
 *  in it, since nothing keeps them apart.  A program with no true dependences
 *  is a single vertical line, a pure chain a single horizontal one.
 *  `opts.svg` and `opts.note` draw into the lesson page instead of the panel;
 *  `opts.structureOnly` leaves out the stage colours and the blocking edges. */
function renderDeps(c, opts = {}) {
  const svg = opts.svg || $('deps-svg');
  const note = opts.note || $('deps-note');
  svg.replaceChildren();
  if (!opts.svg && !S.view.showDeps) return;
  const markerId = (kind) => (opts.svg ? 'l-' : '') + 'arrow-' + kind;
  const program = S.trace.program;
  const n = program.length;
  if (!n) return;
  const level = computeLevels(program);
  const merged = new Map();                 // "from>to" -> edge, registers joined
  for (const e of computeDeps(program)) {
    if (e.kind !== 'raw') continue;
    const k = `${e.from}>${e.to}`;
    if (!merged.has(k)) merged.set(k, { from: e.from, to: e.to, regs: [] });
    if (!merged.get(k).regs.includes(e.reg)) merged.get(k).regs.push(e.reg);
  }
  const edges = [...merged.values()];

  // rows: a consumer sits level with the middle of its producers, pushed
  // down past whatever already holds that place in its column.  An edge that
  // skips columns takes a lane of its own in each one it crosses (e.via, the
  // row it passes at), so it never runs through an instruction on the way.
  const depth = Math.max(...level) + 1;
  const row = new Array(n).fill(0);
  const lastRow = (e) => (e.via.length ? e.via[e.via.length - 1] : row[e.from]);
  for (const e of edges) e.via = [];
  let rows = 0, widest = 0;
  for (let l = 0; l < depth; l++) {
    const col = program.filter((p) => level[p.idx] === l).map((p) => {
      const from = edges.filter((e) => e.to === p.idx).map(lastRow);
      return { idx: p.idx, want: from.length ? from.reduce((a, b) => a + b, 0) / from.length : p.idx };
    });
    widest = Math.max(widest, col.length);
    for (const e of edges) {
      if (level[e.from] < l && l < level[e.to]) col.push({ lane: e, idx: e.to, want: lastRow(e) });
    }
    col.sort((a, b) => a.want - b.want || !!a.lane - !!b.lane || a.idx - b.idx);
    let next = 0, prev = null;
    for (const m of col) {
      if (prev && (prev.lane || m.lane)) next -= 0.4;     // a lane needs less room than a circle
      const at = l ? Math.max(m.want, next) : next;
      if (m.lane) m.lane.via.push(at); else row[m.idx] = at;
      next = at + 1;
      prev = m;
    }
    rows = Math.max(rows, next);
  }

  const gapX = 84, gapY = 38, r = 13, pad = 24, head = 16;
  const width = pad * 2 + gapX * (depth - 1);
  const height = head + pad + gapY * (rows - 1) + pad;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const x = (i) => pad + level[i] * gapX;
  const y = (i) => head + pad + row[i] * gapY;

  const defs = svgEl('defs');
  for (const kind of ['raw', 'resolved', 'blocking']) {
    const m = svgEl('marker', { id: markerId(kind), viewBox: '0 0 8 8', refX: 7, refY: 4,
                                markerWidth: 6, markerHeight: 6, orient: 'auto' });
    m.append(svgEl('path', { d: 'M0,0 L8,4 L0,8 z', class: 'arrowhead ' + kind }));
    defs.append(m);
  }
  svg.append(defs);
  for (let l = 0; l < depth; l++) {
    const cx = pad + l * gapX;
    const h = svgEl('text', { class: 'col-h', x: cx, y: 10 });
    h.textContent = 'step ' + (l + 1);
    svg.append(h);
    svg.append(svgEl('line', { class: 'baseline', x1: cx, x2: cx, y1: head + pad, y2: height - pad }));
  }

  const blank = !!opts.structureOnly || quizBlank(c.cycle);
  const blocking = blank ? new Set() : blockingPairs(c);
  for (const e of edges) {
    const g = svgEl('g', { class: 'edge raw' });
    g.dataset.from = String(e.from);
    g.dataset.to = String(e.to);
    let state = 'raw';
    if (!blank) {
      if (blocking.has(`${e.from}>${e.to}`)) state = 'blocking';
      else if (S.trace.summary[e.from].C !== null && S.trace.summary[e.from].C <= c.cycle) state = 'resolved';
    }
    if (state !== 'raw') g.classList.add(state);
    const pts = [[x(e.from) + r, y(e.from)],
                 ...e.via.map((at, i) => [pad + (level[e.from] + 1 + i) * gapX, head + pad + at * gapY]),
                 [x(e.to) - r, y(e.to)]];
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [qx, qy] = pts[i], mid = (px + qx) / 2;
      d += ` C${mid},${py} ${mid},${qy} ${qx},${qy}`;
    }
    g.append(svgEl('path', { d, 'marker-end': `url(#${markerId(state)})` }));
    const [[x1, y1], [x2, y2]] = pts.slice(-2);          // label the stretch that arrives
    const label = svgEl('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4 });
    label.textContent = e.regs.join(',');
    g.append(label);
    const title = svgEl('title');
    title.textContent = `RAW on ${e.regs.join(', ')}: I${e.to} cannot run until I${e.from} has produced it`
      + (state === 'blocking' ? ` — I${e.to} is waiting for this value now` : '')
      + (state === 'resolved' ? ' — value available' : '');
    g.append(title);
    svg.append(g);
  }

  for (const p of program) {
    const stage = blank ? null : stageAt(S.trace.summary[p.idx], c.cycle);
    const g = svgEl('g', { class: 'node' + (stage ? ' st-' + stage : '') });
    g.dataset.insn = String(p.idx);
    g.append(svgEl('circle', { cx: x(p.idx), cy: y(p.idx), r }));
    const t = svgEl('text', { x: x(p.idx), y: y(p.idx) });
    t.textContent = 'I' + p.idx;
    g.append(t);
    const title = svgEl('title');
    title.textContent = `${p.display} — step ${level[p.idx] + 1}`
      + (level[p.idx] ? '' : ': waits for nothing')
      + (stage ? `; reached ${stage} by cycle ${c.cycle}` : '');
    g.append(title);
    svg.append(g);
  }
  {
    const s = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
    note.textContent = `${s(n, 'instruction')} in ${s(depth, 'step')}: `
      + `ILP ${(n / depth).toFixed(2).replace(/\.?0+$/, '')}, at most ${widest} at once`;
  }
}

/** `summary` is the per-instruction {D,S,X,C,R} table to draw (cycle numbers
 *  or null); the trace's own by default, the student's derived one in quiz mode. */
function renderTimeline(c, summary = S.trace.summary) {
  const table = $('timeline-table');
  // A fixed number of columns (growing only once the run passes it), so the
  // table's width never reveals how long the run is.
  const total = Math.max(MIN_TIMELINE_CYCLES, c.cycle);
  const head = el('tr');
  head.append(el('th', 'ins', 'insn'));
  const jump = (node, cy) => {
    if (cy > S.trace.cycles.length - 1) return;
    node.classList.add('jump');
    node.title = `Go to cycle ${cy}`;
    node.addEventListener('click', () => { stop(); goto(cy); });
  };
  for (let cy = 1; cy <= total; cy++) {
    const th = el('th', cy === c.cycle ? 'now' : null, cy);
    jump(th, cy);
    head.append(th);
  }
  table.tHead.replaceChildren(head);

  const body = table.tBodies[0];
  body.replaceChildren();
  for (const p of S.trace.program) {
    const s = summary[p.idx];
    const tr = el('tr');
    tr.dataset.insn = String(p.idx);
    tr.append(el('td', 'ins', `I${p.idx}`));
    for (let cy = 1; cy <= total; cy++) {
      const td = el('td');
      if (cy === c.cycle) td.classList.add('now');
      jump(td, cy);
      if (cy <= c.cycle) {
        const stage = STAGES.find((f) => s[f] === cy);
        if (stage) {
          td.textContent = stage;
          td.classList.add('stage', 'stage-' + stage);
        } else if (s.X !== null && s.C !== null && cy > s.X && cy < s.C) {
          td.textContent = 'x';                 // still executing, or waiting for the CDB
          td.classList.add('stage', 'stage-x');
        } else if (s.D !== null && cy > s.D && (s.R === null || cy < s.R)) {
          td.classList.add('inflight');         // in the machine, waiting
        }
      }
      tr.append(td);
    }
    body.append(tr);
  }
}

/* ------------------------------------------------------------------ */
/* hover: follow an instruction across tables; find a tag's producer    */
/* ------------------------------------------------------------------ */

function wireHover(root) {
  for (const node of root.querySelectorAll('[data-blocking]')) {
    const tag = node.dataset.blocking;
    node.addEventListener('mouseenter', () => highlightTag(tag));
    node.addEventListener('mouseleave', clearHighlight);
    node.addEventListener('click', () => jumpToProducer(tag));
  }
}

function highlightTag(tag) {
  for (const n of document.querySelectorAll(`[data-tag="${CSS.escape(tag)}"]`)) {
    n.classList.add('blocked');
  }
}

function clearHighlight() {
  for (const n of document.querySelectorAll('.blocked')) n.classList.remove('blocked');
}

function setInsnHighlight(idx) {
  for (const n of document.querySelectorAll('.hl-insn')) n.classList.remove('hl-insn');
  for (const n of document.querySelectorAll('.deps-panel .edge.dimmed')) n.classList.remove('dimmed');
  if (idx === null) return;
  for (const n of document.querySelectorAll(`[data-insn="${CSS.escape(idx)}"]`)) {
    n.classList.add('hl-insn');
  }
  for (const e of document.querySelectorAll('.deps-panel .edge')) {
    const touches = e.dataset.from === idx || e.dataset.to === idx;
    e.classList.toggle('hl-insn', touches);
    e.classList.toggle('dimmed', !touches);
  }
}

function jumpToProducer(tag) {
  const row = document.querySelector(`#rob-table tr[data-produces-tag="${CSS.escape(tag)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth;   // restart the animation
  row.classList.add('flash');
}

/* ------------------------------------------------------------------ */
/* lessons: the "Programs" mode                                        */
/* ------------------------------------------------------------------ */

/** The lesson list from lessons.js (loaded before this file); empty without it. */
function lessons() {
  return Array.isArray(window.LESSONS) ? window.LESSONS : [];
}

function lessonById(id) {
  return lessons().find((l) => l.id === id) || lessons().find((l) => (l.was || []).includes(id)) || null;
}

/** What a lesson calls its own machine. */
const ownLabel = (l) => (l && l.label) || 'the lesson machine';

/** The full parameter set of a lesson machine: a patch over the defaults. */
function lessonParams(patch) {
  return { ...S.api.defaults, ...(patch || {}) };
}

function sameMachine(params) {
  return S.api.params.every((p) => S.params[p.name] === params[p.name]);
}

/** Whether the program and machine on screen are the current lesson's, and
 *  on which of its two machines: `{lesson, which: 'lesson' | 'contrast'}`,
 *  or null.  Only the lesson last opened on the lesson page counts: several
 *  lessons share a program, and a program picked by hand is not a lesson. */
function lessonForCurrent() {
  if (!S.api) return null;
  const l = lessonById(S.view.lesson);
  if (!l || l.program !== S.program) return null;
  if (sameMachine(lessonParams(l.params))) return { lesson: l, which: 'lesson' };
  if (l.contrast && sameMachine(lessonParams(l.contrast.params))) return { lesson: l, which: 'contrast' };
  return null;
}

/** The other machine of a lesson as a compare target: the contrast when the
 *  lesson machine is running, the lesson machine when the contrast is. */
function otherMachine(l, which) {
  if (!l || !l.contrast) return '';
  return which === 'contrast'
    ? { label: ownLabel(l), params: { ...l.params } }
    : { label: l.contrast.label, params: { ...l.contrast.params } };
}

/** 'lesson' shows the lesson page; 'run' the execution view.  Entering the
 *  lesson page brings its lesson's program and machine back if the screen
 *  has moved on to something else (a swap, a machine tweak). */
function setMode(mode) {
  const lesson = mode === 'lesson';
  S.view.mode = lesson ? 'lesson' : 'run';
  saveView();
  stop();
  applyView();
  if (!lesson) {
    if (S.trace) render();
    return Promise.resolve();
  }
  const cur = lessonForCurrent();
  if (cur && cur.which === 'lesson') {
    if (S.trace) { render(); return Promise.resolve(); }
    return loadSelected();
  }
  // A remembered lesson may be gone from the list (parked, renamed): fall
  // back to the first rather than show an empty page.
  const l = lessonById(S.view.lesson) || lessons()[0];
  return l ? selectLesson(l.id) : Promise.resolve();
}

/** Show a lesson: its program on its machine, its contrast as the comparison. */
function selectLesson(id) {
  const l = lessonById(id);
  if (!l || !S.api) return Promise.resolve();
  S.view.lesson = l.id;
  S.view.compare = otherMachine(l, 'lesson');
  saveView();
  S.program = l.program;
  rememberProgram();
  return setParams({ ...l.params }, true);      // re-simulates, then renders
}

/** Run the current lesson in the execution view from cycle 1, on its own
 *  machine or on its contrast machine; the other one becomes the comparison. */
function runLesson(which) {
  const l = lessonById(S.view.lesson);
  if (!l || !S.api) return Promise.resolve();
  const contrast = which === 'contrast' && !!l.contrast;
  S.view.compare = otherMachine(l, contrast ? 'contrast' : 'lesson');
  S.view.mode = 'run';
  saveView();
  S.program = l.program;
  rememberProgram();
  applyView();
  S.cycle = 1;
  return setParams({ ...(contrast ? l.contrast.params : l.params) }, true);
}

function prose(node, paras) {
  node.replaceChildren();
  for (const t of paras || []) node.append(el('p', null, t));
}

function bigNumber(n, caption) {
  const box = el('div', 'lesson-total');
  box.append(el('b', null, n));
  box.append(el('span', null, caption));
  return box;
}

/** A full-run timing table; cells earlier / later than `other` are coloured
 *  like the compare block's. */
function timingTable(title, summary, other, program) {
  const wrap = el('div', 'lesson-timing');
  wrap.append(el('h2', 'lesson-h', title));
  const table = el('table', 'summary compare');
  const head = table.createTHead().insertRow();
  head.append(el('th', 'ins', 'instruction'));
  for (const f of STAGES) head.append(el('th', null, f));
  const body = table.createTBody();
  for (const p of program) {
    const tr = body.insertRow();
    tr.dataset.insn = String(p.idx);
    tr.append(el('td', 'ins', p.display));
    const mine = summary[p.idx] || {};
    const theirs = (other && other[p.idx]) || {};
    for (const f of STAGES) {
      const v = mine[f];
      const td = el('td', null, v === null || v === undefined ? DASH : v);
      if (v !== null && v !== undefined && theirs[f] !== null && theirs[f] !== undefined) {
        if (v < theirs[f]) td.classList.add('earlier');
        else if (v > theirs[f]) td.classList.add('later');
      }
      tr.append(td);
    }
  }
  wrap.append(table);
  return wrap;
}

/** The lesson page: the rail, then the current lesson's program, machine,
 *  result and explanation.  Everything numeric comes from the trace on
 *  screen (the lesson machine) and the compare trace (its contrast). */
function renderLesson() {
  const list = lessons();
  const l = lessonById(S.view.lesson) || list[0] || null;
  const rail = $('lesson-rail');
  rail.replaceChildren();
  list.forEach((x, i) => {
    const b = el('button', 'lesson-item' + (l && x.id === l.id ? ' current' : ''));
    b.type = 'button';
    b.dataset.lesson = x.id;
    b.append(el('span', 'lesson-num', String(i + 1)));
    const body = el('span', 'lesson-item-body');
    body.append(el('b', null, x.title));
    body.append(el('span', 'lesson-item-point', x.point));
    b.append(body);
    b.addEventListener('click', () => selectLesson(x.id));
    rail.append(b);
  });
  $('lesson-main').hidden = !l;
  if (!l || !S.trace) return;

  $('lesson-index').textContent = `Lesson ${list.indexOf(l) + 1} of ${list.length}`;
  $('lesson-title').textContent = l.title;
  $('lesson-point').textContent = l.point;
  $('lesson-program-name').textContent = `programs/${l.program}.txt`;

  // the program: reads, writes, and the true dependences it waits on
  const program = S.trace.program;
  const raw = computeDeps(program).filter((e) => e.kind === 'raw');
  const pbody = $('lesson-program').tBodies[0];
  pbody.replaceChildren();
  for (const p of program) {
    const tr = el('tr');
    tr.dataset.insn = String(p.idx);
    tr.append(el('td', null, `I${p.idx}`));
    tr.append(el('td', 'ins', p.text || p.display));
    tr.append(el('td', 'ins', p.srcs.length ? p.srcs.join(', ') : DASH));
    tr.append(el('td', 'ins', p.dest || DASH));
    const waits = raw.filter((e) => e.to === p.idx).map((e) => `I${e.from} (${e.reg})`);
    tr.append(el('td', 'ins waits', waits.length ? waits.join(', ') : DASH));
    pbody.append(tr);
  }
  $('lesson-deps').hidden = !l.showDeps;
  if (l.showDeps) {
    renderDeps(S.trace.cycles[0], { svg: $('lesson-deps-svg'), note: $('lesson-deps-note'), structureOnly: true });
  }
  prose($('lesson-program-text'), l.explain && l.explain.program);

  // the machine: the knobs in play, on the lesson machine and its contrast
  const contrast = S.comparison ? l.contrast : null;
  $('lesson-knobs-own').textContent = contrast ? ownLabel(l) : 'lesson machine';
  const lp = lessonParams(l.params);
  const cp = contrast ? lessonParams(contrast.params) : null;
  const ch = $('lesson-knobs-contrast');
  ch.textContent = contrast ? contrast.label : '';
  ch.hidden = !contrast;
  const kbody = $('lesson-knobs').tBodies[0];
  kbody.replaceChildren();
  const show = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v).replace(/_/g, ' '));
  for (const name of l.knobs || []) {
    const p = S.api.params.find((q) => q.name === name);
    if (!p) continue;
    const tr = el('tr');
    tr.dataset.param = name;
    const label = el('td', 'ins knob', p.label);
    label.title = p.help || '';
    tr.append(label);
    const a = el('td', 'val', show(lp[name]));
    if (lp[name] !== S.api.defaults[name]) a.classList.add('non-default');
    tr.append(a);
    if (cp) {
      const b = el('td', 'val', show(cp[name]));
      if (cp[name] !== S.api.defaults[name]) b.classList.add('non-default');
      if (cp[name] !== lp[name]) { a.classList.add('differs'); b.classList.add('differs'); }
      tr.append(b);
    }
    kbody.append(tr);
  }
  $('lesson-config').replaceChildren(summaryLine($('config-summary').textContent));
  prose($('lesson-feature-text'), l.explain && l.explain.feature);

  // the result: the same program on both machines — total cycles and the two
  // timing tables, side by side.  Only a lesson with a contrast has one.
  $('lesson-result').hidden = !contrast;
  const other = contrast ? S.compareTrace : null;
  const totals = $('lesson-totals');
  totals.replaceChildren();
  totals.append(bigNumber(S.trace.total_cycles, `cycles on ${ownLabel(l)}`));
  if (contrast) totals.append(bigNumber(other ? other.total_cycles : '…', `cycles on ${contrast.label}`));
  const tim = $('lesson-timings');
  tim.replaceChildren();
  tim.append(timingTable(ownLabel(l), S.trace.summary, other ? other.summary : null, program));
  if (other) tim.append(timingTable(contrast.label, other.summary, S.trace.summary, program));
  $('lesson-compare-note').hidden = !other;

  // what to watch: on the lesson machine, and (under a heading each) on the contrast
  const watch = $('lesson-watch');
  watch.replaceChildren();
  const theirs = (contrast && contrast.watch) || [];
  if (theirs.length) watch.append(el('li', 'lesson-watch-h', `On ${ownLabel(l)}`));
  for (const t of (l.explain && l.explain.watch) || []) watch.append(el('li', null, t));
  if (theirs.length) watch.append(el('li', 'lesson-watch-h', `On ${contrast.label}`));
  for (const t of theirs) watch.append(el('li', null, t));
  $('btn-run-lesson').textContent = contrast ? `Run on ${ownLabel(l)} →` : 'Run it →';
  $('btn-run-contrast').hidden = !contrast;
  $('btn-run-contrast').textContent = l.contrast ? `Run on ${l.contrast.label} →` : '';
}

/** The strip under the controls in the execution view: which lesson the
 *  program on screen belongs to, which of its machines is running, and the
 *  lesson's note for this cycle.  Hidden in quiz mode and for other programs. */
/* PARKED: the strip's "Swap to <the other machine>" button took a lot of the
 * strip's room.  The other machine is run from the lesson page ("Run on … →");
 * flip SWAP_ENABLED to bring the button back. */
const SWAP_ENABLED = false;

/* PARKED: the strip's note for the current cycle — the yellow bar, or the
 * lesson's one-line point on a cycle with no note.  It is still filled in from
 * the lessons' callouts (and the tests read it), but not shown; flip
 * CALLOUT_ENABLED to bring it back. */
const CALLOUT_ENABLED = false;

function renderLessonStrip(c) {
  const strip = $('lesson-strip');
  const cur = S.quiz ? null : lessonForCurrent();
  strip.hidden = !cur;
  if (!cur) return;
  const { lesson: l, which } = cur;
  $('lesson-strip-title').textContent = l.title;
  $('lesson-strip-machine').textContent = which === 'contrast' ? `on ${l.contrast.label}` : `on ${ownLabel(l)}`;
  const notes = which === 'contrast' ? l.contrast.callouts : l.callouts;        // each machine has its own
  const note = notes ? notes[c.cycle] : undefined;
  const box = $('lesson-strip-callout');
  box.textContent = note || l.point;
  box.classList.toggle('callout', !!note);
  box.hidden = !CALLOUT_ENABLED;
  renderEventNote(c);
  const swap = $('btn-lesson-swap');
  swap.hidden = !SWAP_ENABLED || !S.comparison || !l.contrast;
  swap.textContent = which === 'contrast' ? `Swap to ${ownLabel(l)}` : `Swap to ${l.contrast ? l.contrast.label : ''}`;
  swap.dataset.which = which === 'contrast' ? 'lesson' : 'contrast';
}

/* PARKED: the per-event note is not part of the current product.  Flip
 * EVENT_NOTE_ENABLED to bring it back; everything below it (renderEventNote,
 * explainEvent, the #lesson-strip-event row in index.html and its CSS) is in
 * place and still covered by tests/viewer.test.mjs through OoO.explainEvent. */
const EVENT_NOTE_ENABLED = false;

/** Stepping one event at a time: the row under the callout that says what
 *  the current event did and why, in the lesson's terms. */
function renderEventNote(c) {
  const box = $('lesson-strip-event');
  const on = EVENT_NOTE_ENABLED && S.view.events && !S.quiz && S.sub >= 0 && S.sub < c.events.length;
  box.hidden = !on;
  if (!on) return;
  const e = c.events[S.sub];
  box.replaceChildren(el('span', 'kind ' + e.kind, e.kind), el('span', null, explainEvent(c, e)));
}

const KIND_WORD = { DISPATCH: 'dispatch', ISSUE: 'issue', EXECUTE: 'execute', COMPLETE: 'complete',
                    RETIRE: 'retire', STALL: 'stall' };

/** One or two sentences on an event, composed from the trace: the instruction,
 *  the structures it touched and what that means for the ones around it.  No
 *  pipeline semantics are decided here; everything is read off the cycle. */
function explainEvent(c, e) {
  const cfg = S.trace.config;
  const prog = S.trace.program;
  const sum = S.trace.summary;
  const I = (i) => `I${i}`;
  const list = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
  const plural = (n, one, many) => (n === 1 ? one : many);
  if (e.insn_idx === null) return e.detail;
  const idx = e.insn_idx;
  const p = prog[idx];
  const me = I(idx);
  const rob = c.rob.find((r) => r.busy && r.insn_idx === idx) || null;
  const rs = c.rs.find((r) => r.busy && r.insn_idx === idx) || null;
  const producerOf = (tag) => {
    const r = c.rob.find((x) => x.busy && x.T === tag);
    return r ? r.insn_idx : null;
  };
  const unitName = (kind, fu) => {
    const u = (cfg.units || []).find((x) => x.kind === kind);
    const label = u ? u.label : kind;
    const count = u ? u.count : 1;
    return count === 1 ? `the ${label}` : `${label} ${(fu || 0) + 1}`;
  };

  switch (e.kind) {
    case 'DISPATCH': {
      if (!rob) return e.detail;
      let s = `${me} (${p.text}) enters the reorder buffer at slot ${rob.slot}, the tail`
            + (rs ? `, and reservation station ${rs.slot}` : '') + `. `;
      s += `Its destination ${p.dest} is renamed to ${rob.T}`
         + (rob.Told ? `; the old mapping, ${rob.Told}, is kept as Told and goes back to the free list when ${me} retires. `
                     : `. `);
      if (rs && p.srcs.length) {
        const srcs = p.srcs.map((reg, k) => {
          const tag = k === 0 ? rs.T1 : rs.T2;
          const ready = k === 0 ? rs.T1_ready : rs.T2_ready;
          const prod = ready ? null : producerOf(tag);
          return `${reg} is ${tag}${ready ? '+' : ''}` + (ready ? '' : prod !== null ? ` (not ready: ${I(prod)} has not completed)` : ' (not ready)');
        });
        const notReady = [rs.T1_ready, rs.T2_ready].filter((r) => !r).length;
        s += `${plural(srcs.length, 'Source', 'Sources')}: ${list(srcs)}. `;
        s += notReady === 0 ? 'Everything it needs is ready, so it can issue next cycle.'
                            : `It waits in its station until ${plural(notReady, 'that tag comes', 'those tags come')} over the CDB.`;
      } else {
        s += 'It has no register sources, so it can issue next cycle.';
      }
      return s;
    }
    case 'ISSUE': {
      const tags = rs ? [rs.T1, rs.T2].filter((t) => t).map((t) => t + '+') : [];
      let s = `${me}'s ${tags.length ? `${plural(tags.length, 'operand', 'operands')} ${list(tags)} ${plural(tags.length, 'is', 'are')}` : 'operands are'} ready, so it is picked from the reservation stations`
            + (rob && rob.unit ? ` and sent to ${unitName(rob.unit, rob.fu)}` : '') + '. It executes next cycle. ';
      const olderWaiting = c.rs.filter((r) => r.busy && !r.issued && r.insn_idx < idx).map((r) => I(r.insn_idx));
      if (olderWaiting.length) {
        s += `${list(olderWaiting)} ${plural(olderWaiting.length, 'is', 'are')} older but still waiting for operands: ${me} issues past ${plural(olderWaiting.length, 'it', 'them')}. This is out-of-order issue.`;
      } else {
        s += 'Nothing older is waiting: it is the oldest ready instruction.';
      }
      return s;
    }
    case 'EXECUTE': {
      if (/forwarded from X/.test(e.detail)) {
        return `${me}'s result, ${e.blocking}, is forwarded straight out of the execute stage (the X bypass): `
             + 'anything waiting on it may issue now, a cycle before the CDB broadcast.';
      }
      if (!rob || rob.X === null) return e.detail;
      const latency = rob.x_done - rob.X + 1;
      let s = `${me} computes ${p.text}` + (rob.value !== null ? ` = ${rob.value}` : '')
            + ` on ${unitName(rob.unit, rob.fu)}`;
      s += latency > 1 ? ` over ${latency} cycles (${rob.X}–${rob.x_done}), so it can complete at cycle ${rob.x_done + 1}. `
                       : ', so it can complete next cycle. ';
      s += 'Its reservation station is released.';
      return s;
    }
    case 'COMPLETE': {
      const tag = e.blocking;
      const value = rob ? rob.value : null;
      const consumers = c.rs.filter((r) => r.busy && (r.T1 === tag || r.T2 === tag));
      const now = consumers.filter((r) => r.issued && sum[r.insn_idx].S === c.cycle).map((r) => I(r.insn_idx));
      const later = consumers.filter((r) => !(r.issued && sum[r.insn_idx].S === c.cycle)).map((r) => I(r.insn_idx));
      const m = c.map_table.find((x) => x.tag === tag);
      let s = `${me}'s result` + (value !== null ? ` (${p.dest} = ${value})` : '') + ` goes out on the CDB as ${tag}. `;
      s += `Every reservation station holding ${tag} sets its ready bit`;
      if (now.length) s += `: ${list(now)} ${plural(now.length, 'hears', 'hear')} it and ${plural(now.length, 'issues', 'issue')} in this same cycle (the C → S bypass)`;
      if (later.length) s += `${now.length ? ';' : ':'} ${list(later)} ${now.length ? 'also ' : ''}${plural(later.length, 'has', 'have')} it now`;
      if (!consumers.length) s += '; nothing is waiting for it';
      s += '. ';
      s += m ? `The map table's ${m.reg} shows ${tag}+.`
             : `${p.dest} has been renamed again since, so the map table no longer points at ${tag}.`;
      return s;
    }
    case 'RETIRE': {
      const prev = c.cycle > 0 ? S.trace.cycles[c.cycle - 1].rob.find((r) => r.busy && r.insn_idx === idx) : null;
      const t = sum[idx];
      let s = `${me} leaves the head of the reorder buffer. Retirement is in program order, so everything before it has already retired. `;
      if (prev) {
        s += `${p.dest} now lives in ${prev.T} for good`
           + (prev.Told ? `, and ${prev.Told}, where the previous ${p.dest} lived, returns to the free list. ` : '. ');
      }
      if (t.C !== null && t.C < c.cycle - 1) {
        const waited = c.cycle - t.C - 1;
        s += `It completed back at cycle ${t.C} and waited ${waited} ${plural(waited, 'cycle', 'cycles')} for the instructions ahead of it.`;
      }
      return s.trim();
    }
    case 'STALL': {
      const b = e.blocking;
      if (b && TAG_RE.test(b)) {
        const prod = producerOf(b);
        let s = `${me} is waiting for ${b}` + (prod !== null ? `, ${I(prod)}'s result, which has not been broadcast yet` : '') + '. It stays in its reservation station. ';
        if (prod !== null) {
          const pt = sum[prod];
          if (pt.S === null || pt.S >= c.cycle) s += `${I(prod)} has not begun executing yet.`;
          else if (pt.X === null || pt.X > c.cycle) s += `${I(prod)} issued and executes next cycle.`;
          else s += `${I(prod)} is executing` + (pt.C !== null ? `; it completes at cycle ${pt.C}.` : '.');
        }
        return s.trim();
      }
      if (b === 'ROB_FULL') {
        const head = c.rob.find((r) => r.head);
        return `${me} cannot dispatch: all ${cfg.rob_size} reorder buffer ${plural(cfg.rob_size, 'slot is', 'slots are')} occupied. `
             + `A slot frees only when the head` + (head ? `, ${I(head.insn_idx)},` : '') + ` retires`
             + (cfg.same_cycle_resource_reuse ? '.' : ', and it is usable the cycle after.');
      }
      if (b === 'RS_FULL') {
        return `${me} cannot dispatch: all ${cfg.n_rs} reservation ${plural(cfg.n_rs, 'station is', 'stations are')} occupied. `
             + 'A station frees when its instruction begins executing'
             + (cfg.same_cycle_resource_reuse ? '.' : ', and it is usable the cycle after.');
      }
      if (b === 'FREE_LIST_EMPTY') {
        return `${me} cannot dispatch: the free list is empty, so there is no physical register to rename ${p.dest} to. `
             + 'A register comes back when an instruction retires and releases its Told'
             + (cfg.same_cycle_resource_reuse ? '.' : ', and it is usable the cycle after.');
      }
      if (b === 'REG_BUSY') {
        return `${me} cannot dispatch: this machine does not rename, so ${p.dest} is one storage location, and an older instruction that reads or writes ${p.dest} is still in flight. `
             + `${me} waits until it retires` + (cfg.same_cycle_resource_reuse ? '.' : ', and dispatches the cycle after.');
      }
      if (b === 'CDB_BUSY') {
        return `${me} has finished executing, but the CDB carries ${cfg.cdb_width} ${plural(cfg.cdb_width, 'result', 'results')} per cycle and older results took it. `
             + (rob ? `Its ${rob.T} waits to broadcast next cycle.` : 'It waits to broadcast next cycle.');
      }
      if (b === 'OLDER_INSN_FIRST') {
        return `${me} is ready, but the issue width is ${cfg.issue_width} and older ready instructions took the ${plural(cfg.issue_width, 'slot', 'slots')}. `
             + 'Issue always picks the oldest ready instructions first.';
      }
      if (b === 'NO_FUNCTIONAL_UNIT') {
        const kind = p.unit;
        return `${me} is ready, but no ${unitName(kind, 0).replace(/^the /, '').replace(/ \d+$/, '')} can take it this cycle: `
             + e.detail.replace(/^I\d+ is ready but /, '') + '.';
      }
      return e.detail;
    }
    default:
      return e.detail;
  }
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

function goto(cycle) {
  const max = S.trace.cycles.length - 1;
  S.cycle = Math.max(0, Math.min(max, cycle));
  S.sub = -1;
  if (S.cycle === max) stop();
  render();
}

/** Forward/back honour step-by-event mode: within a cycle the sequence is
 *  "whole cycle", then each event in turn; then the next cycle.  The last
 *  cycle is the end of the run: forward does nothing there, rather than
 *  stepping into its events. */
function stepForward() {
  if (S.cycle >= S.trace.cycles.length - 1) return;
  const events = S.trace.cycles[S.cycle].events;
  if (S.view.events && !S.quiz && S.sub < events.length - 1) {
    S.sub += 1;
    render();
    return;
  }
  goto(S.cycle + 1);
}

function stepBack() {
  if (S.view.events && !S.quiz && S.sub >= 0) {
    S.sub -= 1;
    render();
    return;
  }
  if (S.cycle === 0) return;
  goto(S.cycle - 1);
  if (S.view.events && !S.quiz) {
    S.sub = S.trace.cycles[S.cycle].events.length - 1;
    render();
  }
}

function play() {
  if (S.playing) return;
  if (S.cycle >= S.trace.cycles.length - 1) S.cycle = 0;
  S.playing = true;
  $('btn-play').textContent = '⏸';
  $('btn-play').classList.add('playing');
  S.timer = setInterval(() => goto(S.cycle + 1), Number($('speed').value));
}

function stop() {
  S.playing = false;
  clearInterval(S.timer);
  S.timer = null;
  $('btn-play').textContent = '▶';
  $('btn-play').classList.remove('playing');
}

function setQuiz(on) {
  S.quiz = on;
  $('quiz-mode').checked = on;
  S.sub = -1;
  stop();
  // Open on the first cycle there is something to fill in.
  if (on && S.trace && S.cycle < quizStart()) S.cycle = quizStart();
  render();
}

function setQuizStart(n) {
  const v = Math.max(0, Math.floor(Number(n)) || 0);
  setView({ quizStart: v });
  if (S.quiz && S.trace && S.cycle < quizStart()) goto(quizStart());
}

function selectProgram(name) {
  S.program = name;
  rememberProgram();
  stop();
  return loadSelected();
}

function wireControls() {
  $('btn-forward').addEventListener('click', () => { stop(); stepForward(); });
  $('btn-back').addEventListener('click', () => { stop(); stepBack(); });
  $('btn-reset').addEventListener('click', () => { stop(); goto(0); });
  $('btn-play').addEventListener('click', () => (S.playing ? stop() : play()));
  $('cycle-slider').addEventListener('input', (e) => { stop(); goto(Number(e.target.value)); });
  $('speed').addEventListener('change', () => { if (S.playing) { stop(); play(); } });
  $('quiz-mode').addEventListener('change', (e) => setQuiz(e.target.checked));

  $('machine-preset').addEventListener('change', (e) => { if (e.target.value) applyPreset(e.target.value); });
  $('btn-machine-reset').addEventListener('click', () => applyPreset('default'));

  for (const r of document.querySelectorAll('input[name="layout"]')) {
    r.addEventListener('change', () => { if (r.checked) setView({ layout: r.value }); });
  }
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', () => { if (r.checked) setMode(r.value); });
  }
  $('btn-run-lesson').addEventListener('click', () => runLesson('lesson'));
  $('btn-run-contrast').addEventListener('click', () => runLesson('contrast'));
  $('btn-lesson-back').addEventListener('click', () => setMode('lesson'));
  $('btn-lesson-swap').addEventListener('click', (e) => runLesson(e.currentTarget.dataset.which || 'contrast'));
  $('opt-changes').addEventListener('change', (e) => setView({ changes: e.target.checked }));
  $('opt-events').addEventListener('change', (e) => setView({ events: e.target.checked }));
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(-1));
  $('zoom-readout').addEventListener('click', () => resetZoom());
  $('panel-log').addEventListener('change', (e) => setView({ showLog: e.target.checked }));
  $('panel-deps').addEventListener('change', (e) => setView({ showDeps: e.target.checked }));
  $('quiz-drag').addEventListener('change', (e) => setView({ quizDrag: e.target.checked }));
  $('quiz-start').addEventListener('change', (e) => setQuizStart(e.target.value));
  $('btn-print').addEventListener('click', () => window.print());

  document.addEventListener('mouseover', (e) => {
    const n = e.target.closest && e.target.closest('[data-insn]');
    if (n) setInsnHighlight(n.dataset.insn);
  });
  document.addEventListener('mouseout', (e) => {
    const n = e.target.closest && e.target.closest('[data-insn]');
    if (n && !(e.relatedTarget && n.contains(e.relatedTarget))) setInsnHighlight(null);
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    if (S.view.mode === 'lesson') {
      // the lesson page: the arrows walk the lessons, Enter runs the current one
      const list = lessons();
      const i = Math.max(0, list.findIndex((l) => l.id === S.view.lesson));
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { if (list[i + 1]) selectLesson(list[i + 1].id); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { if (i > 0) selectLesson(list[i - 1].id); }
      else if (e.key === 'Enter') runLesson('lesson');
      else return;
      e.preventDefault();
      return;
    }
    if (!S.trace) return;
    if (e.key === 'ArrowRight') { stop(); stepForward(); }
    else if (e.key === 'ArrowLeft') { stop(); stepBack(); }
    else if (e.key === ' ') { S.playing ? stop() : play(); }
    else if (e.key === 'Home') { stop(); goto(0); }
    else if (e.key === 'End') { stop(); goto(S.trace.cycles.length - 1); }
    else if (e.key === '=' || e.key === '+') zoomBy(1);
    else if (e.key === '-' || e.key === '_') zoomBy(-1);
    else if (e.key === '0') resetZoom();
    else return;
    e.preventDefault();          // the key moved the cycle, not the page
  });
}

/** What a quiz submission must carry so cli/grade.mjs can rebuild the trace it
 *  was made against, whatever machine and program were on screen. */
function submissionExtras() {
  return {
    program: S.program,
    params: { ...S.params },
    program_text: currentProgramText(),
  };
}

/* The API quiz.js builds on, and what the tests drive.  Explicit on purpose:
 * cross-file references go through window, never through shared top-level
 * lexical scope, so the two files stay loadable in any order of evaluation. */
window.OoO = { S, $, el, render, goto, stepForward, stepBack, loadSelected, setQuiz, setView, saveView,
               quizStart, quizBlank, setQuizStart, renderTimeline, zoomLevel, zoomBy,
               loadCompare, setParams, applyPreset, selectProgram,
               changedParams, submissionExtras, operandText, mapText, htText, producerOf, explainEvent,
               computeDeps, computeLevels, blockingPairs, unitsOf, describeUnits,
               setMode, selectLesson, runLesson, lessonForCurrent, lessons, compareTarget, setComparison,
               DASH, STAGES, PRESETS, MACHINE_TITLE, MIN_TIMELINE_CYCLES };

boot();
