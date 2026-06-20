/* ===================================================================
 * demo.js
 * Machine Studio [MS] — Reference machine.
 *
 * ONE call builds a machine whose BOTH sub-models are populated:
 *   · PETRI — a small concurrent assembly line that exercises a SPLIT
 *             fork, an AND join, buffer capacities, a group and both
 *             manual + timer triggers. Classic Petri-net territory.
 *   · FSM   — a traffic-light controller: a single active state cycled
 *             by a timer, a manual jump to a maintenance end state, and
 *             a group. Classic finite-state-machine territory.
 *
 * The demo never asks which formalism — it fills both so the user can
 * flip the header toggle and compare them. It opens in PETRI (the
 * primary formalism). Built entirely through the public Machine API so
 * ids and auto-layout behave exactly as for a hand-built machine.
 *
 *   demo.build()   -> Machine   (mode left on PETRI)
 *
 * Depends on: machine.js, config.js, fmt.js
 * =================================================================== */
const demo = (function () {
    'use strict';

    function build() {
        const m = new Machine('Demo — assembly line & traffic light', 'PETRI');

        _buildPetri(m);
        _buildFSM(m);

        // Leave the machine on PETRI — the primary formalism the user
        // sees first; the FSM is one toggle away.
        m.setMode('PETRI');
        return m;
    }

    /* ═══════════════════════════════════════════════════════════════
       PETRI — a concurrent assembly line.

         Raw ──Load──▶ Queue ──[SPLIT: Dispatch]──▶ Station A
                                                 └─▶ Station B
         Station A ┐
                   ├─[AND: Assemble]──▶ Assembled ──Ship(timer)──▶ Shipped(end)
         Station B ┘

       Exercises: a SPLIT gate (1→2 atomic fork), an AND gate (2→1
       join requiring both inputs), buffer capacities (Queue fills to
       red), a group over the two stations, a manual trigger chain and
       a repeating timer that finishes the run.
       ═══════════════════════════════════════════════════════════════ */
    function _buildPetri(m) {
        m.setMode('PETRI');

        // Triggers
        const tLoad     = m.addTrigger({ name: 'Load',     kind: 'manual' });
        const tDispatch = m.addTrigger({ name: 'Dispatch', kind: 'manual' });
        const tAssemble = m.addTrigger({ name: 'Assemble', kind: 'manual' });
        const tShip     = m.addTrigger({ name: 'Ship', kind: 'timer',
                                         period: 4, oneShot: false, initialDelay: 0 });

        // States. Raw starts with a few parts so the line runs out of
        // the box; Queue is capped so it visibly fills (red) under load.
        const raw   = m.addState({ name: 'Raw stock', kind: 'start' });
        m.updateState(raw.id,  { bufferCap: 6, initialTokens: 4, inputCost: 1, outputYield: 1 });

        const queue = m.addState({ name: 'Queue', kind: 'normal' });
        m.updateState(queue.id, { bufferCap: 4, inputCost: 1, outputYield: 1 });

        const staA  = m.addState({ name: 'Station A', kind: 'normal' });
        const staB  = m.addState({ name: 'Station B', kind: 'normal' });
        m.updateState(staA.id, { bufferCap: 2, inputCost: 1, outputYield: 1 });
        m.updateState(staB.id, { bufferCap: 2, inputCost: 1, outputYield: 1 });

        const asm   = m.addState({ name: 'Assembled', kind: 'normal' });
        m.updateState(asm.id, { bufferCap: 3, inputCost: 1, outputYield: 1 });

        const ship  = m.addState({ name: 'Shipped', kind: 'end' });
        m.updateState(ship.id, { bufferCap: 3, inputCost: 1, outputYield: 1 });

        // Group the two parallel stations.
        const work = m.addGroup({ name: 'Workshop' });
        m.setGroupMembers(work.id, [staA.id, staB.id]);

        // Raw ──Load──▶ Queue
        m.addTransition({ from: raw.id, to: queue.id, triggerId: tLoad.id });

        // Queue ──[SPLIT: Dispatch]──▶ Station A & Station B (atomic fork).
        m.addGate({ type: 'SPLIT', inputs: [queue.id],
                    outputs: [staA.id, staB.id], triggerId: tDispatch.id });

        // Station A & Station B ──[AND: Assemble]──▶ Assembled (join).
        m.addGate({ type: 'AND', inputs: [staA.id, staB.id],
                    to: asm.id, triggerId: tAssemble.id });

        // Assembled ──Ship (timer)──▶ Shipped (end → auto-stop).
        m.addTransition({ from: asm.id, to: ship.id, triggerId: tShip.id });
    }

    /* ═══════════════════════════════════════════════════════════════
       FSM — a traffic-light controller.

         Red ─Tick▶ Red+Amber ─Tick▶ Green ─Tick▶ Amber ─Tick▶ Red …
         (Red | Green) ─Maintenance▶ Flashing (end)

       Exercises: single-active-state semantics, a repeating timer that
       cycles the light, a manual trigger that jumps to a maintenance
       END state (auto-stop), and a group over the two "stop" phases.
       ═══════════════════════════════════════════════════════════════ */
    function _buildFSM(m) {
        m.setMode('FSM');

        // Triggers
        const tick = m.addTrigger({ name: 'Tick', kind: 'timer',
                                    period: 2, oneShot: false, initialDelay: 0 });
        const maint = m.addTrigger({ name: 'Maintenance', kind: 'manual' });

        // States (FSM states need only a name + kind).
        const red    = m.addState({ name: 'Red',       kind: 'start' });
        const redAmb = m.addState({ name: 'Red + Amber', kind: 'normal' });
        const green  = m.addState({ name: 'Green',     kind: 'normal' });
        const amber  = m.addState({ name: 'Amber',     kind: 'normal' });
        const flash  = m.addState({ name: 'Flashing (service)', kind: 'end' });

        // Group the two "stop" phases.
        const stop = m.addGroup({ name: 'Stop phases' });
        m.setGroupMembers(stop.id, [red.id, redAmb.id]);

        // The cycle, driven by the timer tick.
        m.addTransition({ from: red.id,    to: redAmb.id, triggerId: tick.id });
        m.addTransition({ from: redAmb.id, to: green.id,  triggerId: tick.id });
        m.addTransition({ from: green.id,  to: amber.id,  triggerId: tick.id });
        m.addTransition({ from: amber.id,  to: red.id,    triggerId: tick.id });

        // Manual jump to maintenance from the two safest phases.
        m.addTransition({ from: red.id,   to: flash.id, triggerId: maint.id });
        m.addTransition({ from: green.id, to: flash.id, triggerId: maint.id });
    }

    return { build };
})();

/* Node/headless export so the test harness can require this module. The
   browser ignores `module`. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { demo };
}
