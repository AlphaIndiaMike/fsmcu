/**
 * generators/cpp_fsm.js
 * Machine Studio [MS] — C++ generator for the FSM formalism.
 *
 * Two shapes, chosen by the model:
 *   · No gates → a classic finite-state machine behind a single
 *     `StateMachine` class: one current state, transitions keyed by
 *     (state, trigger), a virtual onEnter(State) hook. 'table',
 *     'switch' and 'oop' dispatch.
 *   · With gates → a binary-marking step engine (a 1-safe Petri net):
 *     each state is active/inactive, gates (AND/OR/XOR/SPLIT/NOT) block
 *     their target until their inputs are satisfied, and fire() runs one
 *     snapshot/apply step. Several states can be active at once.
 *
 * Files: state_machine.hpp, state_machine.cpp, main.cpp,
 *        test_state_machine.cpp (GoogleTest), Makefile, README.md
 *
 * cpp_lang.generate() delegates here when ir.mode === 'FSM'.
 *
 * Depends on: sanitize.js, emit.js, gen_tests.js (IR shape from walker.js)
 */

const cpp_fsm = (() => {

    const SUPPORTED_PATTERNS = ['table', 'switch', 'oop'];

    function generate(ir, opts) {
        if (ir.states.length === 0) {
            return { ok: false, error: 'Machine has no states — nothing to generate.' };
        }
        const pattern = SUPPORTED_PATTERNS.includes(opts.pattern) ? opts.pattern : 'table';
        const ctx = _ctx(ir);

        const header = ctx.gated ? _emitHeaderGated(ctx) : _emitHeader(ctx);
        const source = ctx.gated ? _emitSourceGated(ctx) : _emitSource(ctx, pattern);
        const main   = ctx.gated ? _emitMainGated(ctx)   : _emitMain(ctx);
        const tests  = ctx.gated ? _emitTestsGated(ctx)  : _emitTests(ctx);
        const readme = ctx.gated ? _emitReadmeGated(ctx) : _emitReadme(ctx, pattern);

        const files = [
            { name: 'state_machine.hpp', content: header },
            { name: 'state_machine.cpp', content: source },
            { name: 'main.cpp',          content: main },
            { name: 'test_state_machine.cpp', content: tests },
            { name: 'Makefile',          content: _emitMakefile(ctx) },
            { name: 'README.md',         content: readme }
        ];
        return { ok: true, files, previewFile: 'state_machine.cpp', warnings: ir.warnings || [] };
    }

    /* ── context + C++ PascalCase names ───────────────────────────── */

    function _toPascal(words) {
        return words.filter(p => p.length > 0)
                    .map(p => p[0].toUpperCase() + p.slice(1).toLowerCase())
                    .join('');
    }

    function _ctx(ir) {
        const usedState   = new Set(['Count']);
        const usedTrigger = new Set();

        const states = ir.states.map(s => {
            let parts = s.enumName.split('_').filter(Boolean);
            if (parts[0] === 'S') parts.shift();
            const cppEnum = sanitize.disambiguate(_toPascal(parts) || ('State' + s.index), usedState);
            return Object.assign({}, s, { cppEnum });
        });
        const triggers = ir.triggers.map(t => {
            let parts = t.constName.split('_').filter(Boolean);
            if (parts[0] === 'TRIG') parts.shift();
            const cppEnum = sanitize.disambiguate(_toPascal(parts) || ('Trigger' + t.index), usedTrigger);
            return Object.assign({}, t, { cppEnum });
        });

        const sById = new Map(states.map(s => [s.id, s]));
        const tById = new Map(triggers.map(t => [t.id, t]));

        const fireable = ir.transitions
            .filter(t => t.trigger)
            .map(t => ({ from: sById.get(t.from.id), to: sById.get(t.to.id), trigger: tById.get(t.trigger.id) }))
            .filter(t => t.from && t.to && t.trigger);
        const dropped = ir.transitions.length - fireable.length;

        // Gates resolved to C++ state/trigger objects.
        const gates = (ir.gates || []).map(g => {
            const trg = g.trigger ? tById.get(g.trigger.id) : null;
            if (g.type === 'SPLIT') {
                return { type: 'SPLIT', source: sById.get(g.source.id),
                         outputs: g.outputs.map(o => sById.get(o.id)), trigger: trg };
            }
            if (g.type === 'NOT') {
                return { type: 'NOT', guard: sById.get(g.guard.id), to: sById.get(g.to.id), trigger: trg };
            }
            return { type: g.type, inputs: g.inputs.map(i => sById.get(i.id)), to: sById.get(g.to.id), trigger: trg };
        });

        const start  = states.find(s => s.kind === 'start') || states[0];
        const finals = states.filter(s => s.kind === 'end');

        return { ir, states, triggers, fireable, gates, dropped, start, finals,
                 gated: gates.length > 0,
                 stamp: new Date().toISOString().slice(0, 10) };
    }

    /* ── header ───────────────────────────────────────────────────── */

    function _emitHeader(ctx) {
        const stateEnum = ctx.states
            .map(s => '    ' + emit.pad(s.cppEnum + ',', 22) + '// ' + s.name)
            .join('\n');
        const trigEnum = ctx.triggers.length
            ? ctx.triggers.map(t => '    ' + emit.pad(t.cppEnum + ',', 22) + '// ' + t.name +
                                    (t.kind === 'timer' ? ' (timer)' : '')).join('\n')
            : '    // (no triggers defined)';
        const perTrigger = ctx.triggers.length
            ? ctx.triggers.map(t => '    bool ' + t.fnName + '();   // fire(Trigger::' + t.cppEnum + ')').join('\n')
            : '    // (no per-trigger helpers)';

        return emit.banner('state_machine.hpp  —  ' + ctx.ir.name, [
            'Finite-state machine (FSM) — generated by Machine Studio.',
            'One active state; StateMachine::fire() moves it. Generated ' + ctx.stamp + '.'
        ]) + '\n' +
`#pragma once
#include <string>

namespace sm {

enum class State : int {
${stateEnum}
    Count
};

enum class Trigger : int {
${trigEnum}
};

const char* to_string(State s);

class StateMachine {
public:
    StateMachine();              // constructs in the start state
    void  reset();               // return to the start state
    State current() const;       // the single active state
    bool  isFinal() const;       // current state is an end state

    // Fire a trigger. Returns true if a transition fired, false if the
    // trigger is not wired out of the current state (a harmless no-op).
    bool fire(Trigger t);
    bool fire(int trigger_id);   // integer overload

${perTrigger}

protected:
    // Called whenever the machine ENTERS a state (including reset()).
    // Override in a subclass to run state-specific logic.
    virtual void onEnter(State /*s*/) {}

private:
    State current_;
    void enter(State s);         // set + fire onEnter
};

} // namespace sm
`;
    }

    /* ── source ───────────────────────────────────────────────────── */

    function _emitSource(ctx, pattern) {
        const names = ctx.states
            .map(s => '        case State::' + s.cppEnum + ': return "' + _esc(s.name) + '";')
            .join('\n');
        const finalArm = ctx.finals.length
            ? ctx.finals.map(s => '        case State::' + s.cppEnum + ': return true;').join('\n')
            : '        // no end states';
        const perTrigger = ctx.triggers.length
            ? ctx.triggers.map(t =>
                'bool StateMachine::' + t.fnName + '() { return fire(Trigger::' + t.cppEnum + '); }'
              ).join('\n')
            : '// (no per-trigger helpers)';

        const dispatch =
            pattern === 'switch' ? _switchDispatch(ctx) :
            pattern === 'oop'    ? _oopDispatch(ctx) :
                                   _tableDispatch(ctx);
        const extraIncludes =
            pattern === 'oop'    ? '#include <array>\n#include <functional>\n#include <optional>\n' :
            pattern === 'table'  ? '#include <array>\n' : '';

        return emit.banner('state_machine.cpp  —  ' + ctx.ir.name, [
            'FSM implementation (' + pattern + ' dispatch). Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.hpp"
${extraIncludes}
namespace sm {

const char* to_string(State s) {
    switch (s) {
${names}
        default: return "(invalid)";
    }
}

static const State kStart = State::${ctx.start.cppEnum};

StateMachine::StateMachine() { reset(); }

void StateMachine::reset() { current_ = kStart; onEnter(current_); }

State StateMachine::current() const { return current_; }

bool StateMachine::isFinal() const {
    switch (current_) {
${finalArm}
        default: return false;
    }
}

void StateMachine::enter(State s) { current_ = s; onEnter(current_); }

${dispatch}

bool StateMachine::fire(int trigger_id) {
    return fire(static_cast<Trigger>(trigger_id));
}

${perTrigger}

} // namespace sm
`;
    }

    function _tableDispatch(ctx) {
        const rows = ctx.fireable.length
            ? ctx.fireable.map(t =>
                '    { State::' + emit.pad(t.from.cppEnum + ',', 16) +
                'Trigger::' + emit.pad(t.trigger.cppEnum + ',', 16) +
                'State::' + t.to.cppEnum + ' },'
              ).join('\n')
            : '    // (no triggered transitions)';
        return `namespace {
struct Transition { State from; Trigger trigger; State to; };
constexpr std::array<Transition, ${ctx.fireable.length}> kTable = {{
${rows}
}};
} // anonymous namespace

bool StateMachine::fire(Trigger t) {
    for (const auto& tr : kTable) {
        if (tr.from == current_ && tr.trigger == t) {
            enter(tr.to);
            return true;
        }
    }
    return false;
}`;
    }

    function _switchDispatch(ctx) {
        const byFrom = new Map();
        ctx.fireable.forEach(t => {
            if (!byFrom.has(t.from.cppEnum)) byFrom.set(t.from.cppEnum, []);
            byFrom.get(t.from.cppEnum).push(t);
        });
        let cases = '';
        byFrom.forEach((list, fromEnum) => {
            const inner = list.map(t =>
                '            case Trigger::' + t.trigger.cppEnum + ': enter(State::' + t.to.cppEnum +
                '); return true;'
            ).join('\n');
            cases +=
`        case State::${fromEnum}:
            switch (t) {
${inner}
                default: break;
            }
            break;
`;
        });
        if (!cases) cases = '        // (no triggered transitions)\n';
        return `bool StateMachine::fire(Trigger t) {
    switch (current_) {
${cases}        default: break;
    }
    return false;
}`;
    }

    function _oopDispatch(ctx) {
        // Each state owns a handler: Trigger -> next State (or no move).
        // Stored in an array indexed by state — object-flavoured dispatch.
        const handlers = ctx.states.map(s => {
            const outs = ctx.fireable.filter(t => t.from.cppEnum === s.cppEnum);
            const arms = outs.map(t =>
                '            if (t == Trigger::' + t.trigger.cppEnum + ') return State::' + t.to.cppEnum + ';'
            ).join('\n');
            return `    handlers_[idx(State::${s.cppEnum})] = [](Trigger t) -> std::optional<State> {
${arms || '            (void)t;'}
        return std::nullopt;   // trigger not handled here
    };`;
        }).join('\n');

        return `namespace {
constexpr std::size_t idx(State s) { return static_cast<std::size_t>(s); }
using Handler = std::function<std::optional<State>(Trigger)>;
std::array<Handler, static_cast<std::size_t>(State::Count)> handlers_;
bool handlers_ready = false;

void build_handlers() {
${handlers}
    handlers_ready = true;
}
} // anonymous namespace

bool StateMachine::fire(Trigger t) {
    if (!handlers_ready) build_handlers();
    auto& h = handlers_[idx(current_)];
    if (!h) return false;
    auto next = h(t);
    if (!next) return false;
    enter(*next);
    return true;
}`;
    }

    /* ── demo main ────────────────────────────────────────────────── */

    function _emitMain(ctx) {
        const fireSeq = ctx.triggers.length
            ? ctx.triggers.map(t =>
`    std::cout << "fire " << "${_esc(t.name)}" << " : ";
    m.${t.fnName}();
    std::cout << "now in " << sm::to_string(m.current()) << "\\n";`
              ).join('\n')
            : '    std::cout << "(no triggers to fire)\\n";';

        return emit.banner('main.cpp  —  ' + ctx.ir.name + ' demo', [
            'Runnable smoke demo; subclass prints on each state entry.',
            'Build: make demo. Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.hpp"
#include <iostream>

// Demo subclass: print whenever we enter a state.
class Demo : public sm::StateMachine {
protected:
    void onEnter(sm::State s) override {
        std::cout << "  entered " << sm::to_string(s) << "\\n";
    }
};

int main() {
    Demo m;
    std::cout << "start state: " << sm::to_string(m.current()) << "\\n";
    std::cout << "---- firing every trigger once ----\\n";
${fireSeq}
    std::cout << "final? " << (m.isFinal() ? "yes" : "no") << "\\n";
    return 0;
}
`;
    }

    /* ── GoogleTest ───────────────────────────────────────────────── */

    function _emitTests(ctx) {
        const cases = [];

        cases.push({
            name: 'StartsInStartState',
            body: 'sm::StateMachine m;\nEXPECT_EQ(sm::State::' + ctx.start.cppEnum + ', m.current());'
        });

        const fromStart = ctx.fireable.find(t => t.from.cppEnum === ctx.start.cppEnum);
        if (fromStart) {
            cases.push({
                name: 'FireFromStartMovesState',
                body:
`sm::StateMachine m;
bool moved = m.fire(sm::Trigger::${fromStart.trigger.cppEnum});
EXPECT_TRUE(moved);
EXPECT_EQ(sm::State::${fromStart.to.cppEnum}, m.current());`
            });
        }

        cases.push({
            name: 'UnknownTriggerIsIgnored',
            body:
`sm::StateMachine m;
sm::State before = m.current();
bool moved = m.fire(-1);   // integer overload: no such trigger
EXPECT_FALSE(moved);
EXPECT_EQ(before, m.current());`
        });

        cases.push({
            name: 'TODO_AddYourOwn',
            body:
`// Drive the machine and assert the resulting state, e.g.:
//   sm::StateMachine m;
//   m.fire(sm::Trigger::Something);
//   EXPECT_EQ(sm::State::Expected, m.current());
SUCCEED();`
        });

        return gen_tests.gtest({
            title: ctx.ir.name,
            header: 'state_machine.hpp',
            suite: 'StateMachineTest',
            cases
        });
    }

    /* ── Makefile ─────────────────────────────────────────────────── */

    function _emitMakefile(ctx) {
        return `# Makefile — ${ctx.ir.name} (FSM, C++)
# Generated by Machine Studio ${ctx.stamp}.

CXX      ?= c++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -O2

all: demo

demo: state_machine.cpp main.cpp
\t$(CXX) $(CXXFLAGS) -o demo state_machine.cpp main.cpp

# GoogleTest: install libgtest-dev (or point at your own build).
# Links the gtest + gtest_main libraries.
test: state_machine.cpp test_state_machine.cpp
\t$(CXX) $(CXXFLAGS) -o run_tests state_machine.cpp test_state_machine.cpp -lgtest -lgtest_main -pthread
\t./run_tests

clean:
\trm -f demo run_tests

.PHONY: all test clean
`;
    }

    /* ── README ───────────────────────────────────────────────────── */

    function _emitReadme(ctx, pattern) {
        const triggerList = ctx.triggers.length
            ? ctx.triggers.map(t => '- `Trigger::' + t.cppEnum + '` / `' + t.fnName + '()` — ' + t.name).join('\n')
            : '_None._';
        const droppedNote = ctx.dropped > 0
            ? '\n> ⚠️ ' + ctx.dropped + ' transition(s) without a trigger were omitted.\n'
            : '';
        return `# ${ctx.ir.name} — Finite-State Machine (C++)

Generated by **Machine Studio** ${ctx.stamp} · \`${pattern}\` dispatch.

One state is active at a time. \`StateMachine::fire(Trigger)\` moves to the
target state for *(current, trigger)* if one exists (returning \`true\`) and
calls the \`onEnter\` hook; otherwise it is a no-op returning \`false\`.
${droppedNote}
## API (\`state_machine.hpp\`)

\`\`\`cpp
sm::StateMachine m;            // constructs in ${ctx.start.cppEnum}
m.reset();                     // back to the start state
sm::State s = m.current();     // active state
bool done  = m.isFinal();      // current is an end state?
bool moved = m.fire(sm::Trigger::Something);
\`\`\`

Subclass and override \`onEnter(State)\` for state-entry logic (see \`main.cpp\`).

### Triggers
${triggerList}

## Build & run

\`\`\`sh
make demo && ./demo
\`\`\`

## Tests (GoogleTest)

\`test_state_machine.cpp\` is a [GoogleTest](https://github.com/google/googletest)
template. With \`libgtest-dev\` installed:

\`\`\`sh
make test
\`\`\`

Cases cover the start state, the first transition out of it, and that an
unknown trigger is ignored — extend with your own scenarios.
`;
    }

    /* ════════════════════════════════════════════════════════════════
       GATED FSM — binary-marking step engine inside StateMachine.
       Used when the model has gates. Several states can be active at
       once; fire() runs one snapshot/apply step over transitions and
       gates (AND/OR/XOR/SPLIT/NOT). Pattern selection does not apply.
       ════════════════════════════════════════════════════════════════ */

    function _emitHeaderGated(ctx) {
        const stateEnum = ctx.states
            .map(s => '    ' + emit.pad(s.cppEnum + ',', 22) + '// ' + s.name)
            .join('\n');
        const trigEnum = ctx.triggers.length
            ? ctx.triggers.map(t => '    ' + emit.pad(t.cppEnum + ',', 22) + '// ' + t.name +
                                    (t.kind === 'timer' ? ' (timer)' : '')).join('\n')
            : '    // (no triggers defined)';
        const perTrigger = ctx.triggers.length
            ? ctx.triggers.map(t => '    bool ' + t.fnName + '();   // fire(Trigger::' + t.cppEnum + ')').join('\n')
            : '    // (no per-trigger helpers)';

        return emit.banner('state_machine.hpp  —  ' + ctx.ir.name, [
            'Finite-state machine with gates — generated by Machine Studio.',
            'Binary markers: gates block transitions; many states may be active.',
            'Generated ' + ctx.stamp + '.'
        ]) + '\n' +
`#pragma once
#include <string>

namespace sm {

enum class State : int {
${stateEnum}
    Count
};

enum class Trigger : int {
${trigEnum}
};

const char* to_string(State s);

// This machine has gates, so more than one state can be active at once.
// Query the active set with isActive(); current() returns the first
// active state (or State::Count if none) for single-state callers.
class StateMachine {
public:
    StateMachine();              // constructs with the start state active
    void  reset();               // clear, then activate the start state
    bool  isActive(State s) const;
    int   activeCount() const;
    State current() const;       // first active state, or State::Count
    bool  isFinal() const;       // any active state is an end state

    // Fire a trigger; runs one step. Returns true if the active set
    // changed, false otherwise.
    bool fire(Trigger t);
    bool fire(int trigger_id);   // integer overload

${perTrigger}

protected:
    // Called whenever a state becomes active (including reset()).
    // Override in a subclass to run state-specific logic.
    virtual void onEnter(State /*s*/) {}

private:
    bool active_[static_cast<int>(State::Count)];
};

} // namespace sm
`;
    }

    function _emitSourceGated(ctx) {
        const names = ctx.states
            .map(s => '        case State::' + s.cppEnum + ': return "' + _esc(s.name) + '";')
            .join('\n');
        const finalArm = ctx.finals.length
            ? ctx.finals.map(s => '        case State::' + s.cppEnum + ': return true;').join('\n')
            : '        // no end states';
        const perTrigger = ctx.triggers.length
            ? ctx.triggers.map(t =>
                'bool StateMachine::' + t.fnName + '() { return fire(Trigger::' + t.cppEnum + '); }'
              ).join('\n')
            : '// (no per-trigger helpers)';

        const hasTrans = ctx.fireable.length > 0;
        const transTable = hasTrans ? `
struct Transition { State from; Trigger trigger; State to; };
constexpr std::array<Transition, ${ctx.fireable.length}> kTransitions = {{
${ctx.fireable.map(t =>
    '    { State::' + emit.pad(t.from.cppEnum + ',', 16) +
    'Trigger::' + emit.pad(t.trigger.cppEnum + ',', 16) +
    'State::' + t.to.cppEnum + ' },'
).join('\n')}
}};
` : '';

        // Gate table sizing + rows.
        let maxIn = 1, maxOut = 1;
        ctx.gates.forEach(g => {
            if (g.type === 'SPLIT') { if (g.outputs.length > maxOut) maxOut = g.outputs.length; }
            else if (g.type === 'NOT') { /* single input */ }
            else { if (g.inputs.length > maxIn) maxIn = g.inputs.length; }
        });
        const tEnum = g => 'static_cast<int>(Trigger::' + g.trigger.cppEnum + ')';
        const gateRows = ctx.gates.map(g => {
            const trg = g.trigger ? tEnum(g) : '-1';
            let ins, outs, to, ic, oc;
            if (g.type === 'SPLIT') {
                ins = '{ State::' + g.source.cppEnum + ' }';
                outs = '{ ' + g.outputs.map(o => 'State::' + o.cppEnum).join(', ') + ' }';
                to = 'State::Count'; ic = 1; oc = g.outputs.length;
            } else if (g.type === 'NOT') {
                ins = '{ State::' + g.guard.cppEnum + ' }';
                outs = '{ State::Count }'; to = 'State::' + g.to.cppEnum; ic = 1; oc = 0;
            } else {
                ins = '{ ' + g.inputs.map(i => 'State::' + i.cppEnum).join(', ') + ' }';
                outs = '{ State::Count }'; to = 'State::' + g.to.cppEnum; ic = g.inputs.length; oc = 0;
            }
            return '    { ' + trg + ', GateType::' + _gtName(g.type) + ', ' +
                   ic + ', ' + ins + ', ' + oc + ', ' + outs + ', ' + to + ' },';
        }).join('\n');

        const tClassify = hasTrans ? `
    bool tEn[kTransitions.size()];
    for (std::size_t i = 0; i < kTransitions.size(); i++) {
        tEn[i] = (static_cast<int>(kTransitions[i].trigger) == tid) &&
                 snapshot[idx(kTransitions[i].from)];
    }` : '';
        const tApply = hasTrans ? `
    for (std::size_t i = 0; i < kTransitions.size(); i++) {
        if (!tEn[i]) continue;
        const Transition& tr = kTransitions[i];
        if (!active_[idx(tr.from)]) continue;
        if (tr.from != tr.to) active_[idx(tr.from)] = false;
        active_[idx(tr.to)] = true;
    }` : '';

        return emit.banner('state_machine.cpp  —  ' + ctx.ir.name, [
            'FSM with gates — binary-marking step engine. Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.hpp"
#include <array>

namespace sm {

const char* to_string(State s) {
    switch (s) {
${names}
        default: return "(invalid)";
    }
}

namespace {
constexpr int kCount = static_cast<int>(State::Count);
constexpr int idx(State s) { return static_cast<int>(s); }
${transTable}
enum class GateType { And, Or, Xor, Split, Not };
struct Gate {
    int       trigger;     // Trigger id, or -1
    GateType  type;
    int       inputCount;
    State     inputs[${maxIn}];
    int       outputCount;
    State     outputs[${maxOut}];
    State     to;
};
constexpr std::array<Gate, ${ctx.gates.length}> kGates = {{
${gateRows}
}};

// Classify a gate against the snapshot. For OR/XOR the paying input
// index is written to chosen so apply charges the same one.
bool gateEnabled(const Gate& g, const bool* m, int& chosen) {
    chosen = -1;
    switch (g.type) {
        case GateType::And:
            for (int i = 0; i < g.inputCount; i++) if (!m[idx(g.inputs[i])]) return false;
            return true;
        case GateType::Or:
            for (int i = 0; i < g.inputCount; i++) if (m[idx(g.inputs[i])]) { chosen = i; return true; }
            return false;
        case GateType::Xor: {
            int c = -1, n = 0;
            for (int i = 0; i < g.inputCount; i++) if (m[idx(g.inputs[i])]) { c = i; n++; }
            if (n == 1) { chosen = c; return true; }
            return false;
        }
        case GateType::Split:
            return m[idx(g.inputs[0])];
        case GateType::Not:
            return !m[idx(g.inputs[0])];   // inhibitor: enabled while guard inactive
    }
    return false;
}
} // anonymous namespace

static const State kStart = State::${ctx.start.cppEnum};

StateMachine::StateMachine() { reset(); }

void StateMachine::reset() {
    for (int i = 0; i < kCount; i++) active_[i] = false;
    active_[idx(kStart)] = true;
    onEnter(kStart);
}

bool StateMachine::isActive(State s) const {
    int i = idx(s);
    return (i >= 0 && i < kCount) ? active_[i] : false;
}

int StateMachine::activeCount() const {
    int n = 0;
    for (int i = 0; i < kCount; i++) if (active_[i]) n++;
    return n;
}

State StateMachine::current() const {
    for (int i = 0; i < kCount; i++) if (active_[i]) return static_cast<State>(i);
    return State::Count;
}

bool StateMachine::isFinal() const {
    for (int i = 0; i < kCount; i++) {
        if (!active_[i]) continue;
        switch (static_cast<State>(i)) {
${finalArm}
            default: break;
        }
    }
    return false;
}

bool StateMachine::fire(Trigger t) {
    int tid = static_cast<int>(t);
    bool snapshot[kCount];
    for (int i = 0; i < kCount; i++) snapshot[i] = active_[i];
${tClassify}
    bool gEn[kGates.size()];
    int  gCh[kGates.size()];
    for (std::size_t i = 0; i < kGates.size(); i++) {
        gEn[i] = false; gCh[i] = -1;
        if (kGates[i].trigger != tid) continue;
        gEn[i] = gateEnabled(kGates[i], snapshot, gCh[i]);
    }
${tApply}
    for (std::size_t i = 0; i < kGates.size(); i++) {
        if (!gEn[i]) continue;
        const Gate& g = kGates[i];
        switch (g.type) {
            case GateType::And: {
                bool ok = true;
                for (int k = 0; k < g.inputCount; k++) if (!active_[idx(g.inputs[k])]) { ok = false; break; }
                if (!ok) break;
                for (int k = 0; k < g.inputCount; k++) active_[idx(g.inputs[k])] = false;
                active_[idx(g.to)] = true;
                break;
            }
            case GateType::Or:
            case GateType::Xor:
                if (gCh[i] < 0 || !active_[idx(g.inputs[gCh[i]])]) break;
                active_[idx(g.inputs[gCh[i]])] = false;
                active_[idx(g.to)] = true;
                break;
            case GateType::Split:
                if (!active_[idx(g.inputs[0])]) break;
                active_[idx(g.inputs[0])] = false;
                for (int k = 0; k < g.outputCount; k++) active_[idx(g.outputs[k])] = true;
                break;
            case GateType::Not:
                if (active_[idx(g.inputs[0])]) break;
                active_[idx(g.to)] = true;
                break;
        }
    }

    bool changed = false;
    for (int i = 0; i < kCount; i++) {
        if (!snapshot[i] && active_[i]) onEnter(static_cast<State>(i));
        if (snapshot[i] != active_[i]) changed = true;
    }
    return changed;
}

bool StateMachine::fire(int trigger_id) {
    return fire(static_cast<Trigger>(trigger_id));
}

${perTrigger}

} // namespace sm
`;
    }

    function _gtName(type) {
        return { AND: 'And', OR: 'Or', XOR: 'Xor', SPLIT: 'Split', NOT: 'Not' }[type] || 'And';
    }

    function _emitMainGated(ctx) {
        const fireSeq = ctx.triggers.length
            ? ctx.triggers.map(t =>
`    std::cout << "fire " << "${_esc(t.name)}" << " :\\n";
    m.${t.fnName}();
    dump(m);`
              ).join('\n')
            : '    std::cout << "(no triggers to fire)\\n";';

        return emit.banner('main.cpp  —  ' + ctx.ir.name + ' demo', [
            'Runnable smoke demo; subclass prints on each state entry.',
            'Build: make demo. Generated ' + ctx.stamp + '.'
        ]) + '\n\n' +
`#include "state_machine.hpp"
#include <iostream>

// Demo subclass: print whenever a state becomes active.
class Demo : public sm::StateMachine {
protected:
    void onEnter(sm::State s) override {
        std::cout << "  entered " << sm::to_string(s) << "\\n";
    }
};

static void dump(const sm::StateMachine& m) {
    std::cout << "  active: ";
    bool first = true;
    for (int i = 0; i < static_cast<int>(sm::State::Count); i++) {
        sm::State s = static_cast<sm::State>(i);
        if (m.isActive(s)) { std::cout << (first ? "" : ", ") << sm::to_string(s); first = false; }
    }
    std::cout << (first ? "(none)" : "") << "\\n";
}

int main() {
    Demo m;
    std::cout << "start:\\n";
    dump(m);
    std::cout << "---- firing every trigger once ----\\n";
${fireSeq}
    std::cout << "final? " << (m.isFinal() ? "yes" : "no") << "\\n";
    return 0;
}
`;
    }

    function _emitTestsGated(ctx) {
        const cases = [];

        cases.push({
            name: 'StartsWithStartActive',
            body: 'sm::StateMachine m;\nEXPECT_TRUE(m.isActive(sm::State::' + ctx.start.cppEnum + '));'
        });

        cases.push({
            name: 'UnknownTriggerChangesNothing',
            body:
`sm::StateMachine m;
int before = m.activeCount();
bool moved = m.fire(-1);   // integer overload: no such trigger
EXPECT_FALSE(moved);
EXPECT_EQ(before, m.activeCount());`
        });

        cases.push({
            name: 'TODO_AddYourOwn',
            body:
`// Drive the machine and assert the active set, e.g.:
//   sm::StateMachine m;
//   m.fire(sm::Trigger::Something);
//   EXPECT_TRUE(m.isActive(sm::State::Expected));
SUCCEED();`
        });

        return gen_tests.gtest({
            title: ctx.ir.name,
            header: 'state_machine.hpp',
            suite: 'StateMachineTest',
            cases
        });
    }

    function _emitReadmeGated(ctx) {
        const triggerList = ctx.triggers.length
            ? ctx.triggers.map(t => '- `Trigger::' + t.cppEnum + '` / `' + t.fnName + '()` — ' + t.name).join('\n')
            : '_None._';
        const gateList = ctx.gates.map(g => {
            if (g.type === 'SPLIT') return '- **SPLIT** `' + g.source.name + '` → ' + g.outputs.map(o => '`' + o.name + '`').join(', ');
            if (g.type === 'NOT')   return '- **NOT** target `' + g.to.name + '` blocked while `' + g.guard.name + '` is active';
            return '- **' + g.type + '** ' + g.inputs.map(i => '`' + i.name + '`').join(', ') + ' → `' + g.to.name + '`';
        }).join('\n');
        const droppedNote = ctx.dropped > 0
            ? '\n> ⚠️ ' + ctx.dropped + ' transition(s) without a trigger were omitted.\n'
            : '';

        return `# ${ctx.ir.name} — Finite-State Machine with gates (C++)

Generated by **Machine Studio** ${ctx.stamp}.

This machine has gates, so it runs as a **binary-marking step engine**: each
state is active or inactive and \`fire()\` runs one atomic step. A SPLIT can
expose several states and an AND join waits on all of its inputs, so **more
than one state can be active at once**.
${droppedNote}
## Gates

${gateList}

**AND** needs every input active, **OR** any input, **XOR** exactly one,
**SPLIT** exposes all its destinations from one source, and **NOT** is an
inhibitor — its target is reachable only while the guard state is inactive.

## API (\`state_machine.hpp\`)

\`\`\`cpp
sm::StateMachine m;            // ${ctx.start.cppEnum} active
m.reset();                     // clear, then activate the start state
bool on   = m.isActive(sm::State::Something);
int  live = m.activeCount();
bool done = m.isFinal();       // any active state is an end state?
bool moved = m.fire(sm::Trigger::Something);
\`\`\`

Subclass and override \`onEnter(State)\` for state-entry logic (see \`main.cpp\`).

### Triggers
${triggerList}

## Build & run

\`\`\`sh
make demo && ./demo
\`\`\`

## Tests (GoogleTest)

\`test_state_machine.cpp\` is a [GoogleTest](https://github.com/google/googletest)
template. With \`libgtest-dev\` installed, \`make test\`.
`;
    }

    function _esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

    return { generate, SUPPORTED_PATTERNS };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { cpp_fsm };
}
