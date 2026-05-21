/**
 * simulator.js
 * Machine Studio [MS] — Petri-net runtime.
 *
 * Owns the live simulation state for a Machine: token marking,
 * firing logic for transitions and gates, timer scheduling, status
 * colours and auto-stop detection. Nothing in here renders — it
 * notifies via callbacks supplied at init().
 *
 * Status of a state (drives canvas colours):
 *   'idle'   — 0 tokens                     (grey,   default)
 *   'active' — 0 < tokens < bufferCap       (green,  "system is here")
 *   'full'   — tokens == bufferCap          (red,    blocked-in)
 *   'fail'   — transient: a fire attempt failed because the source
 *              had fewer tokens than its inputCost                 (yellow flash)
 *
 * Gate firing:
 *   AND — fires when every input state has >= inputCost AND the
 *         target has room for the sum of their outputYields. All
 *         participating inputs pay; target gains the sum.
 *   OR  — fires once if any input is eligible. The first eligible
 *         input in the gate's input list is the one that pays.
 *   XOR — fires only if exactly one input is eligible.
 *
 * Auto-stop: as soon as any end state holds at least one token the
 * simulation halts (all timers stopped, manual triggers reject).
 *
 * Depends on: config.js, machine.js (Machine type)
 */

const simulator = (() => {

    let machine     = null;
    let api         = null;            // { onStatusChange, onSimMessage }
    let running     = false;           // true between startSim and stopSim
    let ended       = false;           // auto-stop reached

    /* Live runtime state */
    const marking      = new Map();    // stateId → number of tokens
    const flashTimers  = new Map();    // stateId → setTimeout handle (yellow flash)
    const flashSet     = new Set();    // stateId currently flashing 'fail'
    const timerHandles = new Map();    // triggerId → { intervalId, initialTo }

    /* ── init / lifecycle ─────────────────────────────────────────── */

    function init(opts) {
        api = opts || {};
    }

    function startSim(m) {
        machine = m;
        running = true;
        ended   = false;
        _clearAllFlash();
        _stopAllTimers();
        _seedMarking();
        _emitStatus();
        _emitMessage('Running — initial tokens placed. Fire a trigger to advance.');
    }

    function resetSim() {
        if (!running) return;
        _clearAllFlash();
        _stopAllTimers();
        ended = false;
        _seedMarking();
        _emitStatus();
        _emitMessage('Reset — initial tokens placed. Fire a trigger to advance.');
    }

    /* Place each state's configured initialTokens onto the marking.
       States with initialTokens=0 (the default for non-start kinds)
       still get an explicit 0 entry so statusOf() is well-defined. */
    function _seedMarking() {
        marking.clear();
        if (!machine) return;
        machine.states.forEach(s => {
            const n = Math.max(0, Math.min(s.initialTokens || 0, s.bufferCap));
            marking.set(s.id, n);
        });
    }

    function stopSim() {
        running = false;
        ended   = false;
        _clearAllFlash();
        _stopAllTimers();
        marking.clear();
        _emitStatus();
        _emitMessage('');
    }

    function isRunning() { return running; }
    function isEnded()   { return ended; }

    function tokensOf(stateId) {
        return marking.get(stateId) || 0;
    }

    function statusOf(stateId) {
        if (flashSet.has(stateId)) return 'fail';
        const s = machine && machine.stateById(stateId);
        if (!s) return 'idle';
        const n = marking.get(stateId) || 0;
        if (n === 0)            return 'idle';
        if (n >= s.bufferCap)   return 'full';
        return 'active';
    }

    /* ── Firing ───────────────────────────────────────────────────── */

    /* Fire a trigger by id, using STEP semantics (Petri-net standard):
       1. Snapshot the marking at trigger-press time.
       2. Classify every transition/gate attached to this trigger as
          enabled/not-enabled against the SNAPSHOT (not the live
          marking). A transition is enabled iff its source had enough
          tokens AND its destination had room — at snapshot time.
       3. Apply the enabled set in creation order against the LIVE
          marking. Conflicts (someone earlier in the step consumed the
          tokens, or a destination filled up) silently skip with a
          source flash if it was a token-shortage.

       Why this matters: in a pipeline like  S1 -t1-> S2 -t1-> S3
       with S2 starting empty and S1 holding one token, the user
       expects pressing t1 to move S1's token to S2 only — the second
       transition S2->S3 was NOT enabled at trigger time (S2 had 0
       tokens). Without snapshot semantics, the freshly-arrived token
       at S2 would immediately leave again in the same step, and the
       token would "race" the entire pipeline on a single click. */
    function fireTrigger(triggerId) {
        if (!running || ended || !machine) return;

        const snap = new Map(marking);

        // Phase 1 — classify against snapshot.
        const enabled = [];
        machine.transitions.forEach(t => {
            if (t.triggerId !== triggerId) return;
            const r = _classifyTransition(t, snap);
            if (r.enabled) enabled.push({ kind: 'trans', item: t });
            else r.flashes.forEach(_flashFailQuiet);
        });
        machine.gates.forEach(g => {
            if (g.triggerId !== triggerId) return;
            const r = _classifyGate(g, snap);
            if (r.enabled) enabled.push({ kind: 'gate', item: g, payingInputs: r.payingInputs });
            else r.flashes.forEach(_flashFailQuiet);
        });

        // Phase 2 — apply against live marking in creation order.
        enabled.forEach(entry => {
            if (entry.kind === 'trans') _applyTransition(entry.item);
            else                        _applyGate(entry.item, entry.payingInputs);
        });

        _checkAutoStop();
        _emitStatus();
    }

    /* ── Classifiers (read-only, against snapshot) ────────────────── */

    /* Returns { enabled: bool, flashes: [stateId] }. A snapshot
       classification with `enabled === true` means "this fire is
       allowed by the marking at trigger-press time"; whether it
       actually fires depends on apply-phase availability. */
    function _classifyTransition(t, snap) {
        const src = machine.stateById(t.from);
        const dst = machine.stateById(t.to);
        if (!src || !dst) return { enabled: false, flashes: [] };

        const srcSnap = snap.get(src.id) || 0;
        if (srcSnap < src.inputCost) {
            return { enabled: false, flashes: [src.id] };
        }

        // Self-loop: the post-fire token count of src is
        // srcSnap - inputCost + outputYield, which must fit in
        // src's own buffer. (Treating it as a separate src + dst
        // would double-count.)
        if (src.id === dst.id) {
            const final = srcSnap - src.inputCost + src.outputYield;
            if (final > src.bufferCap) {
                // Self-loop would overflow — destination side is "full".
                return { enabled: false, flashes: [] };
            }
            return { enabled: true, flashes: [] };
        }

        const dstSnap = snap.get(dst.id) || 0;
        if (dstSnap + src.outputYield > dst.bufferCap) {
            // Destination already at/over cap; user sees it as red.
            return { enabled: false, flashes: [] };
        }
        return { enabled: true, flashes: [] };
    }

    function _classifyGate(g, snap) {
        if (g.type === 'SPLIT') return _classifySplit(g, snap);

        const dst = machine.stateById(g.to);
        if (!dst) return { enabled: false, flashes: [] };
        const inputs = g.inputs
            .map(id => machine.stateById(id))
            .filter(s => !!s);
        if (inputs.length === 0) return { enabled: false, flashes: [] };

        const eligible = inputs.filter(s =>
            (snap.get(s.id) || 0) >= s.inputCost
        );

        let payingInputs = [];
        if (g.type === 'AND') {
            if (eligible.length !== inputs.length) {
                const flashes = inputs
                    .filter(s => (snap.get(s.id) || 0) < s.inputCost)
                    .map(s => s.id);
                return { enabled: false, flashes };
            }
            payingInputs = inputs;
        } else if (g.type === 'OR') {
            if (eligible.length === 0) {
                return { enabled: false, flashes: inputs.map(s => s.id) };
            }
            payingInputs = [eligible[0]];
        } else if (g.type === 'XOR') {
            if (eligible.length === 0) {
                return { enabled: false, flashes: inputs.map(s => s.id) };
            }
            if (eligible.length > 1) {
                return { enabled: false, flashes: eligible.map(s => s.id) };
            }
            payingInputs = [eligible[0]];
        } else {
            return { enabled: false, flashes: [] };
        }

        const totalYield = payingInputs.reduce((sum, s) => sum + s.outputYield, 0);
        const dstSnap    = snap.get(dst.id) || 0;
        if (dstSnap + totalYield > dst.bufferCap) {
            return { enabled: false, flashes: [] };
        }
        // Stash the resolved paying-inputs on the result so the apply
        // phase doesn't have to re-evaluate the OR/XOR choice.
        return { enabled: true, flashes: [], payingInputs };
    }

    /* SPLIT classification: source must have N × inputCost tokens
       (one cost per branch — each output state is essentially its own
       parallel transition firing in the same atomic step), and every
       destination must have room for outputYield. */
    function _classifySplit(g, snap) {
        const srcId = g.inputs && g.inputs[0];
        if (!srcId) return { enabled: false, flashes: [] };
        const src = machine.stateById(srcId);
        if (!src) return { enabled: false, flashes: [] };

        const outs = (g.outputs || [])
            .map(id => machine.stateById(id))
            .filter(s => !!s);
        if (outs.length === 0) return { enabled: false, flashes: [] };

        const required = outs.length * src.inputCost;
        const srcSnap  = snap.get(src.id) || 0;
        if (srcSnap < required) {
            return { enabled: false, flashes: [src.id] };
        }

        const anyFull = outs.some(d =>
            (snap.get(d.id) || 0) + src.outputYield > d.bufferCap
        );
        if (anyFull) {
            return { enabled: false, flashes: [] };
        }
        return { enabled: true, flashes: [] };
    }

    /* ── Apply phase (mutates live marking) ───────────────────────── */

    function _applyTransition(t) {
        const src = machine.stateById(t.from);
        const dst = machine.stateById(t.to);
        if (!src || !dst) return;

        const srcLive = marking.get(src.id) || 0;
        if (srcLive < src.inputCost) {
            // Apply-time precondition fail — someone earlier in this
            // step consumed the tokens. Flash for visibility.
            _flashFailQuiet(src.id);
            return;
        }

        if (src.id === dst.id) {
            const final = srcLive - src.inputCost + src.outputYield;
            if (final > src.bufferCap) return;
            marking.set(src.id, final);
            return;
        }

        const dstLive = marking.get(dst.id) || 0;
        if (dstLive + src.outputYield > dst.bufferCap) {
            return;  // Dest filled by earlier firing — silent skip.
        }
        marking.set(src.id, srcLive - src.inputCost);
        marking.set(dst.id, dstLive + src.outputYield);
    }

    function _applyGate(g, payingInputs) {
        if (g.type === 'SPLIT') return _applySplitGate(g);

        const dst = machine.stateById(g.to);
        if (!dst) return;
        if (!payingInputs || payingInputs.length === 0) return;

        // The snapshot already decided which inputs pay (which matters
        // for OR's "first eligible" and XOR's "exactly one"). Apply
        // just verifies the decision is still feasible against the
        // live marking. If not, flash the shorts and silently skip —
        // a conflicting firing earlier in this step has invalidated
        // the snapshot.
        const shortInputs = payingInputs.filter(s =>
            (marking.get(s.id) || 0) < s.inputCost
        );
        if (shortInputs.length > 0) {
            shortInputs.forEach(s => _flashFailQuiet(s.id));
            return;
        }

        const totalYield = payingInputs.reduce((sum, s) => sum + s.outputYield, 0);
        const dstLive    = marking.get(dst.id) || 0;
        if (dstLive + totalYield > dst.bufferCap) return;

        payingInputs.forEach(s =>
            marking.set(s.id, (marking.get(s.id) || 0) - s.inputCost)
        );
        marking.set(dst.id, dstLive + totalYield);
    }

    /* SPLIT apply — atomic fan-out. Source must currently hold
       N × inputCost. If yes, source loses that total; each destination
       gains outputYield independently. All-or-nothing on apply too. */
    function _applySplitGate(g) {
        const srcId = g.inputs && g.inputs[0];
        if (!srcId) return;
        const src = machine.stateById(srcId);
        if (!src) return;

        const outs = (g.outputs || [])
            .map(id => machine.stateById(id))
            .filter(s => !!s);
        if (outs.length === 0) return;

        const required = outs.length * src.inputCost;
        const srcLive  = marking.get(src.id) || 0;
        if (srcLive < required) {
            _flashFailQuiet(src.id);
            return;
        }
        const anyFull = outs.some(d =>
            (marking.get(d.id) || 0) + src.outputYield > d.bufferCap
        );
        if (anyFull) return;

        marking.set(src.id, srcLive - required);
        outs.forEach(d =>
            marking.set(d.id, (marking.get(d.id) || 0) + src.outputYield)
        );
    }

    /* ── Timers ───────────────────────────────────────────────────── */

    /* Start a timer trigger. Honours initialDelay, then fires every
       period seconds, optionally one-shot. */
    function startTimer(triggerId) {
        if (!running || ended || !machine) return false;
        const trg = machine.triggerById(triggerId);
        if (!trg || trg.kind !== 'timer') return false;
        if (timerHandles.has(triggerId)) return false;  // already running

        const periodMs = Math.max(100, (trg.period || 1) * 1000);
        const delayMs  = Math.max(0,   (trg.initialDelay || 0) * 1000);

        const handle = { intervalId: null, initialTo: null };

        const fireOnce = () => {
            fireTrigger(triggerId);
            if (trg.oneShot) stopTimer(triggerId);
        };

        handle.initialTo = setTimeout(() => {
            fireOnce();
            if (trg.oneShot) return;
            if (!timerHandles.has(triggerId)) return;   // stopped during delay
            handle.intervalId = setInterval(fireOnce, periodMs);
        }, delayMs);

        timerHandles.set(triggerId, handle);
        return true;
    }

    function stopTimer(triggerId) {
        const h = timerHandles.get(triggerId);
        if (!h) return false;
        if (h.initialTo)  clearTimeout(h.initialTo);
        if (h.intervalId) clearInterval(h.intervalId);
        timerHandles.delete(triggerId);
        return true;
    }

    function isTimerRunning(triggerId) {
        return timerHandles.has(triggerId);
    }

    function _stopAllTimers() {
        Array.from(timerHandles.keys()).forEach(stopTimer);
    }

    /* ── Flash (yellow precondition-fail) ─────────────────────────── */

    /* Mark a state as flashing-fail. The status emit is the caller's
       responsibility now (batched at the end of fireTrigger) so multiple
       flashes from the same trigger event collapse to one paint. The
       clear-timeout below still emits because it runs asynchronously
       and is the only way to repaint when the flash ends. */
    function _flashFail(stateId) {
        const existing = flashTimers.get(stateId);
        if (existing) clearTimeout(existing);

        flashSet.add(stateId);

        const to = setTimeout(() => {
            flashSet.delete(stateId);
            flashTimers.delete(stateId);
            _emitStatus();
        }, CONFIG.flashMs);
        flashTimers.set(stateId, to);
    }

    /* Alias used by the new step-firing logic to make the intent
       (no immediate emit) explicit at call sites. */
    const _flashFailQuiet = _flashFail;

    function _clearAllFlash() {
        flashTimers.forEach(to => clearTimeout(to));
        flashTimers.clear();
        flashSet.clear();
    }

    /* ── Auto-stop ────────────────────────────────────────────────── */

    function _checkAutoStop() {
        if (!machine || ended) return;
        const ends = machine.endStates();
        const arrived = ends.find(s => (marking.get(s.id) || 0) > 0);
        if (arrived) {
            ended = true;
            _stopAllTimers();
            _emitMessage(
                'Simulation ended — token reached end state "' + arrived.name + '".'
            );
        }
    }

    /* ── Emit ─────────────────────────────────────────────────────── */

    function _emitStatus() {
        if (!api.onStatusChange) return;
        if (!machine) { api.onStatusChange([]); return; }
        const snapshot = machine.states.map(s => ({
            id:     s.id,
            tokens: marking.get(s.id) || 0,
            status: statusOf(s.id)
        }));
        api.onStatusChange(snapshot);
    }

    function _emitMessage(msg) {
        if (api.onSimMessage) api.onSimMessage(msg);
    }

    return {
        init, startSim, resetSim, stopSim,
        fireTrigger, startTimer, stopTimer, isTimerRunning,
        isRunning, isEnded, tokensOf, statusOf
    };
})();
