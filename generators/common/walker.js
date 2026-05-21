/**
 * generators/common/walker.js
 * Machine Studio [MS] — Machine → IR walker for code generators.
 *
 * Walks a Machine and produces a normalized intermediate
 * representation: sanitized identifiers attached to every state and
 * trigger, transitions and gates resolved against state/trigger
 * objects (so emitters don't have to look anything up by id), and
 * a sanitization map for the generated README.
 *
 * The IR shape:
 *   {
 *     name, cIdent,
 *     states: [{ id, name, enumName, handlerName, kind,
 *                inputCost, outputYield, bufferCap, initialTokens, index }],
 *     triggers: [{ id, name, kind, fnName, constName, index, period?, oneShot?, initialDelay? }],
 *     transitions: [{ id, from:state, to:state, trigger?:trigger }],
 *     gates: [{ id, type:'AND'|'OR'|'XOR'|'SPLIT',
 *               inputs?:[state], to?:state,            // AND/OR/XOR
 *               source?:state, outputs?:[state],       // SPLIT
 *               trigger?:trigger }],
 *     sanitizeMap: [{ original, generated }],
 *     warnings: [string]
 *   }
 *
 * Depends on: sanitize.js
 */

const walker = (() => {

    function walk(machine) {
        if (!machine) return null;

        const ir = {
            name:        machine.name || 'Machine',
            cIdent:      sanitize.toIdent(machine.name || 'machine', 'machine'),
            states:      [],
            triggers:    [],
            transitions: [],
            gates:       [],
            sanitizeMap: [],
            warnings:    []
        };

        // Reserved symbols that we emit ourselves — disambiguate around them.
        const usedEnums = new Set([
            'SM_STATE_COUNT', 'SM_STATE_INVALID', 'STATE_COUNT', 'STATE_INVALID'
        ]);
        const usedHandlers     = new Set();
        const usedTriggerFns   = new Set();
        const usedTriggerConst = new Set();

        // ── States ────────────────────────────────────────────────
        machine.states.forEach((s, idx) => {
            const baseEnum    = 'S_' + sanitize.toEnum(s.name, 'STATE_' + (idx + 1));
            const enumName    = sanitize.disambiguate(baseEnum, usedEnums);
            const baseHandler = 'state_' + sanitize.toIdent(s.name, 'state_' + (idx + 1));
            const handlerName = sanitize.disambiguate(baseHandler, usedHandlers);

            ir.sanitizeMap.push({
                original:  s.name || '(unnamed state ' + (idx + 1) + ')',
                generated: enumName + '   /   ' + handlerName + '()'
            });

            ir.states.push({
                id:            s.id,
                name:          s.name || ('State ' + (idx + 1)),
                enumName, handlerName,
                kind:          s.kind || 'normal',
                inputCost:     s.inputCost,
                outputYield:   s.outputYield,
                bufferCap:     s.bufferCap,
                initialTokens: s.initialTokens || 0,
                index:         idx
            });
        });

        // ── Triggers ──────────────────────────────────────────────
        machine.triggers.forEach((t, idx) => {
            const baseFn    = 'fire_' + sanitize.toIdent(t.name, 'trigger_' + (idx + 1));
            const fnName    = sanitize.disambiguate(baseFn, usedTriggerFns);
            const baseConst = 'TRIG_' + sanitize.toEnum(t.name, 'TRIGGER_' + (idx + 1));
            const constName = sanitize.disambiguate(baseConst, usedTriggerConst);

            ir.sanitizeMap.push({
                original:  t.name || '(unnamed trigger ' + (idx + 1) + ')',
                generated: constName + '   /   ' + fnName + '()'
            });

            const tIr = {
                id:    t.id,
                name:  t.name || ('Trigger ' + (idx + 1)),
                kind:  t.kind || 'manual',
                fnName, constName,
                index: idx
            };
            if (tIr.kind === 'timer') {
                tIr.period       = t.period       != null ? t.period       : 5;
                tIr.oneShot      = !!t.oneShot;
                tIr.initialDelay = t.initialDelay != null ? t.initialDelay : 0;
            }
            ir.triggers.push(tIr);
        });

        const stateById   = new Map(ir.states  .map(s => [s.id, s]));
        const triggerById = new Map(ir.triggers.map(t => [t.id, t]));

        // ── Transitions ───────────────────────────────────────────
        machine.transitions.forEach(t => {
            const from = stateById.get(t.from);
            const to   = stateById.get(t.to);
            if (!from || !to) {
                ir.warnings.push('Skipped transition with dangling endpoint.');
                return;
            }
            const trg = t.triggerId ? triggerById.get(t.triggerId) : null;
            if (t.triggerId && !trg) {
                ir.warnings.push('Transition references missing trigger; will never fire.');
            }
            ir.transitions.push({ id: t.id, from, to, trigger: trg || null });
        });

        // ── Gates ─────────────────────────────────────────────────
        machine.gates.forEach(g => {
            const trg = g.triggerId ? triggerById.get(g.triggerId) : null;

            if (g.type === 'SPLIT') {
                const inputs  = (g.inputs  || []).map(id => stateById.get(id)).filter(Boolean);
                const outputs = (g.outputs || []).map(id => stateById.get(id)).filter(Boolean);
                if (inputs.length < 1 || outputs.length < 2) {
                    ir.warnings.push('Skipped malformed SPLIT gate.');
                    return;
                }
                ir.gates.push({
                    id: g.id, type: 'SPLIT',
                    source: inputs[0], outputs,
                    trigger: trg || null
                });
            } else {
                if (!['AND', 'OR', 'XOR'].includes(g.type)) {
                    ir.warnings.push('Skipped gate of unknown type: ' + g.type);
                    return;
                }
                const inputs = (g.inputs || []).map(id => stateById.get(id)).filter(Boolean);
                const to     = stateById.get(g.to);
                if (!to || inputs.length < 2) {
                    ir.warnings.push('Skipped malformed ' + g.type + ' gate.');
                    return;
                }
                ir.gates.push({
                    id: g.id, type: g.type,
                    inputs, to,
                    trigger: trg || null
                });
            }
        });

        return ir;
    }

    return { walk };
})();
