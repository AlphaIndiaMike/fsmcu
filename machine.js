/**
 * machine.js
 * Machine Studio [MS] — Machine model: two independent sub-models
 * (FSM + Petri net), each holding states, transitions, gates, triggers
 * and groups, plus JSON load/save.
 *
 * The Machine is pure structural state — it knows nothing about the
 * canvas (positions are stored, rendering is owned by canvas.js) and
 * nothing about the simulator (runtime tokens & status are owned by
 * simulator.js). This separation keeps each file focused and well
 * under the 1000-line ceiling.
 *
 * ── Two sub-models, one toggle ────────────────────────────────────
 * A Machine carries TWO fully independent sub-models and the header
 * toggle simply chooses which one is live:
 *
 *   FSM   — a finite-state machine over binary (active/inactive)
 *           states. A plain machine has one active state and firing a
 *           trigger moves it along a transition. Gates (AND/OR/XOR/
 *           SPLIT/NOT) add Petri-style guards: a SPLIT can expose
 *           several states at once and an AND join waits on all of its
 *           inputs, so more than one state can be active. States carry
 *           only a name + kind; the Petri token fields are present
 *           (defaulted to 1) but unused.
 *   PETRI — the full Petri-net token model (the original Machine
 *           Studio behaviour, untouched): places hold many tokens,
 *           transitions/gates fire on token availability, capacities
 *           and costs/yields all apply.
 *
 * Switching modes never migrates data — the two models are separate
 * diagrams. The live arrays (`states`, `transitions`, `gates`,
 * `triggers`, `groups`) mirror the active sub-model BY REFERENCE, so
 * every method below — and the entire rest of the app — operates on
 * them without ever needing to know which mode is active.
 *
 * JSON file format (v2):
 *   {
 *     name, version, mode,                 // mode = 'FSM' | 'PETRI'
 *     fsm:   { …sub-model… },
 *     petri: { …sub-model… }
 *   }
 *   Each sub-model:
 *   {
 *     states:      [{ id, name, kind, groupId, x, y,
 *                     inputCost, outputYield, bufferCap, initialTokens }],
 *     transitions: [{ id, from, to, triggerId }],
 *     gates:       [{ id, type, inputs:[stateId], outputs:[stateId], to,
 *                     triggerId, x, y }],
 *     triggers:    [{ id, name, kind, period?, oneShot?, initialDelay? }],
 *     groups:      [{ id, name, color, x, y }]
 *   }
 *   Legacy v1 files (flat top-level arrays) load as the PETRI sub-model;
 *   see fromJSON.
 *
 * kind  = 'start' | 'normal' | 'end'              (states)
 * type  = 'AND' | 'OR' | 'XOR' | 'SPLIT' | 'NOT' (gates)
 * kind  = 'manual' | 'timer'                      (triggers)
 *
 * Gates apply to BOTH formalisms. In Petri they gate token flow; in
 * FSM they gate the single/concurrent active markers (binary): a gate
 * blocks its target until its inputs satisfy the gate's logic. NOT is
 * an FSM-only inhibitor — its target is reachable only while its input
 * is inactive.
 *
 * Depends on: config.js, fmt.js
 */

class Machine {

    constructor(name = '', mode = 'PETRI') {
        this.name = name;
        /* Top-level mode. Machine Studio's established strength is the
           Petri-net token model, so a brand-new machine defaults to
           PETRI — the familiar tool. FSM is the alternative formalism,
           one toggle away (and the New dialog lets you start in either).
           Loaded legacy files always open as PETRI. */
        this.mode = Machine._normMode(mode);
        this._models = {
            FSM:   Machine._emptyModel(),
            PETRI: Machine._emptyModel()
        };
        // Point the live arrays at the active sub-model.
        this._loadActive();
    }

    static _normMode(m) {
        return m === 'FSM' ? 'FSM' : 'PETRI';
    }

    static _emptyModel() {
        return { states: [], transitions: [], gates: [], triggers: [], groups: [] };
    }

    /* Point the live arrays at the active sub-model (by reference). */
    _loadActive() {
        const m = this._models[this.mode];
        this.states      = m.states;
        this.transitions = m.transitions;
        this.gates       = m.gates;
        this.triggers    = m.triggers;
        this.groups      = m.groups || (m.groups = []);
    }

    /* Write the (possibly reassigned) live arrays back into the active
       sub-model. CRUD methods reassign arrays via .filter(), so the live
       reference can diverge from the slot — sync before switching/saving. */
    _syncActive() {
        const m = this._models[this.mode];
        m.states      = this.states;
        m.transitions = this.transitions;
        m.gates       = this.gates;
        m.triggers    = this.triggers;
        m.groups      = this.groups;
    }

    setMode(mode) {
        const m = Machine._normMode(mode);
        if (m === this.mode) return m;
        this._syncActive();     // stash current live arrays
        this.mode = m;
        this._loadActive();     // bring the target sub-model live
        return m;
    }

    /* ── Lookups ──────────────────────────────────────────────────── */

    stateById(id)      { return this.states.find(s => s.id === id) || null; }
    transitionById(id) { return this.transitions.find(t => t.id === id) || null; }
    gateById(id)       { return this.gates.find(g => g.id === id) || null; }
    triggerById(id)    { return this.triggers.find(t => t.id === id) || null; }
    groupById(id)      { return this.groups.find(gr => gr.id === id) || null; }

    startState() { return this.states.find(s => s.kind === 'start') || null; }
    endStates()  { return this.states.filter(s => s.kind === 'end'); }

    /* States currently assigned to a group (derived — membership lives
       on the state's groupId, never on the group). */
    statesInGroup(groupId) {
        return this.states.filter(s => s.groupId === groupId);
    }

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

    addState({ name, kind = 'normal', x = 200, y = 200, groupId = null }) {
        // Enforce single start state: if 'start' requested and one
        // already exists, demote the new one to 'normal'.
        if (kind === 'start' && this.startState()) kind = 'normal';

        const s = {
            id:          fmt.uid('s'),
            name:        name || this._uniqueStateName(),
            kind,
            groupId:     groupId || null,
            x, y,
            inputCost:     CONFIG.stateDefaults.inputCost,
            outputYield:   CONFIG.stateDefaults.outputYield,
            bufferCap:     CONFIG.stateDefaults.bufferCap,
            // initialTokens: how many tokens are placed on this state
            // when Sim Start (or Reset) is pressed. Start state defaults
            // to 1 token so a freshly created machine simulates out of
            // the box; other kinds default to 0. (Petri-only — the FSM
            // runtime always seeds the start state regardless.)
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
            g.to !== id &&
            !g.inputs.includes(id) &&
            !(Array.isArray(g.outputs) && g.outputs.includes(id))
        );
        // Trim the deleted state from any SPLIT gate's outputs list.
        this.gates.forEach(g => {
            if (Array.isArray(g.outputs)) g.outputs = g.outputs.filter(o => o !== id);
            if (Array.isArray(g.inputs))  g.inputs  = g.inputs.filter(i => i !== id);
        });
    }

    /* ── Group CRUD ───────────────────────────────────────────────── */

    addGroup({ name, color, x = 0, y = 0 } = {}) {
        const g = {
            id:    fmt.uid('grp'),
            name:  name || this._uniqueGroupName(),
            color: color || CONFIG.groupColors[this.groups.length % CONFIG.groupColors.length],
            x, y
        };
        this.groups.push(g);
        return g;
    }

    _uniqueGroupName() {
        let n = this.groups.length + 1;
        let nm;
        do { nm = 'Group ' + n; n++; }
        while (this.groups.some(g => g.name === nm));
        return nm;
    }

    updateGroup(id, patch) {
        const g = this.groupById(id);
        if (!g) return false;
        Object.assign(g, patch);
        return true;
    }

    deleteGroup(id) {
        this.groups = this.groups.filter(g => g.id !== id);
        // Members fall back to ungrouped — a deleted boundary never
        // deletes the states inside it.
        this.states.forEach(s => { if (s.groupId === id) s.groupId = null; });
    }

    /* Atomically set a group's membership: every listed state joins,
       every previously-listed state that is no longer listed leaves.
       Membership lives on the state, so this is just a groupId rewrite. */
    setGroupMembers(groupId, memberIds) {
        if (!this.groupById(groupId)) return;
        const sel = new Set(memberIds || []);
        this.states.forEach(s => {
            const wasIn = s.groupId === groupId;
            const nowIn = sel.has(s.id);
            if (wasIn && !nowIn)      s.groupId = null;
            else if (!wasIn && nowIn) s.groupId = groupId;
        });
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
        if (!['AND', 'OR', 'XOR', 'SPLIT', 'NOT'].includes(type)) return null;
        const g = {
            id: fmt.uid('g'),
            type,
            // Topology depends on type:
            //   AND/OR/XOR:  inputs = [N states],  outputs = [],         to = state
            //     N→1 — many sources gate one destination.
            //   SPLIT:       inputs = [1 state],   outputs = [N states], to = null
            //     1→N — one source fans out atomically into N destinations.
            //   NOT:         inputs = [1 state],   outputs = [],         to = state
            //     inhibitor — destination is reachable only while the input
            //     (the guard) is inactive. FSM-only.
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
        this._syncActive();   // make sure the live arrays are captured
        return {
            name:    this.name,
            version: CONFIG.fileVersion,
            mode:    this.mode,
            fsm:     Machine._dumpModel(this._models.FSM),
            petri:   Machine._dumpModel(this._models.PETRI)
        };
    }

    static _dumpModel(m) {
        return {
            states:      m.states.map(s => ({ ...s })),
            transitions: m.transitions.map(t => ({ ...t })),
            gates:       m.gates.map(g => ({
                ...g,
                inputs:  g.inputs.slice(),
                outputs: (g.outputs || []).slice()
            })),
            triggers:    m.triggers.map(t => ({ ...t })),
            groups:      (m.groups || []).map(g => ({ ...g }))
        };
    }

    /* Parse one sub-model's arrays from raw JSON. Tolerant of missing
       keys so legacy files (flat top-level arrays) parse the same way. */
    static _parseModel(src) {
        src = src || {};
        const states = (Array.isArray(src.states) ? src.states : []).map(s => {
            const kind = s.kind || 'normal';
            const cap  = Math.max(1, fmt.posInt(s.bufferCap, CONFIG.stateDefaults.bufferCap));
            // Back-compat: legacy files don't have initialTokens. The
            // old simulator hardcoded "1 token on the start state",
            // so we default kind=start → 1, others → 0. Clamp to cap.
            const initDefault = kind === 'start' ? CONFIG.startMarking : 0;
            const init        = fmt.posInt(s.initialTokens, initDefault);
            return {
                id: s.id, name: s.name || '', kind,
                groupId: s.groupId || null,
                x: +s.x || 0, y: +s.y || 0,
                inputCost:     fmt.posInt(s.inputCost,   CONFIG.stateDefaults.inputCost),
                outputYield:   fmt.posInt(s.outputYield, CONFIG.stateDefaults.outputYield),
                bufferCap:     cap,
                initialTokens: Math.min(init, cap)
            };
        });
        const transitions = (Array.isArray(src.transitions) ? src.transitions : []).map(t => ({
            id: t.id, from: t.from, to: t.to, triggerId: t.triggerId || null
        }));
        const gates = (Array.isArray(src.gates) ? src.gates : []).map(g => ({
            id: g.id, type: g.type,
            inputs:  Array.isArray(g.inputs)  ? g.inputs.slice()  : [],
            outputs: Array.isArray(g.outputs) ? g.outputs.slice() : [],
            to: g.to || null, triggerId: g.triggerId || null,
            x: +g.x || 0, y: +g.y || 0
        }));
        const triggers = (Array.isArray(src.triggers) ? src.triggers : []).map(t => {
            const base = { id: t.id, name: t.name || '', kind: t.kind || 'manual' };
            if (base.kind === 'timer') {
                base.period       = fmt.posInt(t.period,       CONFIG.timerDefaults.period) || 1;
                base.oneShot      = !!t.oneShot;
                base.initialDelay = fmt.posInt(t.initialDelay, CONFIG.timerDefaults.initialDelay);
            }
            return base;
        });
        const groups = (Array.isArray(src.groups) ? src.groups : [])
            .filter(g => g && g.id)
            .map((g, i) => ({
                id:    g.id,
                name:  g.name || ('Group ' + (i + 1)),
                color: g.color || CONFIG.groupColors[i % CONFIG.groupColors.length],
                x: +g.x || 0, y: +g.y || 0
            }));
        // Drop dangling groupIds (a state pointing at a group that
        // didn't survive parsing falls back to ungrouped).
        const groupIds = new Set(groups.map(g => g.id));
        states.forEach(s => { if (s.groupId && !groupIds.has(s.groupId)) s.groupId = null; });

        return { states, transitions, gates, triggers, groups };
    }

    static fromJSON(obj) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Invalid file: not an object.');
        }
        const v = +obj.version || 1;
        const m = new Machine(obj.name || '');

        if (v >= 2 && (obj.fsm || obj.petri)) {
            // Current format: two independent sub-models.
            m._models.FSM   = Machine._parseModel(obj.fsm);
            m._models.PETRI = Machine._parseModel(obj.petri);
            m.mode = Machine._normMode(obj.mode);
        } else {
            // Legacy (v1): flat top-level arrays ARE the Petri net.
            // Open as PETRI so every saved token property is preserved;
            // the FSM sub-model starts empty.
            if (!Array.isArray(obj.states) || !Array.isArray(obj.transitions) ||
                !Array.isArray(obj.gates)  || !Array.isArray(obj.triggers)) {
                throw new Error(
                    'Invalid file: expected { states, transitions, gates, triggers } ' +
                    'or { fsm, petri }.'
                );
            }
            m._models.PETRI = Machine._parseModel(obj);
            m._models.FSM   = Machine._emptyModel();
            m.mode = 'PETRI';
        }
        m._loadActive();

        // Rehydrate per-prefix uid counters past every loaded ID (both
        // sub-models) so subsequent uid() calls produce fresh,
        // non-colliding ids. IDs have the form "<prefix>_<digits>".
        fmt.resetUid();
        const all = []
            .concat(m._models.FSM.states, m._models.FSM.transitions,
                    m._models.FSM.gates, m._models.FSM.triggers, m._models.FSM.groups)
            .concat(m._models.PETRI.states, m._models.PETRI.transitions,
                    m._models.PETRI.gates, m._models.PETRI.triggers, m._models.PETRI.groups);
        all.forEach(item => {
            const match = String(item.id || '').match(/^([A-Za-z]+)_(\d+)$/);
            if (match) fmt.bumpUid(match[1], parseInt(match[2], 10));
        });

        return m;
    }
}
