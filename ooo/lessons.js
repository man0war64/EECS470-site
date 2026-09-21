/* The lessons behind the viewer's "Programs" mode.
 *
 * For now the list is the five stages, register renaming, and superscalar —
 * one program on two machines, 1-wide and 2-way, side by side.  The lesson
 * text never says where an example came from: no course material is named.  The other
 * feature lessons (true dependences, out-of-order issue, widths, the CDB)
 * are parked, commented out, at the end of this file.
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

window.LESSONS = [
  {
    id: 'pipeline',
    title: 'The five stages',
    point: 'Independent instructions: one enters and one leaves every cycle, each taking D, S, X, C, R in turn.',
    program: 'independent',
    params: {},
    knobs: ['dispatch_width', 'issue_width', 'cdb_width', 'retire_width'],
    showDeps: true,
    explain: {
      feature: [
        'An instruction is Dispatched into the ROB and a reservation station, Issues when its operands are ready, eXecutes, Completes by broadcasting its tag on the CDB, and Retires from the head of the ROB.',
        'Nothing here waits for an operand, and every width is one, so the program runs like a classic pipeline: a diagonal in the pipeline diagram.',
      ],
      watch: [
        'The ROB fills one slot per cycle from the tail; the head advances one per cycle from cycle 5.',
        'The map table: each destination points at a new tag without a +, which gains its + the cycle the result broadcasts.',
        'The free list shrinks by one per dispatch and grows by one per retire (the retired instruction’s Told).',
      ],
    },
    callouts: {
      1: 'I0 dispatches: ROB slot 1, RS 1, R1 renamed to p5 (Told = p1). Its operands p2+ and p3+ are already ready.',
      2: 'I0 issues at once. I1 enters behind it: dispatch width 1, so one instruction per cycle.',
      4: 'I0 completes: p5 goes out on the CDB and the map table’s r1 gets its +.',
      5: 'I0 retires from the head of the ROB; p1, its Told, returns to the free list.',
      8: 'Four instructions, eight cycles: 4 to fill the pipeline plus 4 to drain it. One stage per cycle, one new instruction per cycle.',
    },
  },
  {
    id: 'renaming',
    title: 'Register renaming',
    point: 'One program, two machines: four instructions that reuse two register names, first on a reference machine that does not rename, then on one that does. Sixteen cycles without renaming, ten with.',
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
    was: ['problem1', 'problem2', 'r10k_by_hand'],
    title: 'Superscalar',
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
      5: 'I0 retires and frees p3. I2 issues. I4 dispatches: R2 is renamed again, so I3’s p8 becomes I4’s Told, and the free list is empty.',
      6: 'I4 issues past I3 (out of order). I5 dispatches into slot 1, taking p3, the register I0 freed last cycle.',
      7: 'I1 retires, I2 completes and I3 issues at last. I6 cannot dispatch: the ROB is full, and the slot I1 frees this cycle can be taken next cycle.',
      8: 'I6 dispatches into ROB slot 2 with p4, the register I1’s retirement freed.',
      13: 'Thirteen cycles — and twelve on the 2-way machine.',
    },
  },
];

/* ------------------------------------------------------------------------
 * PARKED: the feature lessons.  Commented out for now; to bring one back,
 * uncomment WIDE2 and the lesson, move it into window.LESSONS above, and add
 * its cycle counts to LESSON_CYCLES in tests/viewer.test.mjs.
 * ------------------------------------------------------------------------ */

// /** A 2-wide front and back end with room to breathe: the base for the
//  *  lessons that need two instructions to be ready in the same cycle. */
// const WIDE2 = { dispatch_width: 2, issue_width: 2, cdb_width: 2, retire_width: 2,
//                 rob_size: 8, n_rs: 8, n_phys_regs: 12 };
//
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
//   {
//     id: 'ooo_issue',
//     title: 'Out-of-order issue',
//     point: 'Younger instructions whose operands are ready issue past an older one that is waiting.',
//     program: 'raw_slack',
//     params: { mul_latency: 4, mul_pipelined: false },
//     knobs: ['mul_latency', 'mul_pipelined', 'issue_width', 'n_rs'],
//     showDeps: true,
//     explain: {
//       program: [
//         'I0 is a multiply that takes four cycles. I1 needs its result. I2 and I3 need nothing that is in flight, and I4 joins the two strands at the end.',
//       ],
//       feature: [
//         'Issue picks the oldest ready instructions, not the oldest instructions. I1 sits in its reservation station waiting for p5 while I2 and I3, dispatched after it, find their operands ready and go: they issue, execute and complete while I1 is still waiting.',
//         'An in-order machine would stop at I1: I2 and I3 would wait behind it until cycle 7, then follow it out one per cycle. The reservation stations are what make the reordering possible: they hold every dispatched instruction, and any of them can leave when its operands arrive.',
//         'What stays in order is retirement: I2 and I3 finish long before I1, but they leave the ROB after it.',
//       ],
//       watch: [
//         'Cycle 4: I2 issues while I1, above it in the ROB, still shows no S.',
//         'The ROB’s S, X and C columns are not monotone down the buffer: that is out-of-order execution in one glance.',
//         'Cycles 8–13: the head retires one per cycle in program order, however long ago each instruction completed.',
//       ],
//     },
//     callouts: {
//       3: 'I0 begins a four-cycle multiply. I1 waits on p5. I2 dispatches.',
//       4: 'I2 is younger than I1 but its operands are ready: it issues past I1. This is out-of-order issue.',
//       5: 'I3 issues too. I1 is still waiting on p5; the multiplier is busy until cycle 6.',
//       7: 'I0 completes at last: p5 on the CDB, I1 wakes and issues. I3 finished this cycle but the CDB (width 1) was taken, so p8 waits a cycle.',
//       8: 'I0 retires. I2 and I3 completed cycles ago but wait behind I1 in the ROB: retirement is in program order.',
//       13: 'Thirteen cycles. In-order issue would have held I2 and I3 until I1 issued at cycle 7, then let them out one per cycle behind it.',
//     },
//   },
//   {
//     id: 'widths',
//     title: 'Superscalar widths',
//     point: 'Dispatch, issue, CDB and retire widths admit and drain several instructions per cycle; dependences still set the floor.',
//     program: 'wide',
//     params: {},
//     contrast: { label: 'the 2-wide machine', params: { ...WIDE2, n_alu: 2 } },
//     knobs: ['dispatch_width', 'issue_width', 'cdb_width', 'retire_width', 'n_alu', 'rob_size', 'n_rs', 'n_phys_regs'],
//     showDeps: true,
//     explain: {
//       program: [
//         'Four independent instructions, a reduction tree that merges them (I4, I5, I7, I8), and a multiply in the middle. The first four could all go at once; the tree is a chain of dependences.',
//       ],
//       feature: [
//         'Each width is a separate knob: how many instructions dispatch per cycle into the ROB and reservation stations, how many issue, how many results the CDB carries, how many retire from the head. On the 1-wide lesson machine every stage takes one per cycle, so the four independent instructions need four cycles just to get in.',
//         'The contrast machine is 2-wide everywhere, with a second ALU and a bigger ROB, reservation stations and free list so the extra instructions have somewhere to go. It gets the independent work in twice as fast, but only shaves two cycles off the total: the reduction tree is a dependence chain, and width does nothing for a chain.',
//       ],
//       watch: [
//         'The pipeline diagram on the 1-wide machine: a straight diagonal, one D per cycle.',
//         'On the contrast machine: two D’s per cycle, two S’s, two tags on the CDB — until the tree, where it goes back to one at a time.',
//         'The ROB on the contrast machine: the tail advances two slots per cycle.',
//       ],
//     },
//     callouts: {
//       4: 'Four independent instructions, four cycles just to dispatch them: the front end admits one per cycle.',
//       9: 'I8 dispatches: nine cycles to get nine instructions in. Every stage has been doing one per cycle.',
//       11: 'I8 issues at 11: it needed I6 (the multiply) and I7, the last of the reduction tree.',
//       14: 'Fourteen cycles. The 2-wide machine takes twelve: it gets the independent work in twice as fast, but the reduction tree (I4 → I7 → I8) is a chain that no width shortens.',
//     },
//   },
//   {
//     id: 'cdb',
//     title: 'CDB width',
//     point: 'Two ALUs finish together, but one bus carries one result per cycle: the second result waits.',
//     program: 'independent',
//     params: { ...WIDE2, n_alu: 2, cdb_width: 1 },
//     contrast: { label: 'the two-CDB machine', params: { ...WIDE2, n_alu: 2, cdb_width: 2 } },
//     knobs: ['cdb_width', 'n_alu', 'issue_width'],
//     showDeps: false,
//     explain: {
//       program: [
//         'The four independent adds again, now with two ALUs so that two of them really do execute in the same cycle. The only thing narrowed is the CDB.',
//       ],
//       feature: [
//         'Every result leaves the machine through the CDB: the broadcast is what sets ready bits in the reservation stations and the map table, and an instruction is not Complete until its tag has been on the bus. A 1-wide CDB carries one tag per cycle, so when two ALUs finish in the same cycle, one result waits, and it keeps waiting as long as older results keep arriving.',
//         'The result: two ALUs feeding one bus complete one instruction per cycle, exactly as one ALU would. The contrast machine widens the CDB to two and the second ALU finally pays for itself.',
//       ],
//       watch: [
//         'Cycle 4: I0 and I1 both finish executing; the CDB shows one tag; I1’s stall event says its result is waiting for the bus.',
//         'The C column in the ROB: consecutive cycles, one per instruction, although X came in pairs.',
//         'On the contrast machine the CDB row shows two tags in cycles 4 and 5.',
//       ],
//     },
//     callouts: {
//       2: 'I0 and I1 issue together: two ALUs, issue width 2.',
//       4: 'I0 and I1 both finish executing. The CDB carries one tag per cycle: p5 broadcasts, I1’s p6 waits.',
//       5: 'p6 finally broadcasts. I2 finished executing last cycle and is queued behind it. The bus is the bottleneck.',
//       8: 'Eight cycles: two ALUs feeding one bus complete one result per cycle, as one ALU would. Two CDBs: six cycles.',
//     },
//   },
// ];
