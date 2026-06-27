/**
 * generators/c_fsm.js
 * Machine Studio [MS] — C generator for the FSM formalism.
 *
 * Two shapes, chosen by the model:
 *   · No gates → a classic finite-state machine: one current state, a
 *     transition table keyed by (state, trigger), a per-state entry
 *     hook. 'table' and 'switch' dispatch.
 *   · With gates → a binary-marking step engine (a 1-safe Petri net):
 *     each state is active/inactive, gates (AND/OR/XOR/SPLIT/NOT) block
 *     their target until their inputs are satisfied, and a trigger runs
 *     one snapshot/apply step. Several states can be active at once.
 *
 * Public API in state_machine.h:
 *   sm_init / sm_reset / sm_current_state / sm_state_name /
 *   sm_is_final / sm_fire(id) / fire_<trigger>()
 *   (+ sm_is_active / sm_active_count in the gated build).
 *
 * Files: state_machine.h, state_machine.c, main.c,
 *        test_state_machine.c (Unity), Makefile, README.md
 *
 * c_lang.generate() delegates here when ir.mode === 'FSM'.
 *
 * Depends on: emit.js, gen_tests.js (IR shape from walker.js)
 */

const c_fsm = (() => {

    const SUPPORTED_PATTERNS = ['table', 'switch'];

    function generate(ir, opts) {
        if (ir.states.length === 0) {
            return { ok: false, error: 'Machine has no states — nothing to generate.' };
        }
        const pattern = SUPPORTED_PATTERNS.includes(opts.pattern) ? opts.pattern : 'table';
        const ctx = _ctx(ir);

        // A gated FSM uses the binary step engine; a plain FSM keeps the
        // idiomatic single-state transition table.
        const source = ctx.gated ? _emitSourceGated(ctx) : _emitSource(ctx, pattern);
        const header = ctx.gated ? _emitHeaderGated(ctx) : _emitHeader(ctx);
        const main   = ctx.gated ? _emitMainGated(ctx)   : _emitMain(ctx);
        const tests  = ctx.gated ? _emitTestsGated(ctx)  : _emitTests(ctx);
        const readme = ctx.gated ? _emitReadmeGated(ctx) : _emitReadme(ctx, pattern);

        const files = [
            { name: 'state_machine.h', content: header },
            { name: 'state_machine.c', content: source },
            { name: 'main.c',          content: main },
            { name: 'test_state_machine.c', content: tests },
            { name: 'Makefile',        content: _emitMakefile(ctx) },
            { name: 'README.md',       content: readme }
        ];
        return { ok: true, files, previewFile: 'state_machine.c', warnings: ir.warnings || [] };
    }

    /* ── context ──────────────────────────────────────────────────── */

    function _ctx(ir) {
        const start = ir.states.find(s => s.kind === 'start') || ir.states[0];
        const finals = ir.states.filter(s => s.kind === 'end');
        // Only triggered transitions can fire in an FSM.
        const fireable = ir.transitions.filter(t => t.trigger);
        const dropped  = ir.transitions.length - fireable.length;
        return {
            ir, start, finals, fireable, dropped,
            gated: ir.gates.length > 0,
            stamp: new Date().toISOString().slice(0, 10)
        };
    }

    /* ── header ───────────────────────────────────────────────────── */

    function _emitHeader(ctx) {
        const ir = ctx.ir;

        const stateEnum = ir.states
            .map(s => '    ' + emit.pad(s.enumName + ',', 28) + '/* ' + s.name + ' */')
            .join('\n');

        const triggerConsts = ir.triggers.length
            ? ir.triggers.map((t, i) =>
                '#define ' + emit.pad(t.constName, 28) + ' ' + i +
                '   /* ' + t.name + (t.kind === 'timer' ? ' (timer)' : '') + ' */'
              ).join('\n')
            : '/* No triggers defined — sm_fire() is always a no-op. */';

        const entryExterns = ir.states
            .map(s => 'extern void ' + s.handlerName + '(void);   /* on entering ' + s.name + ' */')
            .join('\n');

        const triggerFnDecls = ir.triggers.length
            ? ir.triggers.map(t => 'int ' + t.fnName + '(void);').join('\n')
            : '/* No per-trigger helpers: no triggers were defined. */';

        const body =
`#include <stddef.h>

/* ── States ─────────────────────────────────────────────────────── */
typedef enum {
${stateEnum}
    SM_STATE_COUNT
} sm_state_t;

/* ── Trigger ids ────────────────────────────────────────────────── */
${triggerConsts}

/* ── Per-state entry hooks ──────────────────────────────────────────
   Called once each time the machine ENTERS the state (including the
   initial sm_init). Implement these in your own .c file. */
${entryExterns}

/* ── Public API ─────────────────────────────────────────────────── */
void        sm_init(void);              /* enter the start state */
void        sm_reset(void);             /* alias for sm_init */
sm_state_t  sm_current_state(void);     /* the single active state */
const char* sm_state_name(sm_state_t s);
int         sm_is_final(void);          /* 1 if the current state is an end state */

/* Fire a trigger by id. Returns 1 if a transition fired, 0 if the
   trigger is not wired out of the current state (a harmless no-op). */
int         sm_fire(int trigger_id);

/* Per-trigger helpers — each forwards to sm_fire(). */
${triggerFnDecls}`;

        return emit.banner('state_machine.h  —  ' + ir.name, [
            'Finite-state machine (FSM) — generated by Machine Studio.',
            'Exactly one state is active at a time; sm_fire() moves it.',
            'Generated ' + ctx.stamp + '.'
        ]) + '\n' +
        emit.headerGuard('STATE_MACHINE_H', body);
    }

    /* ── source ───────────────────────────────────────────────────── */

    function _emitSource(ctx, pattern) {
        const ir = ctx.ir;

        const names = ir.states
            .map(s => '    ' + emit.pad('"' + _esc(s.name) + '",', 30) + '/* ' + s.enumName + ' */')
            .join('\n');

        const enterCases = ir.states
            .map(s => '        case ' + s.enumName + ': ' + s.handlerName + '(); break;')
            .join('\n');

        const finalCases = ctx.finals.length
            ? ctx.finals.map(s => '        case ' + s.enumName + ': return 1;').join('\n')
            : '        /* no end states defined */';

        const dispatch = pattern === 'switch'
            ? _emitSwitchDispatch(ctx)
            : _emitTableDispatch(ctx);

        const triggerFns = ir.triggers.length
            ? ir.triggers.map(t =>
                'int ' + emit.pad(t.fnName + '(void)', 30) + ' { return sm_fire(' + t.constName + '); }'
              ).join('\n')
            : '/* No per-trigger helpers. */';

        return emit.banner('state_machine.c  —  ' + ir.name, [
            'FSM implementation (' + pattern + ' dispatch). Generated by Machine Studio.',
            'Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.h"

static const char* const SM_STATE_NAMES[SM_STATE_COUNT] = {
${names}
};

static const sm_state_t SM_START_STATE = ${ctx.start.enumName};

static sm_state_t g_state;

/* Call the entry hook for a state. */
static void sm_enter(sm_state_t s) {
    switch (s) {
${enterCases}
        default: break;
    }
}

void sm_init(void)  { g_state = SM_START_STATE; sm_enter(g_state); }
void sm_reset(void) { sm_init(); }

sm_state_t sm_current_state(void) { return g_state; }

const char* sm_state_name(sm_state_t s) {
    return (s >= 0 && s < SM_STATE_COUNT) ? SM_STATE_NAMES[s] : "(invalid)";
}

int sm_is_final(void) {
    switch (g_state) {
${finalCases}
        default: return 0;
    }
}

${dispatch}

${triggerFns}
`;
    }

    function _emitTableDispatch(ctx) {
        const rows = ctx.fireable.length
            ? ctx.fireable.map(t =>
                '    { ' + emit.pad(t.from.enumName + ',', 24) +
                emit.pad(t.trigger.constName + ',', 24) + t.to.enumName + ' },' +
                '   /* ' + t.from.name + ' --' + t.trigger.name + '--> ' + t.to.name + ' */'
              ).join('\n')
            : '    /* no triggered transitions */';

        return `/* ── Transition table ───────────────────────────────────────────── */
typedef struct { sm_state_t from; int trigger; sm_state_t to; } sm_transition_t;

static const sm_transition_t SM_TRANSITIONS[] = {
${rows}
};
static const int SM_TRANSITION_COUNT =
    (int)(sizeof(SM_TRANSITIONS) / sizeof(SM_TRANSITIONS[0]));

int sm_fire(int trigger_id) {
    int i;
    for (i = 0; i < SM_TRANSITION_COUNT; i++) {
        if (SM_TRANSITIONS[i].from == g_state &&
            SM_TRANSITIONS[i].trigger == trigger_id) {
            g_state = SM_TRANSITIONS[i].to;
            sm_enter(g_state);
            return 1;
        }
    }
    return 0;   /* trigger not valid from the current state */
}`;
    }

    function _emitSwitchDispatch(ctx) {
        // Group fireable transitions by source state.
        const byFrom = new Map();
        ctx.fireable.forEach(t => {
            if (!byFrom.has(t.from.enumName)) byFrom.set(t.from.enumName, []);
            byFrom.get(t.from.enumName).push(t);
        });

        let cases = '';
        byFrom.forEach((list, fromEnum) => {
            const inner = list.map(t =>
                '            case ' + t.trigger.constName + ': g_state = ' + t.to.enumName +
                '; sm_enter(g_state); return 1;   /* → ' + t.to.name + ' */'
            ).join('\n');
            cases +=
`        case ${fromEnum}:
            switch (trigger_id) {
${inner}
                default: break;
            }
            break;
`;
        });
        if (!cases) cases = '        /* no triggered transitions */\n';

        return `int sm_fire(int trigger_id) {
    switch (g_state) {
${cases}        default: break;
    }
    return 0;   /* trigger not valid from the current state */
}`;
    }

    /* ── demo main ────────────────────────────────────────────────── */

    function _emitMain(ctx) {
        const ir = ctx.ir;

        const handlerDefs = ir.states.map(s =>
            'void ' + s.handlerName + '(void) { printf("  entered %s\\n", "' + _esc(s.name) + '"); }'
        ).join('\n');

        const fireSeq = ir.triggers.length
            ? ir.triggers.map(t =>
`    printf("fire %-14s : ", "${_esc(t.name)}");
    ${t.fnName}();
    printf("now in %s\\n", sm_state_name(sm_current_state()));`
              ).join('\n')
            : '    printf("(no triggers to fire)\\n");';

        return emit.banner('main.c  —  ' + ir.name + ' demo', [
            'Runnable smoke demo with printing entry handlers.',
            'Build: make demo   (or see README.md). Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.h"
#include <stdio.h>

/* Demo entry handlers (replace with your own logic). */
${handlerDefs}

int main(void) {
    sm_init();
    printf("start state: %s\\n", sm_state_name(sm_current_state()));
    printf("---- firing every trigger once ----\\n");
${fireSeq}
    printf("final? %s\\n", sm_is_final() ? "yes" : "no");
    return 0;
}
`;
    }

    /* ── Unity tests ──────────────────────────────────────────────── */

    function _emitTests(ctx) {
        const ir = ctx.ir;
        const cases = [];

        cases.push({
            name: 'test_starts_in_start_state',
            body: 'TEST_ASSERT_EQUAL_INT(' + ctx.start.enumName + ', sm_current_state());'
        });

        // First triggered transition out of the start state → deterministic move.
        const fromStart = ctx.fireable.find(t => t.from.enumName === ctx.start.enumName);
        if (fromStart) {
            cases.push({
                name: 'test_fire_from_start_moves_state',
                body:
`int moved = sm_fire(${fromStart.trigger.constName});
TEST_ASSERT_EQUAL_INT(1, moved);   /* a transition fired */
TEST_ASSERT_EQUAL_INT(${fromStart.to.enumName}, sm_current_state());`
            });
        }

        cases.push({
            name: 'test_unknown_trigger_is_ignored',
            body:
`int moved = sm_fire(9999);   /* not a real trigger id */
TEST_ASSERT_EQUAL_INT(0, moved);
TEST_ASSERT_EQUAL_INT(${ctx.start.enumName}, sm_current_state());   /* unchanged */`
        });

        // TODO scaffold so the user sees where to extend.
        cases.push({
            name: 'test_TODO_add_your_own',
            body:
`/* Drive the machine through a scenario and assert the resulting state.
   Example:
       sm_fire(TRIG_SOMETHING);
       sm_fire(TRIG_SOMETHING_ELSE);
       TEST_ASSERT_EQUAL_INT(S_EXPECTED, sm_current_state()); */
TEST_ASSERT_TRUE(1);`
        });

        return gen_tests.unity({
            title: ir.name,
            header: 'state_machine.h',
            stubs: ir.states.map(s => s.handlerName),
            cases
        });
    }

    /* ── Makefile ─────────────────────────────────────────────────── */

    function _emitMakefile(ctx) {
        return `# Makefile — ${ctx.ir.name} (FSM)
# Generated by Machine Studio ${ctx.stamp}.

CC      ?= cc
CFLAGS  ?= -std=c11 -Wall -Wextra -O2

SRC      = state_machine.c
DEMO     = main.c
TESTSRC  = test_state_machine.c

# Unity lives wherever you put it. Point UNITY_DIR at the folder that
# holds unity.c / unity.h (e.g. a Unity checkout's src/), or drop those
# files next to this Makefile (the default '.').
UNITY_DIR ?= .
UNITY_SRC  = $(UNITY_DIR)/unity.c

all: demo

demo: $(SRC) $(DEMO)
	$(CC) $(CFLAGS) -o demo $(SRC) $(DEMO)

# Build + run the Unity test suite.
test: $(SRC) $(TESTSRC) $(UNITY_SRC)
	$(CC) $(CFLAGS) -I$(UNITY_DIR) -o run_tests $(SRC) $(TESTSRC) $(UNITY_SRC)
	./run_tests

clean:
	rm -f demo run_tests

.PHONY: all test clean
`;
    }

    /* ── README ───────────────────────────────────────────────────── */

    function _emitReadme(ctx, pattern) {
        const ir = ctx.ir;
        const triggerList = ir.triggers.length
            ? ir.triggers.map(t => '- `' + t.constName + '` / `' + t.fnName + '()` — ' + t.name +
                                    (t.kind === 'timer' ? ' _(timer in the editor)_' : '')).join('\n')
            : '_None._';
        const droppedNote = ctx.dropped > 0
            ? '\n> ⚠️ ' + ctx.dropped + ' transition(s) without a trigger were omitted — ' +
              'an FSM transition needs a trigger to fire.\n'
            : '';

        return `# ${ir.name} — Finite-State Machine (C)

Generated by **Machine Studio** ${ctx.stamp} · \`${pattern}\` dispatch.

Exactly one state is active at a time. \`sm_fire(trigger_id)\` looks up the
transition for *(current state, trigger)* and, if one exists, moves to the
target state and calls its entry hook. Unknown triggers are ignored.
${droppedNote}
## API (\`state_machine.h\`)

| Function | Purpose |
|---|---|
| \`sm_init()\` / \`sm_reset()\` | Enter the start state (\`${ctx.start.enumName}\`). |
| \`sm_current_state()\` | The active \`sm_state_t\`. |
| \`sm_state_name(s)\` | Human-readable name. |
| \`sm_is_final()\` | 1 if the current state is an end state. |
| \`sm_fire(id)\` | Fire a trigger; returns 1 if it moved, 0 if ignored. |
| \`fire_<name>()\` | Per-trigger convenience wrappers. |

You implement the per-state entry hooks (\`extern void state_*(void)\`); they
fire whenever the machine enters that state.

### Triggers
${triggerList}

## Build & run

\`\`\`sh
make demo      # builds ./demo from state_machine.c + main.c
./demo
\`\`\`

## Tests (Unity)

\`test_state_machine.c\` is a [Unity](https://github.com/ThrowTheSwitch/Unity)
template. Put \`unity.c\` / \`unity.h\` beside these files (or set \`UNITY_DIR\`),
then:

\`\`\`sh
make test      # compiles state_machine.c + test_state_machine.c + unity.c
\`\`\`

The generated cases cover the start state, the first transition out of it,
and that unknown triggers are ignored — extend with your own scenarios.
`;
    }

    /* ════════════════════════════════════════════════════════════════
       GATED FSM — binary-marking step engine (a 1-safe Petri net).
       Used when the model has gates. Each state is active/inactive; a
       trigger runs one snapshot/classify/apply step over its
       transitions and gates. AND/OR/XOR/SPLIT/NOT all supported.
       ════════════════════════════════════════════════════════════════ */

    function _emitHeaderGated(ctx) {
        const ir = ctx.ir;

        const stateEnum = ir.states
            .map(s => '    ' + emit.pad(s.enumName + ',', 28) + '/* ' + s.name + ' */')
            .join('\n');
        const triggerConsts = ir.triggers.length
            ? ir.triggers.map((t, i) =>
                '#define ' + emit.pad(t.constName, 28) + ' ' + i +
                '   /* ' + t.name + (t.kind === 'timer' ? ' (timer)' : '') + ' */'
              ).join('\n')
            : '/* No triggers defined — sm_fire() is always a no-op. */';
        const entryExterns = ir.states
            .map(s => 'extern void ' + s.handlerName + '(void);   /* on entering ' + s.name + ' */')
            .join('\n');
        const triggerFnDecls = ir.triggers.length
            ? ir.triggers.map(t => 'int ' + t.fnName + '(void);').join('\n')
            : '/* No per-trigger helpers: no triggers were defined. */';

        const body =
`#include <stddef.h>

/* ── States ─────────────────────────────────────────────────────── */
typedef enum {
${stateEnum}
    SM_STATE_COUNT
} sm_state_t;

/* ── Trigger ids ────────────────────────────────────────────────── */
${triggerConsts}

/* ── Per-state entry hooks ──────────────────────────────────────────
   Called once each time a state becomes active (including sm_init).
   Implement these in your own .c file. */
${entryExterns}

/* ── Public API ─────────────────────────────────────────────────────
   This machine has gates, so more than one state can be active at
   once. The marking is a set of active states; query it with
   sm_is_active(). sm_current_state() returns the first active state
   (or SM_STATE_COUNT if none) for callers that expect a single one. */
void        sm_init(void);              /* clear, then activate the start state */
void        sm_reset(void);             /* alias for sm_init */
int         sm_is_active(sm_state_t s); /* 1 if state s is currently active */
int         sm_active_count(void);      /* number of active states */
sm_state_t  sm_current_state(void);     /* first active state, or SM_STATE_COUNT */
const char* sm_state_name(sm_state_t s);
int         sm_is_final(void);          /* 1 if any active state is an end state */

/* Fire a trigger by id. Runs one step. Returns 1 if the active set
   changed, 0 otherwise. */
int         sm_fire(int trigger_id);

/* Per-trigger helpers — each forwards to sm_fire(). */
${triggerFnDecls}`;

        return emit.banner('state_machine.h  —  ' + ir.name, [
            'Finite-state machine with gates — generated by Machine Studio.',
            'Binary markers: gates block transitions; many states may be active.',
            'Generated ' + ctx.stamp + '.'
        ]) + '\n' +
        emit.headerGuard('STATE_MACHINE_H', body);
    }

    function _emitSourceGated(ctx) {
        const ir = ctx.ir;

        const names = ir.states
            .map(s => '    ' + emit.pad('"' + _esc(s.name) + '",', 30) + '/* ' + s.enumName + ' */')
            .join('\n');
        const enterCases = ir.states
            .map(s => '        case ' + s.enumName + ': ' + s.handlerName + '(); break;')
            .join('\n');
        const finalCases = ctx.finals.length
            ? ctx.finals.map(s => '        case ' + s.enumName + ': return 1;').join('\n')
            : '        /* no end states defined */';

        // Transition table (only triggered transitions can fire).
        const hasTrans = ctx.fireable.length > 0;
        const transTable = hasTrans ? `
/* ── Transition table ───────────────────────────────────────────── */
typedef struct { sm_state_t from; int trigger; sm_state_t to; } sm_transition_t;

static const sm_transition_t SM_TRANSITIONS[] = {
${ctx.fireable.map(t =>
    '    { ' + emit.pad(t.from.enumName + ',', 24) +
    emit.pad(t.trigger.constName + ',', 24) + t.to.enumName + ' },' +
    '   /* ' + t.from.name + ' --' + t.trigger.name + '--> ' + t.to.name + ' */'
).join('\n')}
};
#define SM_TRANSITION_COUNT ((int)(sizeof(SM_TRANSITIONS) / sizeof(SM_TRANSITIONS[0])))

static int sm_transition_enabled(const sm_transition_t *t, const int *m) {
    return m[t->from] ? 1 : 0;
}
static void sm_transition_apply(const sm_transition_t *t) {
    if (!sm_active[t->from]) return;
    if (t->from != t->to) sm_active[t->from] = 0;
    sm_active[t->to] = 1;
}
` : '';

        // Gates table sizing.
        let maxIn = 1, maxOut = 1;
        ir.gates.forEach(g => {
            if (g.type === 'SPLIT') { if (g.outputs.length > maxOut) maxOut = g.outputs.length; }
            else if (g.type === 'NOT') { /* single input */ }
            else { if (g.inputs.length > maxIn) maxIn = g.inputs.length; }
        });
        const gateRows = ir.gates.map(g => {
            const trg = g.trigger ? g.trigger.constName : '-1';
            let ins, outs, to, ic, oc;
            if (g.type === 'SPLIT') {
                ins = '{ ' + g.source.enumName + ' }';
                outs = '{ ' + g.outputs.map(o => o.enumName).join(', ') + ' }';
                to = '0'; ic = 1; oc = g.outputs.length;
            } else if (g.type === 'NOT') {
                ins = '{ ' + g.guard.enumName + ' }';
                outs = '{ 0 }'; to = g.to.enumName; ic = 1; oc = 0;
            } else {
                ins = '{ ' + g.inputs.map(i => i.enumName).join(', ') + ' }';
                outs = '{ 0 }'; to = g.to.enumName; ic = g.inputs.length; oc = 0;
            }
            const label = g.type === 'SPLIT'
                ? 'SPLIT ' + g.source.name + ' → [' + g.outputs.map(o => o.name).join(', ') + ']'
                : g.type === 'NOT'
                ? 'NOT !' + g.guard.name + ' → ' + g.to.name
                : g.type + ' [' + g.inputs.map(i => i.name).join(', ') + '] → ' + g.to.name;
            return '    { .trigger = ' + trg + ', .type = SM_GATE_' + g.type + ', ' +
                   '.input_count = ' + ic + ', .inputs = ' + ins + ', ' +
                   '.output_count = ' + oc + ', .outputs = ' + outs + ', ' +
                   '.to = ' + to + ' },   /* ' + label + ' */';
        }).join('\n');

        const tClassify = hasTrans ? `
    int t_en[SM_TRANSITION_COUNT];
    for (i = 0; i < SM_TRANSITION_COUNT; i++) {
        t_en[i] = (SM_TRANSITIONS[i].trigger == trigger_id) &&
                  sm_transition_enabled(&SM_TRANSITIONS[i], sm_snapshot);
    }` : '';
        const tApply = hasTrans ? `
    for (i = 0; i < SM_TRANSITION_COUNT; i++) {
        if (t_en[i]) sm_transition_apply(&SM_TRANSITIONS[i]);
    }` : '';

        return emit.banner('state_machine.c  —  ' + ir.name, [
            'FSM with gates — binary-marking step engine. Generated by Machine Studio.',
            'Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.h"
#include <string.h>

static const char* const SM_STATE_NAMES[SM_STATE_COUNT] = {
${names}
};

static const sm_state_t SM_START_STATE = ${ctx.start.enumName};

/* Active set (1 = active) + a per-step snapshot. */
static int sm_active[SM_STATE_COUNT];
static int sm_snapshot[SM_STATE_COUNT];
${transTable}
/* ── Gates table ────────────────────────────────────────────────── */
typedef enum {
    SM_GATE_AND, SM_GATE_OR, SM_GATE_XOR, SM_GATE_SPLIT, SM_GATE_NOT
} sm_gate_type_t;

#define SM_MAX_GATE_INPUTS  ${maxIn}
#define SM_MAX_GATE_OUTPUTS ${maxOut}

typedef struct {
    int            trigger;
    sm_gate_type_t type;
    int            input_count;
    sm_state_t     inputs[SM_MAX_GATE_INPUTS];
    int            output_count;
    sm_state_t     outputs[SM_MAX_GATE_OUTPUTS];
    sm_state_t     to;
} sm_gate_t;

static const sm_gate_t SM_GATES[] = {
${gateRows}
};
#define SM_GATE_COUNT ((int)(sizeof(SM_GATES) / sizeof(SM_GATES[0])))

/* Classify a gate against the snapshot. For OR/XOR the paying input
   index is written to *chosen so apply charges the same one. */
static int sm_gate_enabled(const sm_gate_t *g, const int *m, int *chosen) {
    int i;
    *chosen = -1;
    switch (g->type) {
        case SM_GATE_AND:
            for (i = 0; i < g->input_count; i++) if (!m[g->inputs[i]]) return 0;
            return 1;
        case SM_GATE_OR:
            for (i = 0; i < g->input_count; i++) if (m[g->inputs[i]]) { *chosen = i; return 1; }
            return 0;
        case SM_GATE_XOR: {
            int c = -1, n = 0;
            for (i = 0; i < g->input_count; i++) if (m[g->inputs[i]]) { c = i; n++; }
            if (n == 1) { *chosen = c; return 1; }
            return 0;
        }
        case SM_GATE_SPLIT:
            return m[g->inputs[0]] ? 1 : 0;
        case SM_GATE_NOT:
            return m[g->inputs[0]] ? 0 : 1;   /* inhibitor: enabled while guard inactive */
    }
    return 0;
}

/* Apply a gate against the live set; re-checks live state so a
   conflicting earlier firing in the same step is skipped safely. */
static void sm_gate_apply(const sm_gate_t *g, int chosen) {
    int i;
    switch (g->type) {
        case SM_GATE_AND:
            for (i = 0; i < g->input_count; i++) if (!sm_active[g->inputs[i]]) return;
            for (i = 0; i < g->input_count; i++) sm_active[g->inputs[i]] = 0;
            sm_active[g->to] = 1;
            break;
        case SM_GATE_OR:
        case SM_GATE_XOR:
            if (chosen < 0 || !sm_active[g->inputs[chosen]]) return;
            sm_active[g->inputs[chosen]] = 0;
            sm_active[g->to] = 1;
            break;
        case SM_GATE_SPLIT:
            if (!sm_active[g->inputs[0]]) return;
            sm_active[g->inputs[0]] = 0;
            for (i = 0; i < g->output_count; i++) sm_active[g->outputs[i]] = 1;
            break;
        case SM_GATE_NOT:
            if (sm_active[g->inputs[0]]) return;   /* guard reappeared */
            sm_active[g->to] = 1;
            break;
    }
}

/* ── Lifecycle ──────────────────────────────────────────────────── */

static void sm_enter(sm_state_t s) {
    switch (s) {
${enterCases}
        default: break;
    }
}

void sm_init(void) {
    int i;
    for (i = 0; i < SM_STATE_COUNT; i++) sm_active[i] = 0;
    sm_active[SM_START_STATE] = 1;
    sm_enter(SM_START_STATE);
}
void sm_reset(void) { sm_init(); }

int sm_is_active(sm_state_t s) {
    return ((int)s >= 0 && s < SM_STATE_COUNT) ? sm_active[s] : 0;
}

int sm_active_count(void) {
    int i, n = 0;
    for (i = 0; i < SM_STATE_COUNT; i++) n += sm_active[i];
    return n;
}

sm_state_t sm_current_state(void) {
    int i;
    for (i = 0; i < SM_STATE_COUNT; i++) if (sm_active[i]) return (sm_state_t)i;
    return SM_STATE_COUNT;
}

const char* sm_state_name(sm_state_t s) {
    return ((int)s >= 0 && s < SM_STATE_COUNT) ? SM_STATE_NAMES[s] : "(invalid)";
}

int sm_is_final(void) {
    int i;
    for (i = 0; i < SM_STATE_COUNT; i++) {
        if (!sm_active[i]) continue;
        switch ((sm_state_t)i) {
${finalCases}
            default: break;
        }
    }
    return 0;
}

/* ── Trigger dispatch — one snapshot/apply step ─────────────────────
   Classify every transition/gate on this trigger against the snapshot
   (so a marker arriving at a state cannot leave again in the same
   step), then apply the enabled set against the live marking. */
int sm_fire(int trigger_id) {
    int i, changed = 0;
    memcpy(sm_snapshot, sm_active, sizeof(sm_active));
${tClassify}
    int g_en[SM_GATE_COUNT];
    int g_ch[SM_GATE_COUNT];
    for (i = 0; i < SM_GATE_COUNT; i++) {
        g_en[i] = 0; g_ch[i] = -1;
        if (SM_GATES[i].trigger != trigger_id) continue;
        g_en[i] = sm_gate_enabled(&SM_GATES[i], sm_snapshot, &g_ch[i]);
    }
${tApply}
    for (i = 0; i < SM_GATE_COUNT; i++) {
        if (g_en[i]) sm_gate_apply(&SM_GATES[i], g_ch[i]);
    }

    for (i = 0; i < SM_STATE_COUNT; i++) {
        if (!sm_snapshot[i] && sm_active[i]) sm_enter((sm_state_t)i);
        if (sm_snapshot[i] != sm_active[i]) changed = 1;
    }
    return changed;
}

/* ── Per-trigger wrappers ───────────────────────────────────────── */

${ir.triggers.length
    ? ir.triggers.map(t => 'int ' + emit.pad(t.fnName + '(void)', 30) + ' { return sm_fire(' + t.constName + '); }').join('\n')
    : '/* No per-trigger helpers. */'}
`;
    }

    function _emitMainGated(ctx) {
        const ir = ctx.ir;
        const handlerDefs = ir.states.map(s =>
            'void ' + s.handlerName + '(void) { printf("  entered %s\\n", "' + _esc(s.name) + '"); }'
        ).join('\n');
        const fireSeq = ir.triggers.length
            ? ir.triggers.map(t =>
`    printf("fire %-14s :\\n", "${_esc(t.name)}");
    ${t.fnName}();
    dump_active();`
              ).join('\n')
            : '    printf("(no triggers to fire)\\n");';

        return emit.banner('main.c  —  ' + ir.name + ' demo', [
            'Runnable smoke demo with printing entry handlers.',
            'Build: make demo   (or see README.md). Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.h"
#include <stdio.h>

/* Demo entry handlers (replace with your own logic). */
${handlerDefs}

static void dump_active(void) {
    int i, first = 1;
    printf("  active: ");
    for (i = 0; i < SM_STATE_COUNT; i++) {
        if (sm_is_active((sm_state_t)i)) {
            printf("%s%s", first ? "" : ", ", sm_state_name((sm_state_t)i));
            first = 0;
        }
    }
    printf("%s\\n", first ? "(none)" : "");
}

int main(void) {
    sm_init();
    printf("start:\\n");
    dump_active();
    printf("---- firing every trigger once ----\\n");
${fireSeq}
    printf("final? %s\\n", sm_is_final() ? "yes" : "no");
    return 0;
}
`;
    }

    function _emitTestsGated(ctx) {
        const ir = ctx.ir;
        const cases = [];

        cases.push({
            name: 'test_starts_with_start_active',
            body: 'TEST_ASSERT_EQUAL_INT(1, sm_is_active(' + ctx.start.enumName + '));'
        });

        cases.push({
            name: 'test_unknown_trigger_changes_nothing',
            body:
`int before = sm_active_count();
int moved  = sm_fire(9999);   /* not a real trigger id */
TEST_ASSERT_EQUAL_INT(0, moved);
TEST_ASSERT_EQUAL_INT(before, sm_active_count());`
        });

        cases.push({
            name: 'test_TODO_add_your_own',
            body:
`/* Drive the machine through a scenario and assert the active set.
   Example:
       sm_fire(TRIG_SOMETHING);
       TEST_ASSERT_EQUAL_INT(1, sm_is_active(S_EXPECTED)); */
TEST_ASSERT_TRUE(1);`
        });

        return gen_tests.unity({
            title: ir.name,
            header: 'state_machine.h',
            stubs: ir.states.map(s => s.handlerName),
            cases
        });
    }

    function _emitReadmeGated(ctx) {
        const ir = ctx.ir;
        const triggerList = ir.triggers.length
            ? ir.triggers.map(t => '- `' + t.constName + '` / `' + t.fnName + '()` — ' + t.name +
                                    (t.kind === 'timer' ? ' _(timer in the editor)_' : '')).join('\n')
            : '_None._';
        const gateList = ir.gates.map(g => {
            if (g.type === 'SPLIT') return '- **SPLIT** `' + g.source.name + '` → ' + g.outputs.map(o => '`' + o.name + '`').join(', ');
            if (g.type === 'NOT')   return '- **NOT** target `' + g.to.name + '` blocked while `' + g.guard.name + '` is active';
            return '- **' + g.type + '** ' + g.inputs.map(i => '`' + i.name + '`').join(', ') + ' → `' + g.to.name + '`';
        }).join('\n');
        const droppedNote = ctx.dropped > 0
            ? '\n> ⚠️ ' + ctx.dropped + ' transition(s) without a trigger were omitted — ' +
              'a transition needs a trigger to fire.\n'
            : '';

        return `# ${ir.name} — Finite-State Machine with gates (C)

Generated by **Machine Studio** ${ctx.stamp}.

This machine has gates, so it runs as a **binary-marking step engine**: each
state is active or inactive, and firing a trigger runs one atomic step. Because
a SPLIT can expose several states and an AND join waits on all of its inputs,
**more than one state can be active at once**.
${droppedNote}
## Gates

${gateList}

A gate blocks its target until its inputs are satisfied: **AND** needs every
input active, **OR** any input, **XOR** exactly one, **SPLIT** exposes all its
destinations from one source, and **NOT** is an inhibitor — its target is
reachable only while the guard state is inactive.

## API (\`state_machine.h\`)

| Function | Purpose |
|---|---|
| \`sm_init()\` / \`sm_reset()\` | Clear, then activate the start state (\`${ctx.start.enumName}\`). |
| \`sm_is_active(s)\` | 1 if state \`s\` is active. |
| \`sm_active_count()\` | How many states are active. |
| \`sm_current_state()\` | First active state (or \`SM_STATE_COUNT\`). |
| \`sm_is_final()\` | 1 if any active state is an end state. |
| \`sm_fire(id)\` | Run one step; returns 1 if the active set changed. |
| \`fire_<name>()\` | Per-trigger convenience wrappers. |

You implement the per-state entry hooks (\`extern void state_*(void)\`); they
fire whenever a state becomes active.

### Triggers
${triggerList}

## Build & run

\`\`\`sh
make demo && ./demo
\`\`\`

## Tests (Unity)

\`test_state_machine.c\` is a [Unity](https://github.com/ThrowTheSwitch/Unity)
template. Put \`unity.c\` / \`unity.h\` beside these files (or set \`UNITY_DIR\`),
then \`make test\`.
`;
    }

    /* ── util ─────────────────────────────────────────────────────── */
    function _esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

    return { generate, SUPPORTED_PATTERNS };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { c_fsm };
}
