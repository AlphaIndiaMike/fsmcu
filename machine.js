/**
 * machine.js
 * Machine Studio [MS] — Machine model: states, transitions, gates,
 * triggers, and JSON load/save.
 *
 * The Machine is pure structural state — it doesn't know anything
 * about the canvas (positions are stored, but rendering is owned by
 * canvas.js) and nothing about the simulator (runtime tokens & status
 * are owned by simulator.js). This separation keeps each file focused
 * and well under the 1000-line ceiling.
 *
 * JSON file format:
 *   {
 *     name, version,
 *     states:      [{ id, name, kind, x, y, inputCost, outputYield, bufferCap }],
 *     transitions: [{ id, from, to, triggerId }],
 *     gates:       [{ id, type, inputs:[stateId], to, triggerId, x, y }],
 *     triggers:    [{ id, name, kind, period?, oneShot?, initialDelay? }]
 *   }
 *
 * kind  = 'start' | 'normal' | 'end'   (states)
 * type  = 'AND' | 'OR' | 'XOR'         (gates)
 * kind  = 'manual' | 'timer'           (triggers)
 *
 * Depends on: config.js, fmt.js
 */

class Machine {

    constructor(name = '') {
        this.name        = name;
        this.states      = [];
        this.transitions = [];
        this.gates       = [];
        this.triggers    = [];
    }

    /* ── Lookups ──────────────────────────────────────────────────── */

    stateById(id)      { return this.states.find(s => s.id === id) || null; }
    transitionById(id) { return this.transitions.find(t => t.id === id) || null; }
    gateById(id)       { return this.gates.find(g => g.id === id) || null; }
    triggerById(id)    { return this.triggers.find(t => t.id === id) || null; }

    startState() { return this.states.find(s => s.kind === 'start') || null; }
    endStates()  { return this.states.filter(s => s.kind === 'end'); }

    /* All graph edges pointing INTO a state (from transitions, from
       AND/OR/XOR gates' `to`, or from being one of a SPLIT gate's
       `outputs`). Used by the simulator's reverse analysis. */
    incomingOf(stateId) {
        const ts = this.transitions.filter(t => t.to === stateId);
        const gs = this.gates.filter(g =>
            g.to === stateId ||
            (Array.isArray(g.outputs) && g.outputs.includes(stateId))
        );
        return { transitions: ts, gates: gs };
    }

    /* All graph edges leaving a state (transitions where it is the
       source, AND/OR/XOR gates that list it as an input, or SPLIT
       gates whose single source is this state). */
    outgoingOf(stateId) {
        const ts = this.transitions.filter(t => t.from === stateId);
        const gs = this.gates.filter(g => g.inputs.includes(stateId));
        return { transitions: ts, gates: gs };
    }

    /* ── State CRUD ───────────────────────────────────────────────── */

    addState({ name, kind = 'normal', x = 200, y = 200 }) {
        // Enforce single start state: if 'start' requested and one
        // already exists, demote the new one to 'normal'.
        if (kind === 'start' && this.startState()) kind = 'normal';

        const s = {
            id:          fmt.uid('s'),
            name:        name || this._uniqueStateName(),
            kind,
            x, y,
            inputCost:     CONFIG.stateDefaults.inputCost,
            outputYield:   CONFIG.stateDefaults.outputYield,
            bufferCap:     CONFIG.stateDefaults.bufferCap,
            // initialTokens: how many tokens are placed on this state
            // when Sim Start (or Reset) is pressed. Start state defaults
            // to 1 token so a freshly created machine simulates out of
            // the box; other kinds default to 0.
            initialTokens: kind === 'start' ? CONFIG.startMarking : 0
        };
        this.states.push(s);
        return s;
    }

    _uniqueStateName() {
        let n = this.states.length + 1;
        let nm;
        do { nm = 'State ' + n; n++; }
        while (this.states.some(s => s.name === nm));
        return nm;
    }

    updateState(id, patch) {
        const s = this.stateById(id);
        if (!s) return false;

        // Kind change to 'start' must vacate any other start.
        if (patch.kind === 'start') {
            this.states.forEach(o => {
                if (o.id !== id && o.kind === 'start') o.kind = 'normal';
            });
        }
        Object.assign(s, patch);
        return true;
    }

    deleteState(id) {
        this.states = this.states.filter(s => s.id !== id);
        // Cascading delete: any edge/gate referencing this state.
        this.transitions = this.transitions.filter(
            t => t.from !== id && t.to !== id
        );
        this.gates = this.gates.filter(g =>
            g.to !== id && !g.inputs.includes(id)
        );
    }

    /* ── Transition CRUD ──────────────────────────────────────────── */

    addTransition({ from, to, triggerId = null }) {
        if (!this.stateById(from) || !this.stateById(to)) return null;
        const t = { id: fmt.uid('t'), from, to, triggerId };
        this.transitions.push(t);
        return t;
    }

    updateTransition(id, patch) {
        const t = this.transitionById(id);
        if (!t) return false;
        Object.assign(t, patch);
        return true;
    }

    deleteTransition(id) {
        this.transitions = this.transitions.filter(t => t.id !== id);
    }

    /* ── Gate CRUD ────────────────────────────────────────────────── */

    addGate({ type, inputs = [], outputs = [], to = null, triggerId = null, x = 300, y = 300 }) {
        if (!['AND', 'OR', 'XOR', 'SPLIT'].includes(type)) return null;
        const g = {
            id: fmt.uid('g'),
            type,
            // Topology depends on type:
            //   AND/OR/XOR:  inputs = [N states],  outputs = [],         to = state
            //     N→1 — many sources fire into one destination.
            //   SPLIT:       inputs = [1 state],   outputs = [N states], to = null
            //     1→N — one source fans out atomically into N destinations.
            inputs:  inputs.slice(),
            outputs: outputs.slice(),
            to,
            triggerId,
            x, y
        };
        this.gates.push(g);
        return g;
    }

    updateGate(id, patch) {
        const g = this.gateById(id);
        if (!g) return false;
        if (patch.inputs)  patch.inputs  = patch.inputs.slice();
        if (patch.outputs) patch.outputs = patch.outputs.slice();
        Object.assign(g, patch);
        return true;
    }

    deleteGate(id) {
        this.gates = this.gates.filter(g => g.id !== id);
    }

    /* ── Trigger CRUD ─────────────────────────────────────────────── */

    addTrigger({ name, kind, period, oneShot, initialDelay }) {
        const trg = {
            id:   fmt.uid('trg'),
            name: name || this._uniqueTriggerName(kind),
            kind
        };
        if (kind === 'timer') {
            trg.period       = period       != null ? period       : CONFIG.timerDefaults.period;
            trg.oneShot      = oneShot      != null ? oneShot      : CONFIG.timerDefaults.oneShot;
            trg.initialDelay = initialDelay != null ? initialDelay : CONFIG.timerDefaults.initialDelay;
        }
        this.triggers.push(trg);
        return trg;
    }

    _uniqueTriggerName(kind) {
        const prefix = kind === 'timer' ? 'Timer' : 'Trigger';
        let n = 1;
        let nm;
        do { nm = prefix + ' ' + n; n++; }
        while (this.triggers.some(t => t.name === nm));
        return nm;
    }

    updateTrigger(id, patch) {
        const t = this.triggerById(id);
        if (!t) return false;
        Object.assign(t, patch);
        return true;
    }

    deleteTrigger(id) {
        this.triggers = this.triggers.filter(t => t.id !== id);
        // Anything that referenced this trigger drops back to "no
        // trigger attached" — simulator treats that as "press the
        // trigger" never fires this edge, which is the safe default.
        this.transitions.forEach(t => { if (t.triggerId === id) t.triggerId = null; });
        this.gates.forEach(g       => { if (g.triggerId === id) g.triggerId = null; });
    }

    /* ── Serialisation ────────────────────────────────────────────── */

    toJSON() {
        return {
            name:        this.name,
            version:     CONFIG.fileVersion,
            states:      this.states.map(s => ({ ...s })),
            transitions: this.transitions.map(t => ({ ...t })),
            gates:       this.gates.map(g => ({
                ...g,
                inputs:  g.inputs.slice(),
                outputs: (g.outputs || []).slice()
            })),
            triggers:    this.triggers.map(t => ({ ...t }))
        };
    }

    static fromJSON(obj) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Invalid file: not an object.');
        }
        if (!Array.isArray(obj.states) || !Array.isArray(obj.transitions) ||
            !Array.isArray(obj.gates)  || !Array.isArray(obj.triggers)) {
            throw new Error(
                'Invalid file: expected { states, transitions, gates, triggers }.'
            );
        }
        const m = new Machine(obj.name || '');
        m.states      = obj.states.map(s => {
            const kind = s.kind || 'normal';
            const cap  = Math.max(1, fmt.posInt(s.bufferCap, CONFIG.stateDefaults.bufferCap));
            // Back-compat: legacy files don't have initialTokens. The
            // old simulator hardcoded "1 token on the start state",
            // so we default kind=start → 1, others → 0. Clamp to cap.
            const initDefault = kind === 'start' ? CONFIG.startMarking : 0;
            const init        = fmt.posInt(s.initialTokens, initDefault);
            return {
                id: s.id, name: s.name || '', kind,
                x: +s.x || 0, y: +s.y || 0,
                inputCost:     fmt.posInt(s.inputCost,   CONFIG.stateDefaults.inputCost),
                outputYield:   fmt.posInt(s.outputYield, CONFIG.stateDefaults.outputYield),
                bufferCap:     cap,
                initialTokens: Math.min(init, cap)
            };
        });
        m.transitions = obj.transitions.map(t => ({
            id: t.id, from: t.from, to: t.to, triggerId: t.triggerId || null
        }));
        m.gates       = obj.gates.map(g => ({
            id: g.id, type: g.type,
            inputs:  Array.isArray(g.inputs)  ? g.inputs.slice()  : [],
            outputs: Array.isArray(g.outputs) ? g.outputs.slice() : [],
            to: g.to || null, triggerId: g.triggerId || null,
            x: +g.x || 0, y: +g.y || 0
        }));
        m.triggers    = obj.triggers.map(t => {
            const base = { id: t.id, name: t.name || '', kind: t.kind || 'manual' };
            if (base.kind === 'timer') {
                base.period       = fmt.posInt(t.period,       CONFIG.timerDefaults.period) || 1;
                base.oneShot      = !!t.oneShot;
                base.initialDelay = fmt.posInt(t.initialDelay, CONFIG.timerDefaults.initialDelay);
            }
            return base;
        });

        // Rehydrate per-prefix uid counters past every loaded ID so
        // subsequent uid() calls produce fresh, non-colliding ids.
        // IDs have the form "<prefix>_<digits>" (post-redesign); any
        // legacy random-tail ids are simply ignored — uid() will pick
        // values that can't collide with them anyway.
        fmt.resetUid();
        const all = m.states
            .concat(m.transitions)
            .concat(m.gates)
            .concat(m.triggers);
        all.forEach(item => {
            const match = String(item.id || '').match(/^([A-Za-z]+)_(\d+)$/);
            if (match) fmt.bumpUid(match[1], parseInt(match[2], 10));
        });

        return m;
    }
}
