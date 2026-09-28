/* The lessons behind the viewer's "Programs" mode.
 *
 * Eight lessons in two groups (LESSON_GROUPS), listed group by group.  Each
 * shows one thing, and wherever it can, on two machines that differ in that
 * one thing, side by side with their cycle counts:
 *
 *   How the R10K works
 *   Its titles add up: each lesson has what the one before it had, and
 *   one thing more.
 *   1  renaming                 what every instruction goes through, with
 *                               no RAW dependences: one program, without
 *                               renaming and with it
 *   2  renaming, OoO issue      the map table and the free list: one
 *                               program, without renaming and with it
 *   3  renaming, OoO issue,     a fuller program, 1-wide and 2-way, with
 *      dual-issue               no room to spare and dependences in the way
 *
 *   Sizing the R10K
 *   1  reorder buffer size      running out of room: ROB slots
 *   2  physical registers       running out of room: registers
 *   3  superscalar width        six instructions that wait for nothing,
 *                               1-wide and 3-wide
 *   4  ALU contention           the 3-wide machine with one ALU: adds that
 *                               queue, and a multiply that does not
 *   5  CDB contention           the 3-wide machine with one CDB: a result
 *                               that waits for the bus, and its readers
 *   Each of the three has a program of its own, of six instructions.
 *
 * No lesson's machine, its own or the one it is compared with, has a ROB or
 * reservation stations of more than five entries: more is too much to work
 * by hand and too tall for the page.  The three lessons on a 3-wide machine
 * are the exception, with six of each (ROOM_FOR_SIX): with five, a sixth
 * instruction waits for the ROB and width gains nothing.  A test holds the
 * lessons to both.
 * A lesson's notes for a cycle (callouts) are shown under the controls while
 * the program is stepped through.
 *
 * The lesson text never says where an example came from: no course
 * material is named.  Five more lessons are parked, commented out, at the
 * end of this file: true dependences and the CDB, the three that ran on
 * an 8-entry ROB (out-of-order issue, false dependences, superscalar
 * widths on a longer program), and in-order retirement.  A lesson on
 * execution latency is in the history (commit e67a92c^).
 *
 * Each lesson pairs a bundled program with the machine feature it exercises:
 * the program is chosen so that one knob — a width, the CDB, the number of
 * ALUs, the ROB, the physical registers, a latency — is what decides its
 * timing.  Where it helps, a *contrast* machine differs in just that knob, and
 * the viewer simulates the program on both and shows the two timing tables.
 *
 * This file is data: no semantics, no rendering.  Every program named here is
 * a file in programs/, every params key is a knob in ooo.config.PARAMS, and
 * every callout cycle exists in the lesson machine's trace — tests check all
 * three, so a model change cannot leave a stale note behind.
 *
 *   id        stable name (remembered across reloads)
 *   group     the id of its group (LESSON_GROUPS); a group's lessons are
 *             listed together, and numbered within the group
 *   title     the feature
 *   point     one line: what the program shows about it
 *   program   a bundled program name (programs/<name>.txt)
 *   was       ids this lesson used to go by (a remembered lesson still opens)
 *   params    the lesson machine, as a patch over the default R10K machine
 *   label     what to call the lesson machine, a noun phrase (optional:
 *             "the lesson machine")
 *   contrast  { label, params, watch?, callouts? }: the machine to compare
 *             against (optional); the label is a noun phrase, "the 2-wide
 *             machine"; watch and callouts are the contrast machine's own
 *   knobs     which parameters the "knobs in play" table lists
 *   showDeps  draw the dependence graph on the lesson page
 *   explain   { feature: [...], watch: [...] }: paragraphs (feature) and
 *             bullets (watch); an optional program: [...] adds paragraphs
 *             under the program table (these lessons have none)
 *   callouts  { cycle: text }: shown in the lesson strip at that cycle when
 *             the program runs on the lesson machine (contrast.callouts: on
 *             the contrast machine)
 */

'use strict';

/** A multiplier that takes four cycles and is held for all four: the slow
 *  instruction of the lessons that need one. */
const SLOW_MUL = { mul_latency: 4, mul_pipelined: false };

/** The groups of lessons, in the order the page lists them. */
/** Room for six instructions at once: two groups of three.  The three
 *  lessons on a 3-wide machine have it, and no other lesson: they are the
 *  one exception to the limit of five ROB entries and reservation stations. */
const ROOM_FOR_SIX = { rob_size: 6, n_rs: 6, n_phys_regs: 10 };

/** A 3-wide machine: three instructions a cycle dispatch, issue, complete
 *  and retire, and there are three ALUs. */
const THREE_WIDE = { dispatch_width: 3, issue_width: 3, cdb_width: 3, retire_width: 3, n_alu: 3, ...ROOM_FOR_SIX };

window.LESSON_GROUPS = [
  { id: 'works', title: 'How the R10K works' },
  { id: 'sizing', title: 'Sizing the R10K' },
];

window.LESSONS = [
  {
    id: 'pipeline',
    group: 'works',
    title: 'Renaming',
    point: 'One program, two machines: four instructions, none of which reads a result another one writes, first on a reference machine that does not rename, then on one that does. Twenty cycles without renaming, eight with.',
    program: 'independent',
    label: 'the machine without renaming',
    params: { renaming: false },
    contrast: {
      label: 'the renaming machine',
      params: {},
      watch: [
        'The ROB fills one slot per cycle from the tail; the head advances one per cycle from cycle 5.',
        'The map table: each destination points at a new tag without a +, which gains its + the cycle the result broadcasts.',
        'The free list shrinks by one per dispatch and grows by one per retire (the retired instruction’s Told).',
      ],
      callouts: {
        1: 'I0 dispatches: ROB slot 1, RS 1, R1 renamed to p5 (Told = p1). Its operands p2+ and p3+ are already ready.',
        2: 'I0 issues at once. I1 enters behind it: it writes R2, which I0 reads, but its R2 is p6, a register of its own. Dispatch width 1, so one instruction per cycle.',
        4: 'I0 completes: p5 goes out on the CDB and the map table’s r1 gets its +.',
        5: 'I0 retires from the head of the ROB; p1, its Told, returns to the free list.',
        8: 'Four instructions, eight cycles: 4 to fill the pipeline plus 4 to drain it. One stage per cycle, one new instruction per cycle. Twenty cycles without renaming.',
      },
    },
    knobs: ['renaming', 'dispatch_width', 'issue_width', 'cdb_width', 'retire_width'],
    showDeps: true,
    explain: {
      feature: [
        'An instruction is Dispatched into the ROB and a reservation station, Issues when its operands are ready, eXecutes, Completes by broadcasting its tag on the CDB, and Retires from the head of the ROB.',
        'There is no RAW (read after write) dependence: no instruction reads a register that an older one writes, so nothing here waits for a value. Registers are written after older instructions read them: I1 writes R2, which I0 reads; I2 writes R3, which I1 reads; I3 writes R4, which I2 reads.',
        'The reference machine does not rename: a register name is one storage location, so an instruction that writes a register waits at dispatch until every older instruction that reads or writes that register has retired. Each instruction waits for the one before it to retire, and one instruction is in flight at a time: twenty cycles.',
        'The other machine renames, and everything else about it is the same. Each write gets a register of its own from the free list, so nothing waits for a name either, and every width is one: the program runs like a classic pipeline, a diagonal in the pipeline diagram. Eight cycles.',
      ],
      watch: [
        'The map table never changes and the free list is never touched: r1 to r4 stay in p1 to p4.',
        'Cycles 2 to 5, 7 to 10 and 12 to 15: the next instruction waits at dispatch for a register name that the one in flight still uses.',
        'The ROB never holds more than one instruction.',
      ],
    },
    callouts: {
      1: 'I0 dispatches and nothing is renamed: R1 stays in p1, which loses its + until the add’s result is written. No register comes off the free list, and there is no Told.',
      2: 'I0 issues. I1, R2 = R3 + R4, cannot dispatch. It writes R2, and I0 reads R2: with one storage location for R2, the new value would replace the one I0 needs. The machine holds the name until I0 retires. With renaming I1 dispatches here, into p6.',
      5: 'I0 retires and lets go of R2; I1 can dispatch next cycle.',
      6: 'I1 dispatches, four cycles later than with renaming.',
      7: 'I2, R3 = R4 + 7, cannot dispatch: it writes R3, which I1 reads. It needs no value from I1, only the name.',
      11: 'I2 dispatches, eight cycles later than with renaming.',
      16: 'I3 dispatches, twelve cycles later than with renaming: it writes R4, which I2 read.',
      20: 'Twenty cycles, five for each instruction, one in flight at a time. No instruction waited for a value: every wait was for a register name. The renaming machine takes eight.',
    },
  },
  {
    id: 'renaming',
    group: 'works',
    title: 'Renaming, OoO issue',
    point: 'One program, two machines: four instructions that reuse two register names, first on a reference machine that does not rename, then on one that does, where the divide issues ahead of the older multiply. Sixteen cycles without renaming, ten with.',
    program: 'renaming',
    label: 'the machine without renaming',
    params: { n_arch_regs: 3, n_phys_regs: 7, renaming: false },
    contrast: {
      label: 'the renaming machine',
      params: { n_arch_regs: 3, n_phys_regs: 7 },
      watch: [
        'Cycles 1 to 4: the map table and free list after each dispatch. The free list is empty after cycle 4: every physical register is in use.',
        'Each ROB entry’s T and Told: Told is always the register the map table held for that destination one cycle earlier.',
        'Retirements at cycles 5, 7, 9 and 10 free p1, p3, p5 and p4: each instruction’s own Told.',
        'Cycles 6 and 7: I3, the divide, executes a cycle before I2, the multiply.',
      ],
      callouts: {
        1: 'add r2,r3,r1 dispatches as add p2,p3,p4: R1 takes p4 from the free list and the ROB keeps Told = p1. Now r1 → p4, and the free list is p5, p6, p7.',
        2: 'sub r2,r1,r3 becomes sub p2,p4,p5: its R1 is read through the map table as p4, not yet ready. R3 moves to p5 (Told = p3).',
        3: 'mul r2,r3,r3 becomes mul p2,p5,p6: it reads R3 as p5, the sub’s result, and then renames R3 again, to p6. Told = p5, a register whose value does not exist yet.',
        4: 'div r1,4,r1 becomes div p4,4,p7 (Told = p4). The free list is empty. The add completes: p4 on the CDB wakes the sub, and the divide finds p4 ready.',
        5: 'The add retires and frees p1, its Told: r1 has been p4 since cycle 1, so nothing can name p1 again. The divide issues; the multiply still waits for p5.',
        7: 'The sub retires and frees p3. The divide completes while the multiply, ahead of it in the program, is only now executing.',
        9: 'The mul retires and frees p5: the sub’s register, dead because R3 was renamed again and its only reader was this mul.',
        10: 'The div retires and frees p4. Every retirement returned its own Told. The architectural state is now r1 → p7, r2 → p2, r3 → p6. Ten cycles, against sixteen without renaming.',
      },
    },
    knobs: ['renaming', 'n_arch_regs', 'n_phys_regs'],
    showDeps: true,
    explain: {
      feature: [
        'The reference machine does not rename: a register name is one storage location, so an instruction that writes a register waits at dispatch until every older instruction that reads or writes that register has retired.',
        'The other machine renames, and everything else about it is the same. Dispatch reads each source through the map table and gives the destination the next register from the free list.',
        'The ROB keeps the register each destination replaced as Told, and retirement returns it to the free list.',
        'The divide needs only the add’s p4, so it executes before the multiply.',
        'The only waits this program needs are for values: the sub needs the add’s R1, the mul the sub’s R3, the div the add’s R1. Every other wait is for a name, and renaming removes those: ten cycles instead of sixteen.',
      ],
      watch: [
        'The map table never changes and the free list is never touched: r1, r2 and r3 stay in p1, p2 and p3.',
        'Cycles 2 to 5 and 7 to 10: an instruction that writes R3 waits at dispatch while an older instruction that names R3 is in flight.',
        'Cycle 12: the divide dispatches last and finishes last. It cannot pass the multiply, as it does with renaming.',
      ],
    },
    callouts: {
      1: 'I0 dispatches and nothing is renamed: R1 stays in p1, which loses its + until the add’s result is written. No register comes off the free list, and there is no Told.',
      2: 'I1, R3 = R2 − R1, cannot dispatch. It writes R3, and I0 reads R3: with one storage location for R3, the new value would replace the one I0 needs. The machine holds the name until I0 retires. With renaming I1 dispatches here, into p5.',
      5: 'I0 retires and lets go of R3; I1 can dispatch next cycle.',
      6: 'I1 dispatches, four cycles later than with renaming. It reads R1 as p1, ready since cycle 4.',
      7: 'I2, R3 = R2 × R3, writes R3 again before I1 has written it: two values, one location. It waits for I1 to retire.',
      11: 'I2 dispatches, eight cycles later than with renaming.',
      12: 'I3, R1 = R1 / 4, dispatches: nothing in flight names R1 any more. It reads p1 and writes p1; the old value is read before the new one replaces it. With renaming it executes at cycle 6, ahead of the multiply.',
      16: 'Sixteen cycles. Every cycle lost was a wait for a register name, not for a value: the renaming machine takes ten.',
    },
  },
  {
    id: 'superscalar',
    group: 'works',
    was: ['problem1', 'problem2', 'r10k_by_hand'],
    title: 'Renaming, OoO issue, dual-issue',
    point: 'One program, two machines: the same seven instructions on a 1-wide machine and on a 2-way superscalar machine with two ALUs, side by side.',
    program: 'lecture_example',
    label: 'the 1-wide machine',
    params: {},
    contrast: {
      label: 'the 2-way superscalar machine',
      params: { dispatch_width: 2, issue_width: 2, cdb_width: 2, retire_width: 2, n_alu: 2 },
      watch: [
        'Cycle 3: I2 issues past the older I1, which waits for p5. I4 cannot dispatch: all four reservation stations are held.',
        'Cycle 4: I4 takes p9, the last free register, and the last ROB slot.',
        'Cycle 6: I5 wraps around into ROB slot 1 and is given p3, the register I0’s retirement freed at cycle 5.',
        'Cycle 7: two retirements in one cycle, I1 and I2.',
      ],
      callouts: {
        1: 'I0 and I1 dispatch together: R3 → p5 (Told = p3) and R4 → p6 (Told = p4). I1 reads R3 as p5, not ready.',
        2: 'I0 issues. I2 and I3 dispatch: R1 → p7, R2 → p8. All four reservation stations are in use.',
        3: 'I2 issues past I1, which waits for p5: out-of-order issue. I0’s reservation station is released as it executes, too late for I4 to take this cycle.',
        4: 'p5 on the CDB: I1 wakes and issues (C → S bypass). I4 dispatches into the last ROB slot with p9, the last free register; I5 has nowhere to go.',
        5: 'I0 retires and frees p3. I2 completes (p7) and I3 issues. The ROB slot freed this cycle can be taken next cycle.',
        6: 'I1 completes (p6), I4 issues, and I5 dispatches into ROB slot 1 with T = p3 and Told = p6; the free list is empty again. Head: slot 2 (I1). Tail: slot 1 (I5).',
        7: 'I1 and I2 retire together (retire width 2), freeing p4 and p1. I5 waits for p9.',
        8: 'I3 retires; p9 broadcasts and I5 issues. I6 dispatches at last: on the 1-wide machine it also dispatched at cycle 8. The ROB, not the front end, was the limit.',
        12: 'Twelve cycles against thirteen on the 1-wide machine. The second ALU never ran: the dependences, the ROB and the reservation stations set the pace, not the widths.',
      },
    },
    knobs: ['dispatch_width', 'issue_width', 'cdb_width', 'retire_width', 'n_alu', 'rob_size', 'n_rs', 'n_phys_regs', 'n_arch_regs'],
    showDeps: true,
    explain: {
      feature: [
        'The same seven instructions run on two machines. Only the machine changes: one is 1-wide; the other dispatches, issues, completes and retires two instructions a cycle and has a second ALU. The ROB, the reservation stations and the registers are the same on both.',
        'Work a cycle by hand, then step the simulator to check it: run the program on either machine, with the buttons at the bottom of this page.',
        'Doubling every width saves one cycle, thirteen to twelve: the second ALU is never used, and the ROB, the reservation stations and the chain I0 → I1 → I4 → I5 set the pace.',
        'A reservation station, ROB entry or register freed in one cycle can be taken by dispatch from the next.',
      ],
      watch: [
        'Cycle 4: I0’s p5 broadcasts and I1 wakes; I2 is ready too, but the issue logic prefers the older I1. I3 dispatches with T1 = p7, I2’s not-yet-ready R1.',
        'Cycle 6: I4 issues before I3; I5 wraps around into ROB slot 1 and takes p3, the register I0 freed at cycle 5.',
        'The map table: r2 is renamed twice (p8, then p9) before either result exists.',
        'Cycle 7: I6 cannot dispatch, the ROB is full; it gets in at cycle 8.',
      ],
    },
    callouts: {
      1: 'I0 dispatches: ROB slot 1, R3 renamed to p5 (Told = p3). Its operands p1+ and p2+ are ready.',
      2: 'I0 issues. I1 dispatches: R4 → p6 (Told = p4); it reads R3 as p5, not ready.',
      4: 'I0 completes: p5 on the CDB, I1 wakes and issues. I2 is ready too, but the older I1 takes the one issue slot. I3 dispatches with T1 = p7, waiting for I2.',
      5: 'I0 retires and frees p3. I2 issues. I4 dispatches with p9, the last register that was free: R2 is renamed again, so I3’s p8 becomes I4’s Told.',
      6: 'I4 issues past I3 (out of order). I5 dispatches into slot 1, taking p3, the register I0 freed last cycle.',
      7: 'I1 retires, I2 completes and I3 issues at last. I6 cannot dispatch: the ROB is full, and the slot I1 frees this cycle can be taken next cycle.',
      8: 'I6 dispatches into ROB slot 2 with p4, the register I1’s retirement freed.',
      13: 'Thirteen cycles — and twelve on the 2-way machine.',
    },
  },
  {
    id: 'rob',
    group: 'sizing',
    title: 'Reorder buffer size',
    point: 'A full ROB stops dispatch: the ROB is how far ahead in the program the machine can look.',
    program: 'wide',
    label: 'the 2-entry-ROB machine',
    params: { rob_size: 2, n_rs: 2 },
    contrast: {
      label: 'the 5-entry-ROB machine',
      params: {},
      callouts: {
        3: 'I2 dispatches behind I0 and I1: with five slots there is room for it.',
        5: 'I0 retires as I4 dispatches. From here one instruction leaves and one enters every cycle, and four are in flight at a time.',
        6: 'I5 dispatches into slot 1, which I0 left last cycle: the buffer wraps around.',
        14: 'Fourteen cycles against twenty-five. The ROB was never full.',
      },
    },
    knobs: ['rob_size', 'n_rs', 'dispatch_width', 'retire_width'],
    showDeps: false,
    explain: {
      program: [
        'Nine instructions, the first four independent of each other. There is plenty of work that could overlap; the question is how much of it the machine can see at once.',
      ],
      feature: [
        'Every dispatched instruction holds a ROB slot from dispatch to retirement. With two slots, two instructions are in flight at a time: the third cannot dispatch until the head retires, and a slot freed in one cycle can be taken from the next. So the machine takes in two instructions, drains them, and takes in two more: two instructions every five cycles.',
        'The ROB is the machine’s window on the program. Out-of-order execution can only reorder what is inside the window, and a window of two has nothing in it to reorder.',
        'Twenty-five cycles against fourteen with five entries.',
      ],
      watch: [
        'Cycle 3: I2’s stall, “cannot dispatch: ROB full”. It repeats until cycle 5.',
        'The ROB head and tail: with two slots, they alternate.',
        'The pipeline diagram: bursts of two with gaps between them.',
      ],
    },
    callouts: {
      2: 'I1 dispatches: both ROB slots are taken.',
      3: 'I2 cannot dispatch: the ROB is full. It is independent of I0 and I1, and the machine cannot see it.',
      5: 'I0 retires and leaves slot 1. The slot can be taken next cycle.',
      6: 'I1 retires and I2 dispatches into the slot I0 left. Two instructions in flight at a time.',
      25: 'Twenty-five cycles, against fourteen with the five-entry ROB. The window was too small to overlap anything.',
    },
  },
  {
    id: 'pregs',
    group: 'sizing',
    title: 'Physical registers',
    point: 'Renaming needs a register to rename into: with one to spare, one instruction is in flight at a time.',
    program: 'hazards',
    label: 'the five-register machine',
    params: { n_phys_regs: 5 },
    contrast: {
      label: 'the nine-register machine',
      params: {},
      callouts: {
        1: 'I0 takes p5 for its R1, and four registers are left on the free list.',
        3: 'I2 writes R1 again and gets p7. Its Told is p5, I0’s register. Three instructions are in flight, each with a register of its own.',
        5: 'I0 retires and frees p1. I4 takes p9, the last register that was free.',
        6: 'I5 dispatches with p1, the register I0 freed last cycle. The free list is empty, and nothing has had to wait for it.',
        15: 'Fifteen cycles against thirty. Every wait here was for a value: the program is one chain.',
      },
    },
    knobs: ['n_phys_regs', 'n_arch_regs', 'rob_size'],
    showDeps: true,
    explain: {
      program: [
        'R1 is written three times and read in between. Renaming makes that harmless by giving each write a physical register of its own, but every rename takes a register from the free list, and it comes back only when the instruction that replaced it retires.',
      ],
      feature: [
        'Four architectural registers need four physical registers just to hold the machine’s state. The five-register machine has one more, so the free list starts with a single entry. I0 takes it; I1 needs one and finds the free list empty, so dispatch stalls until I0 retires and returns its Told. Every instruction waits for the one before it to retire: thirty cycles.',
        'The nine-register machine has five to spare, enough for everything that is in flight at once. The same program takes fifteen cycles.',
        'The free list is a resource like the ROB: when it runs out, dispatch stops, whatever the dependences say.',
      ],
      watch: [
        'Cycle 1: the free list is empty as soon as I0 has dispatched; cycle 2: I1’s stall says so.',
        'Cycles 5 and 6: I0 retires, its Told (p1) appears on the free list, and I1 takes it the next cycle.',
        'On the nine-register machine no instruction ever waits to dispatch.',
      ],
    },
    callouts: {
      1: 'I0 takes the only free physical register, p5, for its R1. The free list is empty.',
      2: 'I1 needs a register for R4 and there is none: dispatch stalls on an empty free list.',
      5: 'I0 retires and frees p1, the register its R1 replaced. It can be taken next cycle.',
      6: 'I1 dispatches with T = p1. One instruction in flight at a time.',
      30: 'Thirty cycles, against fifteen with nine physical registers. Renaming removes the waits for names, but it needs registers to rename into.',
    },
  },
  {
    id: 'widths',
    group: 'sizing',
    title: 'Superscalar width',
    point: 'One program, two machines: six instructions that wait for nothing, on a 1-wide machine and on a 3-wide one with three ALUs. Ten cycles against six.',
    program: 'no_waits',
    label: 'the 1-wide machine',
    params: { ...ROOM_FOR_SIX },
    contrast: {
      label: 'the 3-wide machine',
      params: { ...THREE_WIDE },
      watch: [
        'The pipeline diagram: two groups of three, a cycle apart. Every stage holds three instructions at a time.',
        'Cycle 2: all six instructions are in the ROB, all six reservation stations are in use and the free list is empty. A wider machine needs the room.',
        'The CDB carries three tags in cycle 4 and three in cycle 5, and all three ALUs are busy in cycles 3 and 4.',
        'Cycle 5: I0, I1 and I2 retire together while I3, I4 and I5 complete.',
      ],
      callouts: {
        1: 'I0, I1 and I2 dispatch together: R1 → p5, R2 → p6, and R1 again → p7 (Told = p5). Dispatch width 3.',
        2: 'I0, I1 and I2 issue together, one to each ALU. I3, I4 and I5 dispatch behind them: all six instructions are in, after two cycles.',
        3: 'I0, I1 and I2 execute, one on each ALU, and I3, I4 and I5 issue.',
        4: 'p5, p6 and p7 broadcast together, one on each CDB. I3, I4 and I5 execute.',
        5: 'I0, I1 and I2 retire together, and I3, I4 and I5 complete.',
        6: 'I3, I4 and I5 retire. Six cycles against ten: two to get the instructions in, three a cycle, and four more for the last three to reach retirement.',
      },
    },
    knobs: ['dispatch_width', 'issue_width', 'cdb_width', 'retire_width', 'n_alu', 'rob_size', 'n_rs', 'n_phys_regs'],
    showDeps: true,
    explain: {
      program: [
        'Six instructions that read R3 and R4, which none of them writes, and write R1 or R2. Nothing in this program ever waits for an operand, so how fast it runs is up to the machine.',
      ],
      feature: [
        'A superscalar machine does each step for more than one instruction a cycle. Every width is a knob of its own: how many instructions dispatch into the ROB and the reservation stations, how many issue, how many results the CDB carries, how many retire from the head. Three instructions issued together need three ALUs, so the 3-wide machine has three.',
        'The two machines differ in nothing else: both have six ROB entries, six reservation stations and ten physical registers, room for the whole program at once.',
        'The 1-wide machine takes six cycles to get six instructions in, and ten to finish. The 3-wide machine gets them in in two and finishes in six: four cycles sooner, the four it saved at dispatch.',
        'This is the most that width can do, on a program that waits for nothing and a machine with room for it. With five ROB entries the sixth instruction waits for the first three to retire, and the 3-wide machine takes ten cycles, as the 1-wide one does. The next two lessons take something away from the 3-wide machine, two of its ALUs and then two of its CDBs.',
      ],
      watch: [
        'The pipeline diagram: one straight diagonal, a D in every cycle from 1 to 6.',
        'The ROB never holds more than four instructions, and no instruction stalls: this machine has room to spare and no use for it.',
        'The CDB: one tag a cycle, from cycle 4 to cycle 9.',
      ],
    },
    callouts: {
      1: 'I0 dispatches alone: the front end takes one instruction a cycle.',
      4: 'I0 completes: p5 on the CDB. Four instructions are in, four cycles gone.',
      5: 'I0 retires and I4 dispatches. From here one instruction retires every cycle.',
      6: 'I5, the last instruction, dispatches: six cycles to get six instructions in.',
      10: 'Ten cycles: six to get the instructions in and four more for the last one to reach retirement. Nothing waited for an operand or for room. The 3-wide machine takes six.',
    },
  },
  {
    id: 'alus',
    group: 'sizing',
    title: 'ALU contention',
    point: 'Three adds are ready at once and there is one ALU: the adds go one a cycle, while the multiply, with a unit to itself, goes at once. Nine cycles against six.',
    program: 'adds_mul',
    label: 'the one-ALU machine',
    params: { ...THREE_WIDE, n_alu: 1 },
    contrast: {
      label: 'the three-ALU machine',
      params: { ...THREE_WIDE },
      watch: [
        'The S column in the ROB: 2, 2 and 2, then 3, 3 and 3.',
        'No instruction stalls: whatever is ready issues.',
      ],
      callouts: {
        2: 'I0, I1 and I2 issue together, one to each ALU.',
        3: 'I3 issues to the multiplier, and I4 and I5 to two of the ALUs. No ready instruction has waited.',
        6: 'Six cycles against nine. No add ever waited for an ALU.',
      },
    },
    knobs: ['n_alu', 'n_mul', 'issue_width', 'dispatch_width', 'cdb_width'],
    showDeps: false,
    explain: {
      program: [
        'Five adds and subtracts and one multiply. None reads a result another one writes, so every one is ready as soon as it is dispatched. + and − run on the integer ALU; × runs on the multiplier.',
      ],
      feature: [
        'Issue selects up to the issue width in ready instructions, oldest first, but each one also needs a free functional unit of its kind. This machine issues three a cycle and has one integer ALU, so of the adds that are ready one goes and the others wait in their reservation stations.',
        'The multiply does not wait. The multiplier is free, so I3 issues at cycle 3, past I2, which is older and still waiting for the ALU. The contention is for one kind of unit, not for the issue width.',
        'The adds issue at cycles 2, 3, 4, 5 and 6, one a cycle, as they would on a 1-wide machine: nine cycles. The other machine has three ALUs and nothing else is different. Whatever is ready issues: six cycles.',
      ],
      watch: [
        'Cycle 2: three adds are ready; I0 issues. The stalls of I1 and I2: “ready but the integer ALU already took I0 this cycle”.',
        'Cycle 3: I1 takes the ALU and I3 the multiplier; I2, I4 and I5 wait. Four reservation stations hold instructions that are ready.',
        'The S column in the ROB: 2, 3, 4, 3, 5, 6. The adds are in consecutive cycles; the multiply is not in their queue.',
        'Cycle 5: the multiply completes a cycle before I2, and waits in the ROB to retire with it at cycle 7.',
      ],
    },
    callouts: {
      1: 'I0, I1 and I2 dispatch together. All three are ready: they read R3 and R4, which nothing writes.',
      2: 'Three ready adds, issue width 3, one integer ALU: I0 takes it, and I1 and I2 wait. I3, I4 and I5 dispatch.',
      3: 'I1 takes the ALU. I3 is a multiply and the multiplier is free, so it issues past I2, which is older. I2, I4 and I5 wait for the ALU.',
      4: 'I2 issues, two cycles after it was ready. I4 and I5 wait again.',
      5: 'I4 issues. I1 and the multiply complete together, on two of the three CDBs.',
      6: 'I5 issues last, four cycles after it was dispatched.',
      7: 'I2 and I3 retire together. The multiply completed at cycle 5 and waited for I2, which is older.',
      9: 'Nine cycles. The front end delivered three a cycle; the one ALU let one add through a cycle. With three ALUs: six.',
    },
  },
  {
    id: 'cdb',
    group: 'sizing',
    title: 'CDB contention',
    point: 'Three ALUs finish together, but one bus carries one result a cycle: the third result waits two cycles, and so do the three instructions that need it. Eleven cycles against seven.',
    program: 'fan_out',
    label: 'the one-CDB machine',
    params: { ...THREE_WIDE, cdb_width: 1 },
    contrast: {
      label: 'the three-CDB machine',
      params: { ...THREE_WIDE },
      watch: [
        'The CDB shows three tags in cycle 4 and three in cycle 6.',
        'The C column in the ROB: C comes three at a time, as X did.',
      ],
      callouts: {
        4: 'p5, p6 and p7 broadcast together, one on each CDB. I3, I4 and I5 wake and issue in the same cycle.',
        6: 'I3, I4 and I5 complete together.',
        7: 'Seven cycles against eleven. No result waited for the bus.',
      },
    },
    knobs: ['cdb_width', 'n_alu', 'issue_width'],
    showDeps: true,
    explain: {
      program: [
        'Three updates that wait for nothing, then three instructions, I3, I4 and I5, that all read the new R3: the third update’s result.',
      ],
      feature: [
        'Every result leaves the machine through the CDB: the broadcast is what sets ready bits in the reservation stations and the map table, and an instruction is not Complete until its tag has been on the bus. A 1-wide CDB carries one tag per cycle, so when three ALUs finish in the same cycle, one result goes, the oldest first, and two wait.',
        'A result that waits for the bus holds up whatever reads it. I2 has finished executing by cycle 4, but its tag, p7, gets the bus at cycle 6, behind p5 and p6. Until then I3, I4 and I5 sit in their reservation stations with p7 not ready, although the value exists.',
        'Then it happens again: the three readers execute together at cycle 7 and their results leave one a cycle, at 8, 9 and 10.',
        'The other machine has three CDBs and nothing else is different. The three results broadcast together at cycle 4, and the three readers issue in that cycle: seven cycles instead of eleven.',
      ],
      watch: [
        'Cycle 4: three instructions have finished executing and the CDB shows one tag, p5. The stalls of I1 and I2 say their results are waiting for the bus.',
        'Cycles 2 to 5: I3, I4 and I5 in their reservation stations, T1 = p7 with no +.',
        'The C column in the ROB: 4, 5, 6, then 8, 9 and 10. One a cycle, although X came three at a time.',
      ],
    },
    callouts: {
      2: 'I0, I1 and I2 issue together, one to each ALU. I3, I4 and I5 dispatch; all three read R3 as p7, I2’s result, not ready.',
      4: 'All three have finished executing. The CDB carries one tag a cycle: p5 broadcasts; p6 and p7 wait.',
      5: 'p6 broadcasts. p7 waits a second cycle, and I3, I4 and I5 wait with it.',
      6: 'p7 broadcasts at last. I3, I4 and I5 wake and issue in the same cycle, two cycles later than with three CDBs.',
      8: 'I3, I4 and I5 finished executing together, and again the bus takes one: p8 broadcasts; p9 and p10 wait.',
      10: 'p10 broadcasts, two cycles after p8.',
      11: 'Eleven cycles. Three ALUs feeding one bus complete one result a cycle, and whatever reads a result waits for the bus too. Three CDBs: seven cycles.',
    },
  },
];

/* ------------------------------------------------------------------------
 * PARKED: one more feature lesson.  Commented out for now; to bring it
 * back, uncomment it, move it into window.LESSONS above, add its cycle
 * counts to LESSON_CYCLES in tests/viewer.test.mjs, and `make traces`.
 * ------------------------------------------------------------------------ */

// window.LESSONS = [
//   {
//     id: 'raw',
//     title: 'True dependences and the CDB',
//     point: 'A RAW chain: each instruction waits for the tag its producer broadcasts, and the chain is the critical path.',
//     program: 'raw_chain',
//     params: {},
//     contrast: { label: 'the X-bypass machine', params: { x_bypass: true } },
//     knobs: ['x_bypass', 'c_bypass_to_s', 'alu_latency'],
//     showDeps: true,
//     explain: {
//       program: [
//         'Every instruction reads the register the previous one writes. Renaming turns each of those registers into a tag; the consumer sits in its reservation station with that tag and no + until the producer completes.',
//       ],
//       feature: [
//         'The CDB (common data bus) is how a result announces itself: when an instruction completes, its tag is broadcast, every reservation station holding that tag sets the ready bit, and the map table does too. A consumer can issue in the cycle it hears the broadcast (the C → S bypass), execute the next, and complete the one after: two cycles per link of the chain.',
//         'Out-of-order execution cannot shorten a true dependence; it can only find other work to do meanwhile, and this program has none. The contrast machine forwards results from the execute stage (the X bypass), which saves one cycle per link: the consumer issues while the producer is still in X.',
//       ],
//       watch: [
//         'The reservation station of the waiting instruction: its T1 shows the producer’s tag with no +; hover it to see who it waits for.',
//         'The CDB row: exactly one tag per cycle from cycle 4, every other cycle.',
//         'The pipeline diagram: a staircase, two cycles per step.',
//       ],
//     },
//     callouts: {
//       2: 'I0 issues. I1 dispatches with T1 = p5 and no +: it needs I0’s result.',
//       3: 'I0 executes; I1 stalls, waiting on p5. Nothing else is ready.',
//       4: 'I0 completes and p5 goes out on the CDB. I1 hears it and issues in the same cycle (C → S bypass).',
//       6: 'I1 completes and I2 issues: every link of the chain costs two cycles, complete-to-issue.',
//       13: 'Five instructions, thirteen cycles. The chain is the critical path; no width or structure size can help. The X bypass would: 9 cycles.',
//     },
//   },
// ];

/* ------------------------------------------------------------------------
 * PARKED 2026-09-27: the three lessons that ran on a machine with room to
 * spare, an 8-entry ROB and 8 reservation stations (ROOM, WIDE2).  No lesson
 * that is shown has a ROB or reservation stations of more than five entries:
 * more is too much to work by hand and too tall for the page (a test holds
 * the lessons to it).  To bring one back, fit it to a machine of that size,
 * then as above.  Their runs were ooo_issue: [19, 15], false_deps: [27, 15],
 * widths: [12, 8], on programs/strands.txt and programs/pairs.txt.  The
 * superscalar width lesson that is shown is on programs/no_waits.txt, six
 * instructions on a 6-entry ROB.
 * ------------------------------------------------------------------------ */

// /** Room to breathe: a ROB, reservation stations and a free list that hold
//  *  eight instructions at once, so that nothing stalls for want of a slot. */
// const ROOM = { rob_size: 8, n_rs: 8, n_phys_regs: 12 };
//
// /** A 2-wide front and back end with that room: the base for the lessons
//  *  that need two instructions to be ready in the same cycle. */
// const WIDE2 = { dispatch_width: 2, issue_width: 2, cdb_width: 2, retire_width: 2, ...ROOM };
//
// window.LESSONS = [
//   {
//     id: 'ooo_issue',
//     title: 'Out-of-order issue',
//     point: 'One program, two machines: a slow multiply, and a chain of adds that does not need it. One machine issues in program order; the other lets a ready instruction go ahead. Nineteen cycles against fifteen.',
//     program: 'strands',
//     label: 'the in-order machine',
//     params: { ...ROOM, ...SLOW_MUL, in_order_issue: true },
//     contrast: {
//       label: 'the out-of-order machine',
//       params: { ...ROOM, ...SLOW_MUL },
//       watch: [
//         'Cycle 4: I2 issues while I1, above it in the ROB, has no S yet.',
//         'The ROB’s S, X and C columns are not in order down the buffer: that is out-of-order execution at a glance.',
//         'Cycles 8 to 15: one retirement a cycle, in program order, however long ago each instruction completed.',
//       ],
//       callouts: {
//         3: 'The multiply starts: four cycles. I1 waits for its result, p5. I2 dispatches with its operands ready.',
//         4: 'I2 issues past I1. It is younger, but its operands are ready and I1’s are not: out-of-order issue.',
//         6: 'I2 completes: p7 on the CDB wakes I3, which issues. The quick strand is two instructions along and the multiply is still running.',
//         7: 'The multiply completes and I1 issues, the same cycle as on the in-order machine. Nothing could make I1 earlier: it waits for a value.',
//         8: 'I0 retires. I3 completes and I4 issues.',
//         11: 'I2 retires. It completed at cycle 6 and waited in the ROB behind I0 and I1: retirement is in program order.',
//         12: 'I5 completes and I6 issues. The quick strand is done, four cycles sooner than in order.',
//         15: 'Fifteen cycles against nineteen.',
//       },
//     },
//     knobs: ['in_order_issue', 'mul_latency', 'mul_pipelined', 'issue_width'],
//     showDeps: true,
//     explain: {
//       program: [
//         'Two strands. The slow one is I0, a multiply that takes four cycles, and I1, which needs its result. The quick one is a chain of four adds, I2 to I5, that needs nothing from the multiply. I6 joins the two at the end.',
//       ],
//       feature: [
//         'Both machines dispatch every instruction into the ROB and a reservation station, one a cycle, and both have room for all seven. They differ in one rule: which instruction may issue.',
//         'The in-order machine issues in program order. I1 waits for the multiply until cycle 7, and everything behind I1 waits for I1, ready or not. I2 could have issued at cycle 4; it issues at cycle 8.',
//         'The out-of-order machine issues the oldest instruction that is ready. I2 issues at cycle 4, past I1, and the quick strand runs while the multiply does: its four adds have completed by cycle 12 instead of cycle 16.',
//         'Retirement is in program order on both machines. The quick strand finishes early on the out-of-order machine and still leaves the ROB behind I1.',
//         'Nineteen cycles against fifteen. The four cycles are the ones the quick strand spent behind an instruction it did not depend on.',
//       ],
//       watch: [
//         'Cycles 4 to 6: I2 has both operands and no S. Its stall says why: an older instruction has not issued.',
//         'The ROB’s S column: strictly in order down the buffer.',
//         'Cycle 7: I1 issues, and I2, next in line, waits one more cycle for the issue slot.',
//       ],
//     },
//     callouts: {
//       2: 'I0, the multiply, issues. I1 dispatches behind it and needs its result, p5.',
//       3: 'The multiply starts: four cycles. I1 waits for p5. I2 dispatches with its operands ready.',
//       4: 'I2 is ready and does not issue: I1, which is older, has not issued. This machine issues in program order.',
//       6: 'Four instructions are waiting. Only I1 waits for a value that is being computed. I2 waits for I1, and I3 and I4 for a chain that has not started.',
//       7: 'The multiply completes: p5 on the CDB, and I1 issues at last. I2 is next in line, but one instruction issues a cycle.',
//       8: 'I2 issues, four cycles after it could have. I0 retires.',
//       10: 'I2 completes and I3 issues. From here the chain runs at its own pace, two cycles a link.',
//       19: 'Nineteen cycles. The out-of-order machine takes fifteen: its chain started at cycle 4.',
//     },
//   },
//   {
//     id: 'false_deps',
//     title: 'False dependences',
//     point: 'The same program on the out-of-order machine, with and without register renaming. Without it the quick strand cannot start: it writes registers the slow strand still names. Twenty-seven cycles against fifteen.',
//     program: 'strands',
//     label: 'the machine without renaming',
//     params: { ...ROOM, ...SLOW_MUL, renaming: false },
//     contrast: {
//       label: 'the out-of-order machine',
//       params: { ...ROOM, ...SLOW_MUL },
//       watch: [
//         'The map table changes at every dispatch, and each ROB entry’s Told is the register its destination had one cycle earlier.',
//         'Cycle 5: r2 has been p2, p7 and p9, and all three are in use at once.',
//         'Every instruction dispatches in the cycle it arrives: D runs from 1 to 7.',
//       ],
//       callouts: {
//         1: 'I0 dispatches: R1 is renamed to p5, and the ROB keeps the register it replaced, p1, as Told.',
//         3: 'I2 dispatches: its R2 is p7, a register of its own. I0 goes on reading the old R2 in p2.',
//         4: 'I3 dispatches and R3 becomes p8. I2 issues: nothing it needs is in flight.',
//         5: 'I4 writes R2 again and gets p9. Its Told is p7, I2’s register, whose value does not exist yet.',
//         8: 'I0 retires and frees p1, the register R1 had before the multiply. Nothing can name it any more.',
//         15: 'Fifteen cycles. Every instruction dispatched in the cycle it arrived.',
//       },
//     },
//     knobs: ['renaming', 'in_order_issue', 'mul_latency', 'n_phys_regs'],
//     showDeps: true,
//     explain: {
//       program: [
//         'The same seven instructions. Look at the register names this time: I2 writes R2 and I3 writes R3, and the multiply, I0, reads both. The quick strand does not need the multiply’s result, but it reuses the names of its operands.',
//       ],
//       feature: [
//         'A true dependence is a wait for a value: I1 needs what I0 computes. A false dependence is a wait for a name. I2 computes a new R2 that I0 has no use for, but if R2 is one storage location, the new value must not replace the old one while an older instruction can still read it.',
//         'The machine without renaming keeps one location for each register, so an instruction that writes a register waits at dispatch until every older instruction that reads or writes that register has retired. It issues out of order, as in the last lesson, and that does not help: I2 cannot dispatch until cycle 9, and an instruction that is not in a reservation station cannot issue early.',
//         'With renaming, I2’s R2 is a register of its own, p7. I0 goes on reading the old R2 in p2. I2 dispatches at cycle 3 and issues at cycle 4.',
//         'Twenty-seven cycles against fifteen. Out-of-order issue needs renaming: most of what it could reorder is held back by names, not by values. The next lesson follows the map table and the free list through a shorter program.',
//       ],
//       watch: [
//         'The map table never changes and the free list is never touched.',
//         'Cycles 3 to 8: I2’s stall, “its destination register is still in use by an older instruction”.',
//         'The quick strand’s D column: 9, 10, 16, 21. Each instruction waits for the one before it to retire.',
//       ],
//     },
//     callouts: {
//       1: 'I0 dispatches and nothing is renamed: R1 stays in p1, which is not ready again until the multiply completes.',
//       3: 'I2 cannot dispatch. It writes R2, and I0, which reads R2, has not retired: the name is taken.',
//       7: 'The multiply completes and I1 issues. I2 is still outside the machine.',
//       9: 'I2 dispatches, six cycles later than with renaming.',
//       11: 'I4 cannot dispatch: it writes R2 again, and I2 and I3 name R2.',
//       16: 'I4 dispatches, after I3 has retired.',
//       21: 'I5 dispatches, after I4 has retired. The chain runs one instruction at a time.',
//       27: 'Twenty-seven cycles against fifteen. The twelve cycles were waits for a register name, not for a value.',
//     },
//   },
//   {
//     id: 'widths_pairs',   // 'widths' is the lesson on no_waits, above
//     title: 'Superscalar widths',
//     point: 'One program, two machines: eight instructions in independent pairs, on a 1-wide machine and on a 2-wide one with a second ALU. Twelve cycles against eight.',
//     program: 'pairs',
//     label: 'the 1-wide machine',
//     params: { ...ROOM },
//     contrast: {
//       label: 'the 2-wide machine',
//       params: { ...WIDE2, n_alu: 2 },
//       watch: [
//         'The pipeline diagram: the same diagonal, two instructions to a step.',
//         'Cycle 4: the ROB holds all eight instructions and the free list is empty. That is the room a wider machine needs.',
//         'The CDB carries two tags in every cycle from 4 to 7, and both ALUs are busy from 3 to 6.',
//         'Cycle 5: two instructions in every stage at once. I0 and I1 retire, I2 and I3 complete, I4 and I5 execute, I6 and I7 issue.',
//       ],
//       callouts: {
//         1: 'I0 and I1 dispatch together: R1 → p5 and R2 → p6. Dispatch width 2.',
//         2: 'I0 and I1 issue together, one to each ALU. I2 and I3 dispatch behind them.',
//         3: 'I4 and I5 dispatch. Both read p5, and I4 reads p6 too: I0’s and I1’s results, which are still in the ALUs.',
//         4: 'p5 and p6 broadcast together, one on each CDB, and I4 and I5 issue in the same cycle. I6 and I7 dispatch: all eight instructions are in, after four cycles.',
//         5: 'I0 and I1 retire together. Every stage is working on two instructions.',
//         8: 'I6 and I7 retire. Eight cycles against twelve: four to get the instructions in, two a cycle, and four more for the last pair to reach retirement.',
//       },
//     },
//     knobs: ['dispatch_width', 'issue_width', 'cdb_width', 'retire_width', 'n_alu', 'rob_size', 'n_rs', 'n_phys_regs'],
//     showDeps: true,
//     explain: {
//       program: [
//         'Four updates, one to each register, and then four more that use their results: I4 adds the new R1 and R2, I6 the new R3 and R4. The instructions come in pairs that do not depend on each other.',
//         'Whatever an instruction reads was written at least four instructions earlier, so on either machine it is ready by the time the instruction could issue. Nothing in this program ever waits for an operand.',
//       ],
//       feature: [
//         'A superscalar machine does each step for more than one instruction a cycle. Every width is a knob of its own: how many instructions dispatch into the ROB and the reservation stations, how many issue, how many results the CDB carries, how many retire from the head. Two instructions issued together need two ALUs, so the 2-wide machine has a second one.',
//         'The two machines differ in nothing else. Both have eight ROB entries, eight reservation stations and twelve physical registers: room for the whole program at once.',
//         'The 1-wide machine takes eight cycles to get eight instructions in, and twelve to finish. The 2-wide machine gets them in in four and finishes in eight: four cycles sooner, the four it saved at dispatch.',
//         'This is the most that width can do, on a program made of independent pairs and a machine with room. With one ALU the 2-wide machine takes twelve cycles again. With the five ROB entries, four reservation stations and nine registers of the next lesson it takes eleven. And a chain of dependences is not shortened by any width, as the next lesson’s program shows.',
//       ],
//       watch: [
//         'The pipeline diagram: one straight diagonal, a D in every cycle from 1 to 8.',
//         'The ROB never holds more than four instructions, and no instruction stalls: the machine has room to spare and no use for it.',
//         'The CDB: one tag a cycle, from cycle 4 to cycle 11.',
//       ],
//     },
//     callouts: {
//       1: 'I0 dispatches alone: the front end takes one instruction a cycle.',
//       4: 'Four instructions in, four cycles gone. I0 completes: p5 on the CDB.',
//       5: 'I0 retires and I4 dispatches. I4 reads R1 and R2 as p5 and p6: p5 has been ready since cycle 4 and p6 broadcasts now, so I4 issues next cycle without waiting.',
//       8: 'I7, the last instruction, dispatches: eight cycles to get eight instructions in.',
//       12: 'Twelve cycles: eight to get the instructions in and four more for the last one to reach retirement. Nothing waited for an operand or for room. The 2-wide machine takes eight.',
//     },
//   },
// ];

/* ------------------------------------------------------------------------
 * PARKED 2026-09-28: in-order retirement, taken out of the sizing group.
 * Its run was retire: [13], on programs/slow_head.txt.  To bring it back: as
 * above.
 * ------------------------------------------------------------------------ */

// window.LESSONS = [
//   {
//     id: 'retire',
//     group: 'sizing',
//     title: 'In-order retirement',
//     point: 'A slow instruction at the head of the ROB holds every finished younger instruction there until it retires, and the ROB fills up behind it.',
//     program: 'slow_head',
//     params: { ...SLOW_MUL },
//     knobs: ['retire_width', 'rob_size', 'mul_latency', 'mul_pipelined'],
//     showDeps: false,
//     explain: {
//       program: [
//         'A four-cycle multiply first, then four quick adds that need nothing from it, then one more instruction, I5, that needs a ROB slot.',
//       ],
//       feature: [
//         'Instructions execute and complete out of order, but they retire strictly in program order, from the head of the ROB. Retirement is when an instruction’s result becomes the machine’s state, so the state only ever moves forward through the program, one instruction at a time.',
//         'The adds complete at cycles 5 to 9. I0 completes at 7 and retires at 8; only then can I1 retire, then I2, one a cycle.',
//         'Meanwhile the adds hold their ROB slots, finished or not, and the ROB fills up: I5 cannot dispatch at cycles 6, 7 and 8. A ROB has to be big enough to cover the slowest instruction, or the machine stops taking work in while it waits.',
//       ],
//       watch: [
//         'Cycles 5 to 7: ROB entries with S, X and C filled in, sitting behind a head with no C.',
//         'Cycle 6: I5’s stall, “cannot dispatch: ROB full”.',
//         'Cycles 8 to 13: the head moves one slot a cycle and the free list grows by one a cycle.',
//       ],
//     },
//     callouts: {
//       3: 'The multiply starts: four cycles. I1 issues; it needs nothing from the multiply.',
//       5: 'I1 completes while I0, at the head of the ROB, is still multiplying. I1 cannot retire: retirement is in program order.',
//       6: 'I5 cannot dispatch: the ROB is full. I1 and I2 have completed and hold their slots behind the slow head.',
//       7: 'I0 completes. Three instructions have completed and none has retired. I3 has finished executing too, but the CDB carries one tag a cycle, so its result waits.',
//       8: 'I0 retires. From here the head advances one a cycle: I1 at 9, I2 at 10, and so on.',
//       9: 'I1 retires and I5 dispatches into slot 1, which I0 left a cycle ago.',
//       13: 'Thirteen cycles. The adds had all completed by cycle 9 and the last of them retired at cycle 12: the ROB held them so that the machine’s state changes in program order.',
//     },
//   },
// ];
