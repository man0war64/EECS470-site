/* The answer key for quiz mode: what counts as correct, derived from a
 * trace's `cycles` block by the viewer's own display rules, and how student
 * input is normalised before comparison.
 *
 * One copy, shared: quiz.js (the page) and cli/grade.mjs (the grader) both
 * use it, so a lenient spelling accepted on screen is accepted by the grader
 * and vice versa.  Presentation lives here; pipeline semantics do not:
 * nothing in this file knows what a reorder buffer *does*, only how a cycle
 * object is spelled on a slide.
 *
 * Plain script, no DOM: defines window.QuizKey in a page and module.exports
 * under require(). */

(function (root) {
'use strict';

const DASH = '—';
const ROB_FIELDS = ['ht', 'insn', 'T', 'Told', 'S', 'X', 'C'];
const RS_FIELDS = ['busy', 'insn', 'T', 'T1', 'T2'];
const FORMAT = 'ooo-quiz-submission';

const EMPTY_RE = /^(-+|—|–|none|empty|n\/a|na|free|arf(=.*)?)$/;
const INSN_RE = /^i?(\d+)(:.*)?$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ---------------- normalisation ---------------- */

function norm(s) {
  const t = String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return EMPTY_RE.test(t) ? '' : t;
}

/** "I0", "i0", "0", "I0: R3=R1+R2" or the instruction text -> "i0". */
function normInsn(s, program) {
  const t = norm(s);
  if (t === '') return '';
  const m = INSN_RE.exec(t);
  if (m) return 'i' + Number(m[1]);
  const hit = (program || []).find((p) => p.text.toLowerCase().replace(/\s+/g, '') === t);
  return hit ? 'i' + hit.idx : t;
}

function normHT(s) {
  const t = norm(s).replace(/[^ht]/g, '');
  return (t.includes('h') ? 'h' : '') + (t.includes('t') ? 't' : '');
}

/** The slide's `busy` column: `y` or blank. */
function normBusy(s) {
  const t = norm(s);
  return ['y', 'yes', '1', 'true', 'busy', 'b', 'x', '*'].includes(t) ? 'y' : '';
}

function normList(s) {
  return String(s ?? '').split(/[,\s]+/).map(norm).filter(Boolean);
}

/* ---------------- display rules (as viewer.js draws them) ---------------- */

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

/* ---------------- expected answers and comparison ---------------- */

const num = (v) => (v === null || v === undefined ? '' : String(v));

function expectedCycle(trace, c) {
  return {
    rob: c.rob.map((r) => ({
      ht: htText(r),
      insn: r.busy ? `I${r.insn_idx}` : '',
      T: r.T || '', Told: r.Told || '',
      S: num(r.S), X: num(r.X), C: num(r.C),
    })),
    map: Object.fromEntries(c.map_table.map((m) => [m.reg, m.tag === null ? '' : mapText(m)])),
    free: c.free_list.join(' '),
    cdb: c.cdb.join(' '),
    rs: c.rs.map((r) => ({
      busy: r.busy ? 'y' : '',
      insn: r.busy ? `I${r.insn_idx}` : '',
      T: r.T || '',
      T1: r.busy ? operandText(r, 1) : '',
      T2: r.busy ? operandText(r, 2) : '',
    })),
  };
}

function blankCycle(trace) {
  const regs = trace.cycles[0].map_table.map((m) => m.reg);
  return {
    rob: Array.from({ length: trace.config.rob_size }, () => Object.fromEntries(ROB_FIELDS.map((f) => [f, '']))),
    map: Object.fromEntries(regs.map((r) => [r, ''])),
    free: '', cdb: '',
    rs: Array.from({ length: trace.config.n_rs }, () => Object.fromEntries(RS_FIELDS.map((f) => [f, '']))),
  };
}

/** Nothing answered at all (tolerates any shape, or no object). */
function isBlankCycle(a) {
  if (!isObj(a)) return true;
  const rows = [...(Array.isArray(a.rob) ? a.rob : []), ...(Array.isArray(a.rs) ? a.rs : [])];
  if (rows.some((r) => isObj(r) && Object.values(r).some((v) => norm(v)))) return false;
  if (isObj(a.map) && Object.values(a.map).some((v) => norm(v))) return false;
  return !(norm(a.free) || norm(a.cdb));
}

function row(seq, i) {
  if (!Array.isArray(seq)) return {};
  const r = seq[i];
  return isObj(r) ? r : {};
}

/** `{cycle, cells, correct, total}`.  Cells come in a fixed order (ROB rows,
 *  map, free, CDB, RS rows) that quiz.js relies on to mark inputs; do not
 *  reorder.  `got` is the student's answer object, or anything at all. */
function compareCycle(trace, c, got) {
  const program = trace.program;
  const want = expectedCycle(trace, c);
  got = isObj(got) ? got : {};
  const cells = [];
  const push = (struct, slot, field, w, g, ok, hint) =>
    cells.push({ struct, slot, field, expected: w, answer: g === null || g === undefined ? '' : String(g),
                 correct: !!ok, hint: hint || null });

  want.rob.forEach((w, i) => {
    const g = row(got.rob, i);
    for (const f of ROB_FIELDS) {
      const gv = g[f] ?? '';
      const ok = f === 'ht' ? normHT(w[f]) === normHT(gv)
        : f === 'insn' ? normInsn(w[f], program) === normInsn(gv, program)
        : norm(w[f]) === norm(gv);
      push('rob', i + 1, f, w[f], gv, ok);
    }
  });
  const gmap = isObj(got.map) ? got.map : {};
  for (const reg of Object.keys(want.map)) {
    const gv = gmap[reg] ?? '';
    push('map', reg, 'tag', want.map[reg], gv, norm(want.map[reg]) === norm(gv));
  }
  {
    const w = normList(want.free), g = normList(got.free);
    const ok = w.length === g.length && w.every((t, i) => t === g[i]);
    const sameSet = !ok && w.slice().sort().join(' ') === g.slice().sort().join(' ');
    push('free', null, 'list', want.free, got.free ?? '', ok,
         sameSet ? 'right registers, wrong order (the free list is a FIFO)' : null);
  }
  {
    const w = normList(want.cdb), g = normList(got.cdb);
    push('cdb', null, 'list', want.cdb, got.cdb ?? '',
         w.slice().sort().join(' ') === g.slice().sort().join(' '));
  }
  want.rs.forEach((w, i) => {
    const g = row(got.rs, i);
    for (const f of RS_FIELDS) {
      const gv = g[f] ?? '';
      const ok = f === 'insn' ? normInsn(w[f], program) === normInsn(gv, program)
        : f === 'busy' ? normBusy(w[f]) === normBusy(gv)
        : norm(w[f]) === norm(gv);
      push('rs', i + 1, f, w[f], gv, ok);
    }
  });
  const correct = cells.filter((x) => x.correct).length;
  return { cycle: c.cycle, cells, correct, total: cells.length };
}

function cellLabel(cell) {
  const { struct: s, slot, field: f } = cell;
  if (s === 'rob') return `ROB slot ${slot} ${f}`;
  if (s === 'rs') return `RS ${slot} ${f}`;
  if (s === 'map') return `map ${slot}`;
  if (s === 'free') return 'free list';
  if (s === 'cdb') return 'CDB';
  return `${s} ${slot} ${f}`;
}

const QuizKey = { DASH, ROB_FIELDS, RS_FIELDS, FORMAT,
                  norm, normInsn, normHT, normBusy, normList,
                  operandText, mapText, htText,
                  expectedCycle, blankCycle, isBlankCycle, compareCycle, cellLabel };
root.QuizKey = QuizKey;
if (typeof module !== 'undefined' && module.exports) module.exports = QuizKey;
})(typeof window !== 'undefined' ? window : globalThis);
