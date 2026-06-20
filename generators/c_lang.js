/**
 * generators/c_lang.js
 * Machine Studio [MS] — C language code generator.
 *
 * Two patterns supported:
 *   'table'  — transitions table + per-state handler table + dispatch
 *              functions. Matches the "function-pointer for current
 *              state" API explicitly.
 *   'switch' — single sm_fire() with a switch on trigger_id, inlined
 *              transition logic per case. Easier to read end-to-end.
 *
 * Both patterns emit the same public API in state_machine.h:
 *   sm_init / sm_reset
 *   sm_tokens_in / sm_total_tokens                       (Petri-net)
 *   sm_current_state / sm_current_handler                (FSM-style)
 *   fire_<sanitized_name>() per trigger + sm_fire(id)
 *
 * The user implements per-state handlers in their own .c file —
 * the header `extern`s the prototypes.
 *
 * Depends on: sanitize.js, emit.js, walker.js (IR shape)
 */

const c_lang = (() => {

    const ID                = 'c';
    const NAME              = 'C';
    const SUPPORTED_PATTERNS = ['table', 'switch'];

    /* ─── public entry ──────────────────────────────────────────── */

    function generate(ir, opts) {
        // FSM formalism gets the dedicated finite-state-machine generator
        // (a transition table + single current state), not the Petri
        // token engine below.
        if (ir.mode === 'FSM' && typeof c_fsm !== 'undefined') {
            return c_fsm.generate(ir, opts);
        }

        if (!SUPPORTED_PATTERNS.includes(opts.pattern)) {
            return { ok: false,
                error: 'C generator does not support pattern "' + opts.pattern + '". ' +
                       'Supported: ' + SUPPORTED_PATTERNS.join(', ') };
        }
        if (ir.states.length === 0) {
            return { ok: false, error: 'Machine has no states — nothing to generate.' };
        }

        const ctx = _ctx(ir, opts);
        const files = [];

        files.push({ name: 'state_machine.h', content: _emitHeader(ctx) });
        files.push({ name: 'state_machine.c', content: opts.pattern === 'table'
                                                     ? _emitSourceTable(ctx)
                                                     : _emitSourceSwitch(ctx) });
        files.push({ name: 'main.c',          content: _emitExampleMain(ctx) });
        files.push({ name: 'test_state_machine.c', content: _emitTests(ctx) });
        files.push({ name: 'Makefile',        content: _emitMakefile(ctx) });
        files.push({ name: 'README.md',       content: _emitReadme(ctx) });

        return {
            ok: true,
            files,
            previewFile: 'state_machine.c',
            warnings: ir.warnings || []
        };
    }

    /* ─── context: per-generation precomputed bits ─────────────── */

    function _ctx(ir, opts) {
        return {
            ir, opts,
            hasTransitions: ir.transitions.length > 0,
            hasGates:       ir.gates.length > 0,
            anyTriggered:   ir.transitions.some(t => t.trigger) ||
                            ir.gates.some(g => g.trigger),
            stamp:          new Date().toISOString().slice(0, 10)
        };
    }

    /* ============================================================
       HEADER (shared between both patterns)
       ============================================================ */

    function _emitHeader(ctx) {
        const ir = ctx.ir;

        const stateEnum = ir.states
            .map((s, i) => '    ' + emit.pad(s.enumName + ',', 28) + '/* ' + s.name + ' */')
            .join('\n');

        const stateHandlerExterns = ir.states
            .map(s => 'extern void ' + s.handlerName + '(void);')
            .join('\n');

        const triggerConsts = ir.triggers.length
            ? ir.triggers.map((t, i) =>
                '#define ' + emit.pad(t.constName, 28) + ' ' + i +
                '   /* ' + t.name + (t.kind === 'timer' ? ' (timer)' : '') + ' */'
              ).join('\n')
            : '/* No triggers defined — sm_fire() is a no-op. */';

        const triggerFnDecls = ir.triggers.length
            ? ir.triggers.map(t => 'void ' + t.fnName + '(void);').join('\n')
            : '/* No per-trigger functions: no triggers were defined. */';

        const body =
`#include <stdbool.h>
#include <stddef.h>

${emit.section('States')}

typedef enum {
${stateEnum}
    SM_STATE_COUNT,
    SM_STATE_INVALID = -1
} state_t;

${emit.section('Per-state handlers (you implement these)')}

/* Each handler is invoked when sm_current_handler() is called and
   returns it (i.e. when the marking holds exactly one token). The
   header only declares; implement them in your own .c file. */

typedef void (*state_fn)(void);

${stateHandlerExterns}

${emit.section('Trigger ids — integer API')}

${triggerConsts}

${emit.section('Lifecycle')}

void sm_init(void);   /* Seeds marking from each state's initial_tokens. */
void sm_reset(void);  /* Same as init. */

${emit.section('Petri-net accessors (always defined)')}

int sm_tokens_in(state_t s);
int sm_total_tokens(void);

${emit.section('FSM-style accessors (valid when marking is singleton)')}

/* sm_current_state() returns SM_STATE_INVALID, and sm_current_handler()
   returns NULL, when the marking holds zero or more than one token —
   that is, when the machine is in a concurrent configuration that has
   no single "current state". For single-token state machines they
   always return the active state and its handler. */

state_t  sm_current_state(void);
state_fn sm_current_handler(void);

${emit.section('Trigger functions — fire one trigger at a time')}

void sm_fire(int trigger_id);

${triggerFnDecls}`;

        const meta = [
            'Machine:    ' + ir.name,
            'Generated:  ' + ctx.stamp,
            'Pattern:    ' + ctx.opts.pattern + ' — ' + _patternBlurb(ctx.opts.pattern),
            'States:     ' + ir.states.length,
            'Transitions:' + ir.transitions.length +
                (ir.gates.length ? '   Gates: ' + ir.gates.length : ''),
            'Triggers:   ' + ir.triggers.length,
            '',
            'Do not edit by hand — regenerate from the .json.'
        ];

        return emit.banner('state_machine.h  —  ' + ir.name, meta) + '\n' +
               emit.headerGuard('SM_STATE_MACHINE_H', body);
    }

    function _patternBlurb(p) {
        return p === 'table'
            ? 'tables + per-state handler function pointers'
            : 'single switch over trigger ids';
    }

    /* ============================================================
       SOURCE — TABLE PATTERN
       ============================================================ */

    function _emitSourceTable(ctx) {
        const ir = ctx.ir;

        const stateAttrs = ir.states.map(s =>
            '    [' + s.enumName + '] = ' +
            '{ .input_cost = ' + s.inputCost +
              ', .output_yield = ' + s.outputYield +
              ', .buffer_cap = ' + s.bufferCap +
              ', .initial_tokens = ' + s.initialTokens + ' },   /* ' + s.name + ' */'
        ).join('\n');

        const handlerEntries = ir.states.map(s =>
            '    [' + s.enumName + '] = ' + s.handlerName + ','
        ).join('\n');

        const transitionsCode = ctx.hasTransitions
            ? _emitTransitionsTable(ctx)
            : '/* No transitions defined. */\n';

        const gatesCode = ctx.hasGates
            ? _emitGatesTable(ctx)
            : '/* No gates defined. */\n';

        const fireImpl = _emitFireDispatch(ctx);

        const perTriggerFns = ir.triggers.length
            ? ir.triggers.map(t =>
                'void ' + t.fnName + '(void) { sm_fire(' + t.constName + '); }'
              ).join('\n')
            : '/* No per-trigger functions: no triggers were defined. */';

        const meta = [
            'Machine:    ' + ir.name,
            'Pattern:    table — transitions table + state handler table',
            'Generated:  ' + ctx.stamp
        ];

        return emit.banner('state_machine.c  —  ' + ir.name, meta) + '\n\n' +
`#include "state_machine.h"
#include <string.h>

${emit.section('State attributes — indexed by state_t')}

typedef struct {
    int input_cost;
    int output_yield;
    int buffer_cap;
    int initial_tokens;
} sm_state_attrs_t;

static const sm_state_attrs_t STATE_ATTRS[SM_STATE_COUNT] = {
${stateAttrs}
};

${emit.section('State handler table — indexed by state_t')}

static const state_fn STATE_HANDLERS[SM_STATE_COUNT] = {
${handlerEntries}
};

${emit.section('Live marking')}

static int sm_marking[SM_STATE_COUNT];
static int sm_snapshot[SM_STATE_COUNT];

${emit.section('Lifecycle')}

void sm_init(void) { sm_reset(); }

void sm_reset(void) {
    for (int i = 0; i < SM_STATE_COUNT; i++) {
        sm_marking[i] = STATE_ATTRS[i].initial_tokens;
    }
}

${emit.section('Accessors')}

int sm_tokens_in(state_t s) {
    if ((int)s < 0 || s >= SM_STATE_COUNT) return 0;
    return sm_marking[s];
}

int sm_total_tokens(void) {
    int sum = 0;
    for (int i = 0; i < SM_STATE_COUNT; i++) sum += sm_marking[i];
    return sum;
}

state_t sm_current_state(void) {
    state_t found = SM_STATE_INVALID;
    int count = 0;
    for (int i = 0; i < SM_STATE_COUNT; i++) {
        if (sm_marking[i] > 0) { found = (state_t)i; count++; }
    }
    return count == 1 ? found : SM_STATE_INVALID;
}

state_fn sm_current_handler(void) {
    state_t s = sm_current_state();
    return (s == SM_STATE_INVALID) ? NULL : STATE_HANDLERS[s];
}

${transitionsCode}
${gatesCode}
${fireImpl}

${emit.section('Per-trigger wrappers')}

${perTriggerFns}
`;
    }

    function _emitTransitionsTable(ctx) {
        const ir = ctx.ir;
        const rows = ir.transitions.map(t => {
            const trgConst = t.trigger ? t.trigger.constName : '-1';
            return '    { ' + emit.pad(trgConst + ',', 28) +
                              emit.pad(t.from.enumName + ',', 22) +
                              t.to.enumName + ' },';
        }).join('\n');

        return `
${emit.section('Transitions table')}

typedef struct {
    int     trigger_id;
    state_t from;
    state_t to;
} sm_transition_t;

static const sm_transition_t TRANSITIONS[] = {
${rows}
};
#define SM_TRANSITION_COUNT (sizeof(TRANSITIONS) / sizeof(TRANSITIONS[0]))

${emit.section('Transition firing helpers')}

static bool sm_transition_enabled(const sm_transition_t *t, const int *m) {
    int cost  = STATE_ATTRS[t->from].input_cost;
    int yield = STATE_ATTRS[t->from].output_yield;
    if (m[t->from] < cost) return false;
    if (t->from == t->to) {
        /* Self-loop: post-fire token count of src. */
        int final_ = m[t->from] - cost + yield;
        return final_ <= STATE_ATTRS[t->from].buffer_cap;
    }
    return m[t->to] + yield <= STATE_ATTRS[t->to].buffer_cap;
}

static void sm_transition_apply(const sm_transition_t *t) {
    int cost  = STATE_ATTRS[t->from].input_cost;
    int yield = STATE_ATTRS[t->from].output_yield;
    if (sm_marking[t->from] < cost) return;
    if (t->from == t->to) {
        int final_ = sm_marking[t->from] - cost + yield;
        if (final_ > STATE_ATTRS[t->from].buffer_cap) return;
        sm_marking[t->from] = final_;
    } else {
        if (sm_marking[t->to] + yield > STATE_ATTRS[t->to].buffer_cap) return;
        sm_marking[t->from] -= cost;
        sm_marking[t->to]   += yield;
    }
}
`;
    }

    function _emitGatesTable(ctx) {
        const ir = ctx.ir;

        /* Compute the max input/output count actually used so the gate
           struct's fixed arrays are sized appropriately. We bump by a
           sensible minimum so the array dimensions read naturally. */
        let maxIn = 2, maxOut = 2;
        ir.gates.forEach(g => {
            if (g.type === 'SPLIT') {
                if (1 > maxIn) maxIn = 1;
                if (g.outputs.length > maxOut) maxOut = g.outputs.length;
            } else {
                if (g.inputs.length > maxIn) maxIn = g.inputs.length;
            }
        });

        const rows = ir.gates.map(g => {
            const trgConst = g.trigger ? g.trigger.constName : '-1';
            let inputsArr, outputsArr, toEnum, inputCount, outputCount;
            if (g.type === 'SPLIT') {
                inputsArr   = '{ ' + g.source.enumName + ' }';
                outputsArr  = '{ ' + g.outputs.map(o => o.enumName).join(', ') + ' }';
                toEnum      = 'SM_STATE_INVALID';
                inputCount  = 1;
                outputCount = g.outputs.length;
            } else {
                inputsArr   = '{ ' + g.inputs.map(i => i.enumName).join(', ') + ' }';
                outputsArr  = '{ 0 }';
                toEnum      = g.to.enumName;
                inputCount  = g.inputs.length;
                outputCount = 0;
            }
            return '    { ' +
                '.trigger_id = ' + trgConst + ', ' +
                '.type = SM_GATE_' + g.type + ', ' +
                '.input_count = ' + inputCount + ', ' +
                '.inputs = ' + inputsArr + ', ' +
                '.output_count = ' + outputCount + ', ' +
                '.outputs = ' + outputsArr + ', ' +
                '.to = ' + toEnum + ' },';
        }).join('\n');

        return `
${emit.section('Gates table')}

typedef enum {
    SM_GATE_AND,
    SM_GATE_OR,
    SM_GATE_XOR,
    SM_GATE_SPLIT
} sm_gate_type_t;

#define SM_MAX_GATE_INPUTS  ${maxIn}
#define SM_MAX_GATE_OUTPUTS ${maxOut}

typedef struct {
    int             trigger_id;
    sm_gate_type_t  type;
    int             input_count;
    state_t         inputs[SM_MAX_GATE_INPUTS];
    int             output_count;
    state_t         outputs[SM_MAX_GATE_OUTPUTS];
    state_t         to;
} sm_gate_t;

static const sm_gate_t GATES[] = {
${rows}
};
#define SM_GATE_COUNT (sizeof(GATES) / sizeof(GATES[0]))

${emit.section('Gate firing helpers')}

/* Classify returns enabledness; for OR/XOR, the chosen input index
   is written to *out_chosen so the apply phase can charge the right
   input (matches the snapshot decision from the JS simulator). */
static bool sm_gate_enabled(const sm_gate_t *g, const int *m, int *out_chosen) {
    *out_chosen = -1;
    switch (g->type) {
        case SM_GATE_AND: {
            int total_yield = 0;
            for (int i = 0; i < g->input_count; i++) {
                if (m[g->inputs[i]] < STATE_ATTRS[g->inputs[i]].input_cost) return false;
                total_yield += STATE_ATTRS[g->inputs[i]].output_yield;
            }
            return m[g->to] + total_yield <= STATE_ATTRS[g->to].buffer_cap;
        }
        case SM_GATE_OR:
            for (int i = 0; i < g->input_count; i++) {
                if (m[g->inputs[i]] >= STATE_ATTRS[g->inputs[i]].input_cost) {
                    int y = STATE_ATTRS[g->inputs[i]].output_yield;
                    if (m[g->to] + y <= STATE_ATTRS[g->to].buffer_cap) {
                        *out_chosen = i;
                        return true;
                    }
                }
            }
            return false;
        case SM_GATE_XOR: {
            int chosen = -1, count = 0;
            for (int i = 0; i < g->input_count; i++) {
                if (m[g->inputs[i]] >= STATE_ATTRS[g->inputs[i]].input_cost) {
                    chosen = i; count++;
                }
            }
            if (count != 1) return false;
            int y = STATE_ATTRS[g->inputs[chosen]].output_yield;
            if (m[g->to] + y > STATE_ATTRS[g->to].buffer_cap) return false;
            *out_chosen = chosen;
            return true;
        }
        case SM_GATE_SPLIT: {
            state_t src = g->inputs[0];
            int required = g->output_count * STATE_ATTRS[src].input_cost;
            if (m[src] < required) return false;
            int yield = STATE_ATTRS[src].output_yield;
            for (int i = 0; i < g->output_count; i++) {
                if (m[g->outputs[i]] + yield > STATE_ATTRS[g->outputs[i]].buffer_cap)
                    return false;
            }
            return true;
        }
    }
    return false;
}

static void sm_gate_apply(const sm_gate_t *g, int chosen) {
    switch (g->type) {
        case SM_GATE_AND: {
            int total_yield = 0;
            for (int i = 0; i < g->input_count; i++) {
                if (sm_marking[g->inputs[i]] < STATE_ATTRS[g->inputs[i]].input_cost) return;
                total_yield += STATE_ATTRS[g->inputs[i]].output_yield;
            }
            if (sm_marking[g->to] + total_yield > STATE_ATTRS[g->to].buffer_cap) return;
            for (int i = 0; i < g->input_count; i++) {
                sm_marking[g->inputs[i]] -= STATE_ATTRS[g->inputs[i]].input_cost;
            }
            sm_marking[g->to] += total_yield;
            break;
        }
        case SM_GATE_OR:
        case SM_GATE_XOR: {
            if (chosen < 0) return;
            state_t in = g->inputs[chosen];
            int cost  = STATE_ATTRS[in].input_cost;
            int yield = STATE_ATTRS[in].output_yield;
            if (sm_marking[in] < cost) return;
            if (sm_marking[g->to] + yield > STATE_ATTRS[g->to].buffer_cap) return;
            sm_marking[in]    -= cost;
            sm_marking[g->to] += yield;
            break;
        }
        case SM_GATE_SPLIT: {
            state_t src = g->inputs[0];
            int required = g->output_count * STATE_ATTRS[src].input_cost;
            int yield = STATE_ATTRS[src].output_yield;
            if (sm_marking[src] < required) return;
            for (int i = 0; i < g->output_count; i++) {
                if (sm_marking[g->outputs[i]] + yield > STATE_ATTRS[g->outputs[i]].buffer_cap) return;
            }
            sm_marking[src] -= required;
            for (int i = 0; i < g->output_count; i++) {
                sm_marking[g->outputs[i]] += yield;
            }
            break;
        }
    }
}
`;
    }

    function _emitFireDispatch(ctx) {
        const tPhase1 = ctx.hasTransitions ? `
    /* Phase 1a: classify transitions against snapshot. */
    bool t_enabled[SM_TRANSITION_COUNT];
    for (size_t i = 0; i < SM_TRANSITION_COUNT; i++) {
        t_enabled[i] = (TRANSITIONS[i].trigger_id == trigger_id)
                    && sm_transition_enabled(&TRANSITIONS[i], sm_snapshot);
    }` : '';

        const gPhase1 = ctx.hasGates ? `
    /* Phase 1b: classify gates against snapshot. */
    bool g_enabled[SM_GATE_COUNT];
    int  g_chosen[SM_GATE_COUNT];
    for (size_t i = 0; i < SM_GATE_COUNT; i++) {
        g_enabled[i] = false;
        g_chosen[i]  = -1;
        if (GATES[i].trigger_id != trigger_id) continue;
        g_enabled[i] = sm_gate_enabled(&GATES[i], sm_snapshot, &g_chosen[i]);
    }` : '';

        const tPhase2 = ctx.hasTransitions ? `
    /* Phase 2a: apply transitions in creation order. */
    for (size_t i = 0; i < SM_TRANSITION_COUNT; i++) {
        if (t_enabled[i]) sm_transition_apply(&TRANSITIONS[i]);
    }` : '';

        const gPhase2 = ctx.hasGates ? `
    /* Phase 2b: apply gates in creation order. */
    for (size_t i = 0; i < SM_GATE_COUNT; i++) {
        if (g_enabled[i]) sm_gate_apply(&GATES[i], g_chosen[i]);
    }` : '';

        const unused = !ctx.hasTransitions && !ctx.hasGates ? '\n    (void)trigger_id;' : '';

        return `
${emit.section('Trigger dispatch — two-phase step semantics')}

/* Step semantics (matches Machine Studio's simulator):
 *   1. Snapshot the live marking.
 *   2. Classify every transition/gate attached to this trigger
 *      against the SNAPSHOT — so a token arriving at a state
 *      cannot leave again in the same step.
 *   3. Apply the enabled set in creation order against the live
 *      marking. Apply-time conflicts (someone earlier in the step
 *      consumed the tokens) silently skip.
 */
void sm_fire(int trigger_id) {
    memcpy(sm_snapshot, sm_marking, sizeof(sm_marking));
${tPhase1}${gPhase1}
${tPhase2}${gPhase2}${unused}
}`;
    }

    /* ============================================================
       SOURCE — SWITCH PATTERN
       Same data tables for STATE_ATTRS and STATE_HANDLERS, but the
       firing logic is one big switch on trigger_id with the relevant
       transitions/gates inlined per case. Easier for a reader to
       follow end-to-end; the table version is more compact when
       there are lots of triggers.
       ============================================================ */

    function _emitSourceSwitch(ctx) {
        const ir = ctx.ir;

        const stateAttrs = ir.states.map(s =>
            '    [' + s.enumName + '] = ' +
            '{ ' + s.inputCost + ', ' + s.outputYield + ', ' +
                   s.bufferCap + ', ' + s.initialTokens + ' },   /* ' + s.name + ' */'
        ).join('\n');

        const handlerEntries = ir.states.map(s =>
            '    [' + s.enumName + '] = ' + s.handlerName + ','
        ).join('\n');

        const switchCases = ir.triggers.length
            ? ir.triggers.map(t => _emitSwitchCase(ir, t)).join('\n\n')
            : '        /* No triggers defined. */';

        const perTriggerFns = ir.triggers.length
            ? ir.triggers.map(t =>
                'void ' + t.fnName + '(void) { sm_fire(' + t.constName + '); }'
              ).join('\n')
            : '/* No per-trigger functions: no triggers were defined. */';

        const meta = [
            'Machine:    ' + ir.name,
            'Pattern:    switch — one switch/case over trigger ids',
            'Generated:  ' + ctx.stamp
        ];

        return emit.banner('state_machine.c  —  ' + ir.name, meta) + '\n\n' +
`#include "state_machine.h"
#include <string.h>

${emit.section('State attributes — indexed by state_t')}

typedef struct {
    int input_cost;
    int output_yield;
    int buffer_cap;
    int initial_tokens;
} sm_state_attrs_t;

static const sm_state_attrs_t STATE_ATTRS[SM_STATE_COUNT] = {
${stateAttrs}
};

${emit.section('State handler table — indexed by state_t')}

static const state_fn STATE_HANDLERS[SM_STATE_COUNT] = {
${handlerEntries}
};

${emit.section('Live marking + snapshot')}

static int sm_marking[SM_STATE_COUNT];
static int sm_snapshot[SM_STATE_COUNT];

${emit.section('Lifecycle')}

void sm_init(void) { sm_reset(); }

void sm_reset(void) {
    for (int i = 0; i < SM_STATE_COUNT; i++) {
        sm_marking[i] = STATE_ATTRS[i].initial_tokens;
    }
}

${emit.section('Accessors')}

int sm_tokens_in(state_t s) {
    if ((int)s < 0 || s >= SM_STATE_COUNT) return 0;
    return sm_marking[s];
}

int sm_total_tokens(void) {
    int sum = 0;
    for (int i = 0; i < SM_STATE_COUNT; i++) sum += sm_marking[i];
    return sum;
}

state_t sm_current_state(void) {
    state_t found = SM_STATE_INVALID;
    int count = 0;
    for (int i = 0; i < SM_STATE_COUNT; i++) {
        if (sm_marking[i] > 0) { found = (state_t)i; count++; }
    }
    return count == 1 ? found : SM_STATE_INVALID;
}

state_fn sm_current_handler(void) {
    state_t s = sm_current_state();
    return (s == SM_STATE_INVALID) ? NULL : STATE_HANDLERS[s];
}

${emit.section('Trigger dispatch — switch on trigger_id')}

/* Each case block lists the transitions and gates that fire on this
 * trigger. Step semantics: every guard reads from sm_snapshot, every
 * mutation writes to sm_marking, so two transitions sharing a trigger
 * can't cascade-race in the same step. */
void sm_fire(int trigger_id) {
    memcpy(sm_snapshot, sm_marking, sizeof(sm_marking));

    switch (trigger_id) {
${switchCases}
        default:
            /* Unknown trigger id — no effect. */
            break;
    }
}

${emit.section('Per-trigger wrappers')}

${perTriggerFns}
`;
    }

    function _emitSwitchCase(ir, trg) {
        const transitions = ir.transitions.filter(t => t.trigger && t.trigger.id === trg.id);
        const gates       = ir.gates      .filter(g => g.trigger && g.trigger.id === trg.id);

        const tBlocks = transitions.map((t, i) => _emitInlineTransition(t, i)).join('\n');
        const gBlocks = gates      .map((g, i) => _emitInlineGate(g, i + transitions.length)).join('\n');

        const body = (tBlocks + (tBlocks && gBlocks ? '\n' : '') + gBlocks) ||
                     '            /* Nothing wired to this trigger. */';

        return `        case ${trg.constName}: { /* ${trg.name} */
${body}
            break;
        }`;
    }

    function _emitInlineTransition(t, idx) {
        const src = t.from.enumName, dst = t.to.enumName;
        const selfLoop = (t.from.id === t.to.id);

        if (selfLoop) {
            return `            /* Transition #${idx}: ${t.from.name} → ${t.to.name} (self-loop) */
            {
                int cost  = STATE_ATTRS[${src}].input_cost;
                int yield = STATE_ATTRS[${src}].output_yield;
                int final_ = sm_snapshot[${src}] - cost + yield;
                if (sm_snapshot[${src}] >= cost &&
                    final_ <= STATE_ATTRS[${src}].buffer_cap &&
                    sm_marking[${src}] >= cost) {
                    int live_final = sm_marking[${src}] - cost + yield;
                    if (live_final <= STATE_ATTRS[${src}].buffer_cap) {
                        sm_marking[${src}] = live_final;
                    }
                }
            }`;
        }

        return `            /* Transition #${idx}: ${t.from.name} → ${t.to.name} */
            {
                int cost  = STATE_ATTRS[${src}].input_cost;
                int yield = STATE_ATTRS[${src}].output_yield;
                int cap   = STATE_ATTRS[${dst}].buffer_cap;
                if (sm_snapshot[${src}] >= cost &&
                    sm_snapshot[${dst}] + yield <= cap &&
                    sm_marking[${src}]  >= cost &&
                    sm_marking[${dst}]  + yield <= cap) {
                    sm_marking[${src}] -= cost;
                    sm_marking[${dst}] += yield;
                }
            }`;
    }

    function _emitInlineGate(g, idx) {
        if (g.type === 'SPLIT') {
            const src = g.source.enumName;
            const outList = g.outputs.map(o => o.enumName).join(', ');
            return `            /* Gate #${idx}: SPLIT ${g.source.name} → [${g.outputs.map(o => o.name).join(', ')}] */
            {
                state_t splits[] = { ${outList} };
                int n = (int)(sizeof(splits) / sizeof(splits[0]));
                int cost  = STATE_ATTRS[${src}].input_cost;
                int yield = STATE_ATTRS[${src}].output_yield;
                int required = n * cost;
                bool snap_ok = sm_snapshot[${src}] >= required;
                if (snap_ok) for (int i = 0; i < n && snap_ok; i++) {
                    if (sm_snapshot[splits[i]] + yield > STATE_ATTRS[splits[i]].buffer_cap)
                        snap_ok = false;
                }
                bool live_ok = sm_marking[${src}] >= required;
                if (snap_ok && live_ok) {
                    for (int i = 0; i < n && live_ok; i++) {
                        if (sm_marking[splits[i]] + yield > STATE_ATTRS[splits[i]].buffer_cap)
                            live_ok = false;
                    }
                }
                if (snap_ok && live_ok) {
                    sm_marking[${src}] -= required;
                    for (int i = 0; i < n; i++) sm_marking[splits[i]] += yield;
                }
            }`;
        }

        // AND / OR / XOR — emit a compact inline block
        const inputs  = g.inputs.map(i => i.enumName).join(', ');
        const inNames = g.inputs.map(i => i.name).join(', ');
        const dst     = g.to.enumName;
        return `            /* Gate #${idx}: ${g.type} [${inNames}] → ${g.to.name} */
            {
                state_t ins[] = { ${inputs} };
                int n = (int)(sizeof(ins) / sizeof(ins[0]));
                int chosen = -1;
                int total_yield = 0;
                bool ok = false;

                ${g.type === 'AND' ? `
                /* AND: every input must have enough; all pay; dest gains sum. */
                ok = true;
                for (int i = 0; i < n; i++) {
                    if (sm_snapshot[ins[i]] < STATE_ATTRS[ins[i]].input_cost) { ok = false; break; }
                    total_yield += STATE_ATTRS[ins[i]].output_yield;
                }
                if (ok && sm_snapshot[${dst}] + total_yield > STATE_ATTRS[${dst}].buffer_cap) ok = false;
                ` : g.type === 'OR' ? `
                /* OR: first eligible (in list order) pays. */
                for (int i = 0; i < n; i++) {
                    if (sm_snapshot[ins[i]] >= STATE_ATTRS[ins[i]].input_cost) {
                        int y = STATE_ATTRS[ins[i]].output_yield;
                        if (sm_snapshot[${dst}] + y <= STATE_ATTRS[${dst}].buffer_cap) {
                            chosen = i; total_yield = y; ok = true; break;
                        }
                    }
                }
                ` : `
                /* XOR: exactly one input eligible. */
                int eligible = 0;
                for (int i = 0; i < n; i++) {
                    if (sm_snapshot[ins[i]] >= STATE_ATTRS[ins[i]].input_cost) {
                        chosen = i; eligible++;
                    }
                }
                if (eligible == 1) {
                    int y = STATE_ATTRS[ins[chosen]].output_yield;
                    if (sm_snapshot[${dst}] + y <= STATE_ATTRS[${dst}].buffer_cap) {
                        total_yield = y; ok = true;
                    } else chosen = -1;
                }
                `}

                if (ok) {
                    ${g.type === 'AND' ? `
                    bool live_ok = true;
                    for (int i = 0; i < n; i++) {
                        if (sm_marking[ins[i]] < STATE_ATTRS[ins[i]].input_cost) { live_ok = false; break; }
                    }
                    if (live_ok && sm_marking[${dst}] + total_yield <= STATE_ATTRS[${dst}].buffer_cap) {
                        for (int i = 0; i < n; i++) sm_marking[ins[i]] -= STATE_ATTRS[ins[i]].input_cost;
                        sm_marking[${dst}] += total_yield;
                    }
                    ` : `
                    /* OR / XOR — single chosen input pays. */
                    state_t in = ins[chosen];
                    int cost = STATE_ATTRS[in].input_cost;
                    if (sm_marking[in] >= cost &&
                        sm_marking[${dst}] + total_yield <= STATE_ATTRS[${dst}].buffer_cap) {
                        sm_marking[in]    -= cost;
                        sm_marking[${dst}] += total_yield;
                    }
                    `}
                }
            }`;
    }

    /* ============================================================
       Example main.c — minimal runnable demo
       ============================================================ */

    function _emitExampleMain(ctx) {
        const ir = ctx.ir;

        const handlerStubs = ir.states.map(s =>
            `void ${s.handlerName}(void) {
    /* ${s.name} — fill in your logic. */
    printf("  → handler: ${s.name}\\n");
}`).join('\n\n');

        const stateNames = ir.states.map(s =>
            '    [' + s.enumName + '] = "' + s.name.replace(/"/g, '\\"') + '",'
        ).join('\n');

        const fireSequence = ir.triggers.length
            ? ir.triggers.slice(0, 3).map(t =>
                `    printf("\\nFire ${t.name}:\\n");\n    ${t.fnName}();\n    sm_print();`
              ).join('\n')
            : '    printf("\\n(No triggers defined — nothing to fire.)\\n");';

        return `/* main.c — example driver for ${ir.name}.
   Builds the example wired up with stub handlers that just print
   their name. Replace the bodies with your real logic. */

#include "state_machine.h"
#include <stdio.h>

${emit.section('User-implemented state handlers')}

${handlerStubs}

${emit.section('Helper — pretty-print marking')}

static const char *STATE_NAMES[SM_STATE_COUNT] = {
${stateNames}
};

static void sm_print(void) {
    printf("  Marking: ");
    for (int i = 0; i < SM_STATE_COUNT; i++) {
        printf("%s=%d ", STATE_NAMES[i], sm_tokens_in((state_t)i));
    }
    state_t cs = sm_current_state();
    if (cs == SM_STATE_INVALID) {
        printf("(current: invalid — not singleton)\\n");
    } else {
        printf("(current: %s)\\n", STATE_NAMES[cs]);
        state_fn fn = sm_current_handler();
        if (fn) fn();
    }
}

${emit.section('main')}

int main(void) {
    sm_init();
    printf("Initial:\\n");
    sm_print();

${fireSequence}

    return 0;
}
`;
    }

    /* ============================================================
       TESTS (Unity) — Petri token model
       ============================================================ */

    function _emitTests(ctx) {
        const ir = ctx.ir;
        const start = ir.states.find(s => s.kind === 'start') || ir.states[0];
        const totalInitial = ir.states.reduce((n, s) => n + (s.initialTokens || 0), 0);
        const startInitial = start ? (start.initialTokens || 0) : 0;

        const cases = [];

        cases.push({
            name: 'test_init_seeds_total_tokens',
            body: 'TEST_ASSERT_EQUAL_INT(' + totalInitial + ', sm_total_tokens());' +
                  '   /* sum of every state\'s initial_tokens */'
        });
        if (start) {
            cases.push({
                name: 'test_init_seeds_start_state',
                body: 'TEST_ASSERT_EQUAL_INT(' + startInitial + ', sm_tokens_in(' + start.enumName + '));'
            });
        }
        // Token flow depends on capacities, costs and gates, which are
        // intricate to assert generically — leave a worked scaffold.
        cases.push({
            name: 'test_TODO_token_flow',
            body:
`/* Fire triggers and assert the resulting marking. Net token change for
   a plain transition firing out of state F is (outputYield(F) - inputCost(F)).
   Example:
       sm_fire(TRIG_SOMETHING);
       TEST_ASSERT_EQUAL_INT(<expected>, sm_tokens_in(S_DEST)); */
TEST_ASSERT_EQUAL_INT(${totalInitial}, sm_total_tokens());`
        });

        return gen_tests.unity({
            title: ir.name,
            header: 'state_machine.h',
            stubs: ir.states.map(s => s.handlerName),
            cases
        });
    }

    /* ============================================================
       Makefile + README
       ============================================================ */

    function _emitMakefile(ctx) {
        return `# Makefile — generated by Machine Studio
CC      = gcc
CFLAGS  = -Wall -Wextra -std=c99 -O2
TARGET  = state_machine

# Unity test framework location (folder holding unity.c / unity.h).
# Drop Unity beside these files, or point UNITY_DIR at your checkout's src/.
UNITY_DIR ?= .
UNITY_SRC  = $(UNITY_DIR)/unity.c

$(TARGET): state_machine.c main.c state_machine.h
\t$(CC) $(CFLAGS) -o $@ state_machine.c main.c

run: $(TARGET)
\t./$(TARGET)

# Build + run the Unity test suite (does NOT link main.c).
test: state_machine.c test_state_machine.c $(UNITY_SRC)
\t$(CC) $(CFLAGS) -I$(UNITY_DIR) -o run_tests state_machine.c test_state_machine.c $(UNITY_SRC)
\t./run_tests

clean:
\trm -f $(TARGET) run_tests

.PHONY: run test clean
`;
    }

    function _emitReadme(ctx) {
        const ir = ctx.ir;
        const sanitizeRows = ir.sanitizeMap.map(m =>
            '| ' + m.original.replace(/\|/g, '\\|') + ' | `' + m.generated + '` |'
        ).join('\n') || '| _no entities_ | |';

        const warnings = (ir.warnings && ir.warnings.length)
            ? '\n## ⚠ Warnings during generation\n\n' +
              ir.warnings.map(w => '- ' + w).join('\n') + '\n'
            : '';

        return `# ${ir.name} — Generated C State Machine

Generated by **Machine Studio** on ${ctx.stamp}.
Pattern: **${ctx.opts.pattern}** — ${_patternBlurb(ctx.opts.pattern)}.

## Files

| File | Purpose |
|------|---------|
| \`state_machine.h\` | Public API: state enum, accessors, trigger constants & functions |
| \`state_machine.c\` | Firing engine, state attributes, ${ctx.hasGates ? 'gate logic, ' : ''}two-phase step semantics |
| \`main.c\` | Example driver with stub state handlers |
| \`test_state_machine.c\` | Unity test template (token-seeding checks + scaffold) |
| \`Makefile\` | Build, \`run\` and \`test\` targets |

## Build & run

\`\`\`sh
make
make run
\`\`\`

## Tests (Unity)

\`test_state_machine.c\` is a [Unity](https://github.com/ThrowTheSwitch/Unity)
template. Put \`unity.c\` / \`unity.h\` beside these files (or set \`UNITY_DIR\`),
then run \`make test\`. The generated cases verify \`sm_init()\` seeds the
marking from each state's initial tokens; extend with your own flow checks.

## API at a glance

\`\`\`c
sm_init();                          /* Seed marking from initial_tokens. */
sm_reset();                         /* Same as init. */

int      n  = sm_tokens_in(S_FOO);  /* Petri-net accessor — always works. */
int      t  = sm_total_tokens();
state_t  s  = sm_current_state();   /* FSM accessor — SM_STATE_INVALID if non-singleton. */
state_fn fn = sm_current_handler(); /* Function pointer for current state, or NULL. */

${ir.triggers.length
    ? ir.triggers.slice(0, 4).map(t => t.fnName + '();').join('\n')
    : '/* No triggers defined yet. */'}
sm_fire(${ir.triggers.length ? ir.triggers[0].constName : '/* trigger_id */'});  /* Integer form. */
\`\`\`

## State handlers

Each state declares a handler in \`state_machine.h\` via \`extern\`.
You implement them in your own \`.c\` file (\`main.c\` shows a minimal
example).  The handler is what \`sm_current_handler()\` returns when
the machine is in a singleton marking — call it to run state-specific
logic.

## Petri-net vs FSM semantics

This machine has tokens, not just a "current state". Two accessor
styles are provided:

- **Petri-net** (\`sm_tokens_in\`, \`sm_total_tokens\`) always works
  and reflects the true marking.
- **FSM-style** (\`sm_current_state\`, \`sm_current_handler\`) is a
  convenience for single-token machines and returns \`SM_STATE_INVALID\`
  / \`NULL\` when the marking holds zero or more than one token.

If your machine uses SPLIT or concurrent branches the FSM accessors
will sometimes return invalid — use the Petri-net ones in that case.

## Identifier sanitization

User-facing names from the editor are converted to legal C identifiers:

| Original | Generated |
|----------|-----------|
${sanitizeRows}
${warnings}
## Regeneration

Do not edit the generated files by hand — modify the machine in
Machine Studio and re-export. Your state handler implementations live
in your own file (\`main.c\` here) and are preserved across regenerations.
`;
    }

    /* ─── export ──────────────────────────────────────────────── */

    return {
        id:                 ID,
        name:               NAME,
        supportedPatterns:  SUPPORTED_PATTERNS,
        generate
    };
})();
