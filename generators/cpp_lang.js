/**
 * generators/cpp_lang.js
 * Machine Studio [MS] — C++ language code generator.
 *
 * Three patterns supported:
 *   'table'  — data tables (std::array) + std::function handlers.
 *   'switch' — single fire(int) with switch/case, std::function handlers.
 *   'oop'    — one class per state derived from sm::IState; user
 *              installs subclasses via machine.install(State, unique_ptr).
 *
 * All three emit the same firing engine semantics — two-phase
 * step (snapshot, classify, apply) matching the JS simulator.
 *
 * Target standard: C++17 (uses std::string_view, structured bindings,
 * std::array deduction).
 *
 * Files emitted:
 *   state_machine.hpp
 *   state_machine.cpp
 *   main.cpp     — runnable demo with stub handlers
 *   Makefile
 *   README.md
 *
 * Depends on: sanitize.js, emit.js, walker.js
 */

const cpp_lang = (() => {

    const ID                 = 'cpp';
    const NAME               = 'C++';
    const SUPPORTED_PATTERNS = ['table', 'switch', 'oop'];

    /* ─── public entry ──────────────────────────────────────────── */

    function generate(ir, opts) {
        if (!SUPPORTED_PATTERNS.includes(opts.pattern)) {
            return { ok: false,
                error: 'C++ generator does not support pattern "' + opts.pattern + '". ' +
                       'Supported: ' + SUPPORTED_PATTERNS.join(', ') };
        }
        if (ir.states.length === 0) {
            return { ok: false, error: 'Machine has no states — nothing to generate.' };
        }

        const ctx = _ctx(ir, opts);

        // Compute per-state and per-trigger C++ identifiers (PascalCase
        // for enums and class names, snake_case kept for method names).
        ctx.cpp = _computeCppNames(ir);

        const files = [];
        if (opts.pattern === 'oop') {
            files.push({ name: 'state_machine.hpp', content: _emitHeaderOop(ctx) });
            files.push({ name: 'state_machine.cpp', content: _emitSourceOop(ctx) });
            files.push({ name: 'main.cpp',          content: _emitExampleMainOop(ctx) });
        } else {
            files.push({ name: 'state_machine.hpp', content: _emitHeader(ctx) });
            files.push({ name: 'state_machine.cpp', content: opts.pattern === 'table'
                                                          ? _emitSourceTable(ctx)
                                                          : _emitSourceSwitch(ctx) });
            files.push({ name: 'main.cpp',          content: _emitExampleMain(ctx) });
        }
        files.push({ name: 'Makefile',  content: _emitMakefile(ctx) });
        files.push({ name: 'README.md', content: _emitReadme(ctx) });

        return {
            ok: true,
            files,
            previewFile: 'state_machine.cpp',
            warnings: ir.warnings || []
        };
    }

    /* ─── context + name maps ──────────────────────────────────── */

    function _ctx(ir, opts) {
        return {
            ir, opts,
            hasTransitions: ir.transitions.length > 0,
            hasGates:       ir.gates.length > 0,
            stamp:          new Date().toISOString().slice(0, 10)
        };
    }

    /* Turn walker's snake-case enumName ("S_BRANCH_A_2") into a
       PascalCase C++ identifier ("BranchA2"). Also produces a class
       name ("BranchAState") for OOP per-state classes. */
    function _toPascal(words) {
        return words.filter(p => p.length > 0)
                    .map(p => p[0].toUpperCase() + p.slice(1).toLowerCase())
                    .join('');
    }

    function _computeCppNames(ir) {
        const usedStateEnum  = new Set(['Count', 'Invalid']);
        const usedStateClass = new Set(['IState', 'StateMachine', 'State', 'Trigger']);
        const usedTriggerEnum = new Set();

        const states = ir.states.map(s => {
            // strip leading "S_" then PascalCase
            let parts = s.enumName.split('_').filter(p => p);
            if (parts[0] === 'S') parts.shift();
            const basePascal  = _toPascal(parts) || ('State' + s.index);
            const cppEnumName = sanitize.disambiguate(basePascal, usedStateEnum);
            const cppClassName = sanitize.disambiguate(basePascal + 'State', usedStateClass);
            return Object.assign({}, s, { cppEnum: cppEnumName, cppClass: cppClassName });
        });

        const triggers = ir.triggers.map(t => {
            let parts = t.constName.split('_').filter(p => p);
            if (parts[0] === 'TRIG') parts.shift();
            const basePascal = _toPascal(parts) || ('Trigger' + t.index);
            const cppEnum    = sanitize.disambiguate(basePascal, usedTriggerEnum);
            // Method name stays snake_case (matches the C-side convention)
            return Object.assign({}, t, { cppEnum });
        });

        return { states, triggers };
    }

    /* ============================================================
       HEADER — table / switch patterns
       Public API:
         class StateMachine {
           StateMachine();
           void reset();
           int tokens_in(State s) const;
           int total_tokens() const;
           State current_state() const;
           using Handler = std::function<void()>;
           void set_handler(State s, Handler h);
           void execute_current();
           void fire(Trigger t);
           void fire(int trigger_id);
           void fire_advance();    // one per trigger
         };
       ============================================================ */

    function _emitHeader(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const stateEnum = cpp.states.map(s =>
            '    ' + emit.pad(s.cppEnum + ',', 22) + '// ' + s.name
        ).join('\n');

        const trigEnum = cpp.triggers.length
            ? cpp.triggers.map(t =>
                '    ' + emit.pad(t.cppEnum + ',', 22) + '// ' + t.name +
                (t.kind === 'timer' ? ' (timer)' : '')
              ).join('\n')
            : '    // No triggers defined.';

        const fireDecls = cpp.triggers.length
            ? cpp.triggers.map(t => '    void ' + t.fnName + '();').join('\n')
            : '    // No per-trigger functions: no triggers were defined.';

        const meta = [
            'Machine:    ' + ir.name,
            'Generated:  ' + ctx.stamp,
            'Pattern:    ' + ctx.opts.pattern + ' — ' + _patternBlurb(ctx.opts.pattern),
            'States:     ' + ir.states.length + '   Transitions: ' + ir.transitions.length +
                (ir.gates.length ? '   Gates: ' + ir.gates.length : ''),
            'Triggers:   ' + ir.triggers.length,
            '',
            'Do not edit by hand — regenerate from the .json.'
        ];

        return emit.banner('state_machine.hpp  —  ' + ir.name, meta) + '\n' +
`#pragma once

#include <array>
#include <cstddef>
#include <functional>
#include <string_view>

namespace sm {

${emit.section('States')}

enum class State : int {
${stateEnum}
    Count,
    Invalid = -1
};

constexpr std::size_t kStateCount = static_cast<std::size_t>(State::Count);

${emit.section('Triggers')}

enum class Trigger : int {
${trigEnum}
};

${emit.section('StateMachine — public API')}

class StateMachine {
public:
    using Handler = std::function<void()>;

    StateMachine();

    void reset();

    // Petri-net accessors — always defined.
    int tokens_in(State s) const;
    int total_tokens() const;

    // FSM-style accessor — returns State::Invalid when marking is non-singleton.
    State current_state() const;

    // Register per-state behavior. Pass a lambda, function pointer, or
    // std::function. Defaults to no-op when not set.
    void set_handler(State s, Handler h);

    // Invokes the registered handler for current_state() if singleton.
    void execute_current();

    // Trigger dispatch.
    void fire(Trigger t);
    void fire(int trigger_id);

${fireDecls}

private:
    std::array<int, kStateCount>     marking_{};
    std::array<int, kStateCount>     snapshot_{};
    std::array<Handler, kStateCount> handlers_{};
};

} // namespace sm
`;
    }

    /* ============================================================
       SOURCE — TABLE pattern (C++)
       ============================================================ */

    function _emitSourceTable(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const attrs = cpp.states.map(s =>
            '    /* ' + emit.pad(s.name + ' */', 18) +
            '{ ' + s.inputCost + ', ' + s.outputYield + ', ' +
                   s.bufferCap + ', ' + s.initialTokens + ' },'
        ).join('\n');

        const transitions = ctx.hasTransitions ? _emitTransitionsTableCpp(ctx) : '';
        const gates       = ctx.hasGates       ? _emitGatesTableCpp(ctx)       : '';
        const fireImpl    = _emitFireDispatchCpp(ctx);

        const perTrigger = cpp.triggers.length
            ? cpp.triggers.map(t =>
                'void StateMachine::' + t.fnName + '() { fire(Trigger::' + t.cppEnum + '); }'
              ).join('\n')
            : '// No per-trigger functions.';

        const meta = [
            'Machine:    ' + ir.name,
            'Pattern:    table — std::array tables + std::function handlers',
            'Generated:  ' + ctx.stamp
        ];

        return emit.banner('state_machine.cpp  —  ' + ir.name, meta) + '\n\n' +
`#include "state_machine.hpp"
#include <algorithm>
#include <utility>

namespace sm {

namespace {

${emit.section('State attributes — indexed by State')}

struct StateAttrs {
    int input_cost;
    int output_yield;
    int buffer_cap;
    int initial_tokens;
};

constexpr std::array<StateAttrs, kStateCount> kStateAttrs = {{
${attrs}
}};

inline const StateAttrs& attrs_of(State s) {
    return kStateAttrs[static_cast<std::size_t>(s)];
}

${transitions}
${gates}
} // anonymous namespace

${emit.section('Lifecycle')}

StateMachine::StateMachine() { reset(); }

void StateMachine::reset() {
    for (std::size_t i = 0; i < kStateCount; ++i) {
        marking_[i] = kStateAttrs[i].initial_tokens;
    }
}

${emit.section('Accessors')}

int StateMachine::tokens_in(State s) const {
    const int i = static_cast<int>(s);
    if (i < 0 || i >= static_cast<int>(kStateCount)) return 0;
    return marking_[static_cast<std::size_t>(i)];
}

int StateMachine::total_tokens() const {
    int sum = 0;
    for (int v : marking_) sum += v;
    return sum;
}

State StateMachine::current_state() const {
    State found = State::Invalid;
    int count = 0;
    for (std::size_t i = 0; i < kStateCount; ++i) {
        if (marking_[i] > 0) { found = static_cast<State>(i); ++count; }
    }
    return count == 1 ? found : State::Invalid;
}

void StateMachine::set_handler(State s, Handler h) {
    const int i = static_cast<int>(s);
    if (i >= 0 && i < static_cast<int>(kStateCount)) {
        handlers_[static_cast<std::size_t>(i)] = std::move(h);
    }
}

void StateMachine::execute_current() {
    State s = current_state();
    if (s == State::Invalid) return;
    auto& h = handlers_[static_cast<std::size_t>(s)];
    if (h) h();
}

${fireImpl}

${emit.section('Per-trigger wrappers')}

${perTrigger}

} // namespace sm
`;
    }

    function _emitTransitionsTableCpp(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        // Map state ids → cppEnum (since IR transitions reference IR state objects directly)
        const cppEnumByStateId = new Map(cpp.states.map(s => [s.id, s.cppEnum]));
        const cppEnumByTrigId  = new Map(cpp.triggers.map(t => [t.id, t.cppEnum]));

        const rows = ir.transitions.map(t => {
            const trg = t.trigger ? ('Trigger::' + cppEnumByTrigId.get(t.trigger.id)) : 'Trigger{-1}';
            return '    { ' + trg + ', State::' +
                              cppEnumByStateId.get(t.from.id) + ', State::' +
                              cppEnumByStateId.get(t.to.id) + ' },';
        }).join('\n');

        return `
${emit.section('Transitions table')}

struct Transition {
    Trigger trigger;
    State   from;
    State   to;
};

constexpr std::array<Transition, ${ir.transitions.length}> kTransitions = {{
${rows}
}};

${emit.section('Transition firing helpers')}

bool transition_enabled(const Transition& t, const std::array<int, kStateCount>& m) {
    const auto& from = attrs_of(t.from);
    const auto& to   = attrs_of(t.to);
    if (m[static_cast<std::size_t>(t.from)] < from.input_cost) return false;
    if (t.from == t.to) {
        int final_ = m[static_cast<std::size_t>(t.from)] - from.input_cost + from.output_yield;
        return final_ <= from.buffer_cap;
    }
    return m[static_cast<std::size_t>(t.to)] + from.output_yield <= to.buffer_cap;
}

void transition_apply(const Transition& t, std::array<int, kStateCount>& m) {
    const auto& from = attrs_of(t.from);
    const auto& to   = attrs_of(t.to);
    const std::size_t fi = static_cast<std::size_t>(t.from);
    const std::size_t ti = static_cast<std::size_t>(t.to);
    if (m[fi] < from.input_cost) return;
    if (t.from == t.to) {
        int final_ = m[fi] - from.input_cost + from.output_yield;
        if (final_ > from.buffer_cap) return;
        m[fi] = final_;
    } else {
        if (m[ti] + from.output_yield > to.buffer_cap) return;
        m[fi] -= from.input_cost;
        m[ti] += from.output_yield;
    }
}
`;
    }

    function _emitGatesTableCpp(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const cppEnumByStateId = new Map(cpp.states.map(s => [s.id, s.cppEnum]));
        const cppEnumByTrigId  = new Map(cpp.triggers.map(t => [t.id, t.cppEnum]));

        // Compute the maximum input/output counts so the fixed-size
        // arrays in Gate are exactly large enough.
        let maxIn = 2, maxOut = 2;
        ir.gates.forEach(g => {
            if (g.type === 'SPLIT') {
                if (1 > maxIn) maxIn = 1;
                if (g.outputs.length > maxOut) maxOut = g.outputs.length;
            } else if (g.inputs.length > maxIn) {
                maxIn = g.inputs.length;
            }
        });

        const padInputs = (arr) => {
            const slots = new Array(maxIn).fill('State::Invalid');
            arr.forEach((id, i) => { slots[i] = 'State::' + cppEnumByStateId.get(id); });
            return '{{ ' + slots.join(', ') + ' }}';
        };
        const padOutputs = (arr) => {
            const slots = new Array(maxOut).fill('State::Invalid');
            arr.forEach((id, i) => { slots[i] = 'State::' + cppEnumByStateId.get(id); });
            return '{{ ' + slots.join(', ') + ' }}';
        };

        const rows = ir.gates.map(g => {
            const trg = g.trigger ? ('Trigger::' + cppEnumByTrigId.get(g.trigger.id)) : 'Trigger{-1}';
            if (g.type === 'SPLIT') {
                return '    { ' + trg + ', GateType::Split, ' +
                                  padInputs([g.source.id]) + ', 1, ' +
                                  padOutputs(g.outputs.map(s => s.id)) + ', ' + g.outputs.length + ', ' +
                                  'State::Invalid },';
            }
            return '    { ' + trg + ', GateType::' + g.type[0] + g.type.slice(1).toLowerCase() + ', ' +
                              padInputs(g.inputs.map(s => s.id)) + ', ' + g.inputs.length + ', ' +
                              padOutputs([]) + ', 0, ' +
                              'State::' + cppEnumByStateId.get(g.to.id) + ' },';
        }).join('\n');

        return `
${emit.section('Gates table')}

enum class GateType { And, Or, Xor, Split };

constexpr std::size_t kMaxGateInputs  = ${maxIn};
constexpr std::size_t kMaxGateOutputs = ${maxOut};

struct Gate {
    Trigger  trigger;
    GateType type;
    std::array<State, kMaxGateInputs>  inputs;
    int      input_count;
    std::array<State, kMaxGateOutputs> outputs;
    int      output_count;
    State    to;
};

constexpr std::array<Gate, ${ir.gates.length}> kGates = {{
${rows}
}};

${emit.section('Gate firing helpers')}

/* Classify returns enabledness; for OR/XOR, the chosen input index is
   written to out_chosen so apply charges the right input. */
bool gate_enabled(const Gate& g, const std::array<int, kStateCount>& m, int& out_chosen) {
    out_chosen = -1;
    switch (g.type) {
        case GateType::And: {
            int total_yield = 0;
            for (int i = 0; i < g.input_count; ++i) {
                State in = g.inputs[static_cast<std::size_t>(i)];
                if (m[static_cast<std::size_t>(in)] < attrs_of(in).input_cost) return false;
                total_yield += attrs_of(in).output_yield;
            }
            return m[static_cast<std::size_t>(g.to)] + total_yield <= attrs_of(g.to).buffer_cap;
        }
        case GateType::Or:
            for (int i = 0; i < g.input_count; ++i) {
                State in = g.inputs[static_cast<std::size_t>(i)];
                if (m[static_cast<std::size_t>(in)] >= attrs_of(in).input_cost) {
                    int y = attrs_of(in).output_yield;
                    if (m[static_cast<std::size_t>(g.to)] + y <= attrs_of(g.to).buffer_cap) {
                        out_chosen = i;
                        return true;
                    }
                }
            }
            return false;
        case GateType::Xor: {
            int chosen = -1, count = 0;
            for (int i = 0; i < g.input_count; ++i) {
                State in = g.inputs[static_cast<std::size_t>(i)];
                if (m[static_cast<std::size_t>(in)] >= attrs_of(in).input_cost) {
                    chosen = i; ++count;
                }
            }
            if (count != 1) return false;
            State in = g.inputs[static_cast<std::size_t>(chosen)];
            int y = attrs_of(in).output_yield;
            if (m[static_cast<std::size_t>(g.to)] + y > attrs_of(g.to).buffer_cap) return false;
            out_chosen = chosen;
            return true;
        }
        case GateType::Split: {
            State src = g.inputs[0];
            int required = g.output_count * attrs_of(src).input_cost;
            if (m[static_cast<std::size_t>(src)] < required) return false;
            int yield = attrs_of(src).output_yield;
            for (int i = 0; i < g.output_count; ++i) {
                State out = g.outputs[static_cast<std::size_t>(i)];
                if (m[static_cast<std::size_t>(out)] + yield > attrs_of(out).buffer_cap) return false;
            }
            return true;
        }
    }
    return false;
}

void gate_apply(const Gate& g, int chosen, std::array<int, kStateCount>& m) {
    switch (g.type) {
        case GateType::And: {
            int total_yield = 0;
            for (int i = 0; i < g.input_count; ++i) {
                State in = g.inputs[static_cast<std::size_t>(i)];
                if (m[static_cast<std::size_t>(in)] < attrs_of(in).input_cost) return;
                total_yield += attrs_of(in).output_yield;
            }
            if (m[static_cast<std::size_t>(g.to)] + total_yield > attrs_of(g.to).buffer_cap) return;
            for (int i = 0; i < g.input_count; ++i) {
                State in = g.inputs[static_cast<std::size_t>(i)];
                m[static_cast<std::size_t>(in)] -= attrs_of(in).input_cost;
            }
            m[static_cast<std::size_t>(g.to)] += total_yield;
            break;
        }
        case GateType::Or:
        case GateType::Xor: {
            if (chosen < 0) return;
            State in = g.inputs[static_cast<std::size_t>(chosen)];
            int cost  = attrs_of(in).input_cost;
            int yield = attrs_of(in).output_yield;
            if (m[static_cast<std::size_t>(in)] < cost) return;
            if (m[static_cast<std::size_t>(g.to)] + yield > attrs_of(g.to).buffer_cap) return;
            m[static_cast<std::size_t>(in)]   -= cost;
            m[static_cast<std::size_t>(g.to)] += yield;
            break;
        }
        case GateType::Split: {
            State src = g.inputs[0];
            int required = g.output_count * attrs_of(src).input_cost;
            int yield = attrs_of(src).output_yield;
            if (m[static_cast<std::size_t>(src)] < required) return;
            for (int i = 0; i < g.output_count; ++i) {
                State out = g.outputs[static_cast<std::size_t>(i)];
                if (m[static_cast<std::size_t>(out)] + yield > attrs_of(out).buffer_cap) return;
            }
            m[static_cast<std::size_t>(src)] -= required;
            for (int i = 0; i < g.output_count; ++i) {
                State out = g.outputs[static_cast<std::size_t>(i)];
                m[static_cast<std::size_t>(out)] += yield;
            }
            break;
        }
    }
}
`;
    }

    function _emitFireDispatchCpp(ctx) {
        const tPhase1 = ctx.hasTransitions ? `
    // Phase 1a: classify transitions against snapshot.
    std::array<bool, kTransitions.size()> t_enabled{};
    for (std::size_t i = 0; i < kTransitions.size(); ++i) {
        const auto& t = kTransitions[i];
        t_enabled[i] = (static_cast<int>(t.trigger) == trigger_id)
                    && transition_enabled(t, snapshot_);
    }` : '';

        const gPhase1 = ctx.hasGates ? `
    // Phase 1b: classify gates against snapshot.
    std::array<bool, kGates.size()> g_enabled{};
    std::array<int,  kGates.size()> g_chosen{};
    for (std::size_t i = 0; i < kGates.size(); ++i) {
        g_chosen[i] = -1;
        if (static_cast<int>(kGates[i].trigger) != trigger_id) continue;
        g_enabled[i] = gate_enabled(kGates[i], snapshot_, g_chosen[i]);
    }` : '';

        const tPhase2 = ctx.hasTransitions ? `
    // Phase 2a: apply transitions in creation order.
    for (std::size_t i = 0; i < kTransitions.size(); ++i) {
        if (t_enabled[i]) transition_apply(kTransitions[i], marking_);
    }` : '';

        const gPhase2 = ctx.hasGates ? `
    // Phase 2b: apply gates in creation order.
    for (std::size_t i = 0; i < kGates.size(); ++i) {
        if (g_enabled[i]) gate_apply(kGates[i], g_chosen[i], marking_);
    }` : '';

        const unused = (!ctx.hasTransitions && !ctx.hasGates) ? '\n    (void)trigger_id;' : '';

        return `
${emit.section('Trigger dispatch — two-phase step semantics')}

/* Snapshot then classify against snapshot, then apply against live
   marking. This matches the JS simulator: a token arriving at a state
   during a step cannot leave again in the same step. */
void StateMachine::fire(Trigger t) { fire(static_cast<int>(t)); }

void StateMachine::fire(int trigger_id) {
    snapshot_ = marking_;
${tPhase1}${gPhase1}
${tPhase2}${gPhase2}${unused}
}`;
    }

    /* ============================================================
       SOURCE — SWITCH pattern (C++)
       ============================================================ */

    function _emitSourceSwitch(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const attrs = cpp.states.map(s =>
            '    /* ' + emit.pad(s.name + ' */', 18) +
            '{ ' + s.inputCost + ', ' + s.outputYield + ', ' +
                   s.bufferCap + ', ' + s.initialTokens + ' },'
        ).join('\n');

        const switchCases = cpp.triggers.length
            ? cpp.triggers.map(t => _emitSwitchCaseCpp(ctx, t)).join('\n\n')
            : '            // No triggers defined.';

        const perTrigger = cpp.triggers.length
            ? cpp.triggers.map(t =>
                'void StateMachine::' + t.fnName + '() { fire(Trigger::' + t.cppEnum + '); }'
              ).join('\n')
            : '// No per-trigger functions.';

        const meta = [
            'Machine:    ' + ir.name,
            'Pattern:    switch — one switch/case over trigger ids',
            'Generated:  ' + ctx.stamp
        ];

        return emit.banner('state_machine.cpp  —  ' + ir.name, meta) + '\n\n' +
`#include "state_machine.hpp"
#include <utility>

namespace sm {

namespace {

${emit.section('State attributes — indexed by State')}

struct StateAttrs {
    int input_cost;
    int output_yield;
    int buffer_cap;
    int initial_tokens;
};

constexpr std::array<StateAttrs, kStateCount> kStateAttrs = {{
${attrs}
}};

inline const StateAttrs& attrs_of(State s) {
    return kStateAttrs[static_cast<std::size_t>(s)];
}

} // anonymous namespace

${emit.section('Lifecycle')}

StateMachine::StateMachine() { reset(); }

void StateMachine::reset() {
    for (std::size_t i = 0; i < kStateCount; ++i) {
        marking_[i] = kStateAttrs[i].initial_tokens;
    }
}

${emit.section('Accessors')}

int StateMachine::tokens_in(State s) const {
    const int i = static_cast<int>(s);
    if (i < 0 || i >= static_cast<int>(kStateCount)) return 0;
    return marking_[static_cast<std::size_t>(i)];
}

int StateMachine::total_tokens() const {
    int sum = 0;
    for (int v : marking_) sum += v;
    return sum;
}

State StateMachine::current_state() const {
    State found = State::Invalid;
    int count = 0;
    for (std::size_t i = 0; i < kStateCount; ++i) {
        if (marking_[i] > 0) { found = static_cast<State>(i); ++count; }
    }
    return count == 1 ? found : State::Invalid;
}

void StateMachine::set_handler(State s, Handler h) {
    const int i = static_cast<int>(s);
    if (i >= 0 && i < static_cast<int>(kStateCount)) {
        handlers_[static_cast<std::size_t>(i)] = std::move(h);
    }
}

void StateMachine::execute_current() {
    State s = current_state();
    if (s == State::Invalid) return;
    auto& h = handlers_[static_cast<std::size_t>(s)];
    if (h) h();
}

${emit.section('Trigger dispatch — switch on trigger id')}

void StateMachine::fire(Trigger t) { fire(static_cast<int>(t)); }

void StateMachine::fire(int trigger_id) {
    snapshot_ = marking_;

    switch (static_cast<Trigger>(trigger_id)) {
${switchCases}
        default:
            (void)trigger_id;
            break;
    }
}

${emit.section('Per-trigger wrappers')}

${perTrigger}

} // namespace sm
`;
    }

    function _emitSwitchCaseCpp(ctx, trg) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;
        const cppEnumByStateId = new Map(cpp.states.map(s => [s.id, s.cppEnum]));

        const transitions = ir.transitions.filter(t => t.trigger && t.trigger.id === trg.id);
        const gates       = ir.gates      .filter(g => g.trigger && g.trigger.id === trg.id);

        const tBlocks = transitions.map((t, i) => _emitInlineTransitionCpp(t, i, cppEnumByStateId)).join('\n');
        const gBlocks = gates      .map((g, i) => _emitInlineGateCpp(g, i + transitions.length, cppEnumByStateId)).join('\n');

        const body = (tBlocks + (tBlocks && gBlocks ? '\n' : '') + gBlocks) ||
                     '            // Nothing wired to this trigger.';

        return `        case Trigger::${trg.cppEnum}: { // ${trg.name}
${body}
            break;
        }`;
    }

    function _emitInlineTransitionCpp(t, idx, m) {
        const src = 'State::' + m.get(t.from.id);
        const dst = 'State::' + m.get(t.to.id);
        const srcIdx = 'static_cast<std::size_t>(' + src + ')';
        const dstIdx = 'static_cast<std::size_t>(' + dst + ')';
        const selfLoop = (t.from.id === t.to.id);

        if (selfLoop) {
            return `            // Transition #${idx}: ${t.from.name} → ${t.to.name} (self-loop)
            {
                const auto& fa = attrs_of(${src});
                int final_ = snapshot_[${srcIdx}] - fa.input_cost + fa.output_yield;
                if (snapshot_[${srcIdx}] >= fa.input_cost &&
                    final_ <= fa.buffer_cap &&
                    marking_[${srcIdx}] >= fa.input_cost) {
                    int live_final = marking_[${srcIdx}] - fa.input_cost + fa.output_yield;
                    if (live_final <= fa.buffer_cap) {
                        marking_[${srcIdx}] = live_final;
                    }
                }
            }`;
        }

        return `            // Transition #${idx}: ${t.from.name} → ${t.to.name}
            {
                const auto& fa = attrs_of(${src});
                const auto& ta = attrs_of(${dst});
                if (snapshot_[${srcIdx}] >= fa.input_cost &&
                    snapshot_[${dstIdx}] + fa.output_yield <= ta.buffer_cap &&
                    marking_[${srcIdx}]  >= fa.input_cost &&
                    marking_[${dstIdx}]  + fa.output_yield <= ta.buffer_cap) {
                    marking_[${srcIdx}] -= fa.input_cost;
                    marking_[${dstIdx}] += fa.output_yield;
                }
            }`;
    }

    function _emitInlineGateCpp(g, idx, m) {
        if (g.type === 'SPLIT') {
            const src = 'State::' + m.get(g.source.id);
            const srcIdx = 'static_cast<std::size_t>(' + src + ')';
            const outsList = g.outputs.map(o => 'State::' + m.get(o.id)).join(', ');
            const outNames = g.outputs.map(o => o.name).join(', ');
            return `            // Gate #${idx}: SPLIT ${g.source.name} → [${outNames}]
            {
                const std::array<State, ${g.outputs.length}> splits = {{ ${outsList} }};
                const auto& sa = attrs_of(${src});
                int required = static_cast<int>(splits.size()) * sa.input_cost;
                bool snap_ok = snapshot_[${srcIdx}] >= required;
                for (auto out : splits) {
                    if (!snap_ok) break;
                    if (snapshot_[static_cast<std::size_t>(out)] + sa.output_yield > attrs_of(out).buffer_cap)
                        snap_ok = false;
                }
                if (snap_ok) {
                    bool live_ok = marking_[${srcIdx}] >= required;
                    for (auto out : splits) {
                        if (!live_ok) break;
                        if (marking_[static_cast<std::size_t>(out)] + sa.output_yield > attrs_of(out).buffer_cap)
                            live_ok = false;
                    }
                    if (live_ok) {
                        marking_[${srcIdx}] -= required;
                        for (auto out : splits) marking_[static_cast<std::size_t>(out)] += sa.output_yield;
                    }
                }
            }`;
        }

        const ins   = g.inputs.map(i => 'State::' + m.get(i.id)).join(', ');
        const dst   = 'State::' + m.get(g.to.id);
        const dstIdx = 'static_cast<std::size_t>(' + dst + ')';
        const inNames = g.inputs.map(i => i.name).join(', ');

        if (g.type === 'AND') {
            return `            // Gate #${idx}: AND [${inNames}] → ${g.to.name}
            {
                const std::array<State, ${g.inputs.length}> ins = {{ ${ins} }};
                int total_yield = 0;
                bool ok = true;
                for (auto in : ins) {
                    if (snapshot_[static_cast<std::size_t>(in)] < attrs_of(in).input_cost) { ok = false; break; }
                    total_yield += attrs_of(in).output_yield;
                }
                if (ok && snapshot_[${dstIdx}] + total_yield > attrs_of(${dst}).buffer_cap) ok = false;
                if (ok) {
                    bool live_ok = true;
                    for (auto in : ins) {
                        if (marking_[static_cast<std::size_t>(in)] < attrs_of(in).input_cost) { live_ok = false; break; }
                    }
                    if (live_ok && marking_[${dstIdx}] + total_yield <= attrs_of(${dst}).buffer_cap) {
                        for (auto in : ins) marking_[static_cast<std::size_t>(in)] -= attrs_of(in).input_cost;
                        marking_[${dstIdx}] += total_yield;
                    }
                }
            }`;
        }

        if (g.type === 'OR') {
            return `            // Gate #${idx}: OR [${inNames}] → ${g.to.name}
            {
                const std::array<State, ${g.inputs.length}> ins = {{ ${ins} }};
                int chosen = -1, y = 0;
                for (std::size_t i = 0; i < ins.size(); ++i) {
                    State in = ins[i];
                    if (snapshot_[static_cast<std::size_t>(in)] >= attrs_of(in).input_cost) {
                        int yy = attrs_of(in).output_yield;
                        if (snapshot_[${dstIdx}] + yy <= attrs_of(${dst}).buffer_cap) {
                            chosen = static_cast<int>(i); y = yy; break;
                        }
                    }
                }
                if (chosen >= 0) {
                    State in = ins[static_cast<std::size_t>(chosen)];
                    int cost = attrs_of(in).input_cost;
                    if (marking_[static_cast<std::size_t>(in)] >= cost &&
                        marking_[${dstIdx}] + y <= attrs_of(${dst}).buffer_cap) {
                        marking_[static_cast<std::size_t>(in)] -= cost;
                        marking_[${dstIdx}] += y;
                    }
                }
            }`;
        }

        // XOR
        return `            // Gate #${idx}: XOR [${inNames}] → ${g.to.name}
            {
                const std::array<State, ${g.inputs.length}> ins = {{ ${ins} }};
                int chosen = -1, count = 0;
                for (std::size_t i = 0; i < ins.size(); ++i) {
                    State in = ins[i];
                    if (snapshot_[static_cast<std::size_t>(in)] >= attrs_of(in).input_cost) {
                        chosen = static_cast<int>(i); ++count;
                    }
                }
                if (count == 1) {
                    State in = ins[static_cast<std::size_t>(chosen)];
                    int y = attrs_of(in).output_yield;
                    if (snapshot_[${dstIdx}] + y <= attrs_of(${dst}).buffer_cap) {
                        int cost = attrs_of(in).input_cost;
                        if (marking_[static_cast<std::size_t>(in)] >= cost &&
                            marking_[${dstIdx}] + y <= attrs_of(${dst}).buffer_cap) {
                            marking_[static_cast<std::size_t>(in)] -= cost;
                            marking_[${dstIdx}] += y;
                        }
                    }
                }
            }`;
    }

    /* ============================================================
       OOP PATTERN — one class per state
       Header declares:
         - sm::IState base (virtual execute(), virtual name())
         - sm::IdleState, sm::RunningState, ... (one per state)
         - sm::StateMachine with install() and execute_current()
       The user inherits from a per-state class to provide execute()
       logic, then installs via machine.install(State::Idle, std::make_unique<MyIdle>()).
       ============================================================ */

    function _emitHeaderOop(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const stateEnum = cpp.states.map(s =>
            '    ' + emit.pad(s.cppEnum + ',', 22) + '// ' + s.name
        ).join('\n');

        const trigEnum = cpp.triggers.length
            ? cpp.triggers.map(t =>
                '    ' + emit.pad(t.cppEnum + ',', 22) + '// ' + t.name +
                (t.kind === 'timer' ? ' (timer)' : '')
              ).join('\n')
            : '    // No triggers defined.';

        const stateClasses = cpp.states.map(s =>
`class ${s.cppClass} : public IState {
public:
    void execute() override;                       // default: no-op (override in user subclass)
    std::string_view name() const override { return "${s.name.replace(/"/g, '\\"')}"; }
    State id() const override { return State::${s.cppEnum}; }
};`
        ).join('\n\n');

        const fireDecls = cpp.triggers.length
            ? cpp.triggers.map(t => '    void ' + t.fnName + '();').join('\n')
            : '    // No per-trigger functions: no triggers were defined.';

        const meta = [
            'Machine:    ' + ir.name,
            'Generated:  ' + ctx.stamp,
            'Pattern:    oop — one class per state, virtual execute()',
            'States:     ' + ir.states.length + '   Transitions: ' + ir.transitions.length +
                (ir.gates.length ? '   Gates: ' + ir.gates.length : ''),
            'Triggers:   ' + ir.triggers.length,
            '',
            'Do not edit by hand — regenerate from the .json.',
            'User subclasses live in your own .cpp file.'
        ];

        return emit.banner('state_machine.hpp  —  ' + ir.name, meta) + '\n' +
`#pragma once

#include <array>
#include <cstddef>
#include <memory>
#include <string_view>

namespace sm {

${emit.section('States')}

enum class State : int {
${stateEnum}
    Count,
    Invalid = -1
};

constexpr std::size_t kStateCount = static_cast<std::size_t>(State::Count);

${emit.section('Triggers')}

enum class Trigger : int {
${trigEnum}
};

${emit.section('IState — base for per-state behaviour')}

class IState {
public:
    virtual ~IState() = default;
    virtual void execute() = 0;                    // override in user subclasses
    virtual std::string_view name() const = 0;
    virtual State id() const = 0;
};

${emit.section('Per-state classes — inherit from these in your code')}

${stateClasses}

${emit.section('StateMachine — public API')}

class StateMachine {
public:
    StateMachine();

    void reset();

    // Petri-net accessors.
    int tokens_in(State s) const;
    int total_tokens() const;

    // FSM accessors.
    State   current_state() const;                 // State::Invalid if non-singleton
    IState* current_state_obj();                   // nullptr if non-singleton

    // Install a user subclass for any state. Replaces the default.
    void install(State which, std::unique_ptr<IState> state);

    // Invokes the current state object's execute() if singleton.
    void execute_current();

    // Trigger dispatch.
    void fire(Trigger t);
    void fire(int trigger_id);

${fireDecls}

private:
    std::array<std::unique_ptr<IState>, kStateCount> states_;
    std::array<int, kStateCount>                     marking_{};
    std::array<int, kStateCount>                     snapshot_{};
};

} // namespace sm
`;
    }

    function _emitSourceOop(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const attrs = cpp.states.map(s =>
            '    /* ' + emit.pad(s.name + ' */', 18) +
            '{ ' + s.inputCost + ', ' + s.outputYield + ', ' +
                   s.bufferCap + ', ' + s.initialTokens + ' },'
        ).join('\n');

        // Default execute() bodies for the generated state classes — no-ops.
        const defaultExecutes = cpp.states.map(s =>
            'void ' + s.cppClass + '::execute() { /* default no-op — override in user subclass */ }'
        ).join('\n');

        const ctorInstall = cpp.states.map(s =>
            '    states_[static_cast<std::size_t>(State::' + s.cppEnum + ')] = std::make_unique<' + s.cppClass + '>();'
        ).join('\n');

        const transitions = ctx.hasTransitions ? _emitTransitionsTableCpp(ctx) : '';
        const gates       = ctx.hasGates       ? _emitGatesTableCpp(ctx)       : '';
        const fireImpl    = _emitFireDispatchCpp(ctx);

        const perTrigger = cpp.triggers.length
            ? cpp.triggers.map(t =>
                'void StateMachine::' + t.fnName + '() { fire(Trigger::' + t.cppEnum + '); }'
              ).join('\n')
            : '// No per-trigger functions.';

        const meta = [
            'Machine:    ' + ir.name,
            'Pattern:    oop — one class per state',
            'Generated:  ' + ctx.stamp
        ];

        return emit.banner('state_machine.cpp  —  ' + ir.name, meta) + '\n\n' +
`#include "state_machine.hpp"
#include <utility>

namespace sm {

namespace {

${emit.section('State attributes — indexed by State')}

struct StateAttrs {
    int input_cost;
    int output_yield;
    int buffer_cap;
    int initial_tokens;
};

constexpr std::array<StateAttrs, kStateCount> kStateAttrs = {{
${attrs}
}};

inline const StateAttrs& attrs_of(State s) {
    return kStateAttrs[static_cast<std::size_t>(s)];
}

${transitions}
${gates}
} // anonymous namespace

${emit.section('Default state-class execute() bodies (no-ops)')}

${defaultExecutes}

${emit.section('Lifecycle')}

StateMachine::StateMachine() {
${ctorInstall}
    reset();
}

void StateMachine::reset() {
    for (std::size_t i = 0; i < kStateCount; ++i) {
        marking_[i] = kStateAttrs[i].initial_tokens;
    }
}

${emit.section('Accessors')}

int StateMachine::tokens_in(State s) const {
    const int i = static_cast<int>(s);
    if (i < 0 || i >= static_cast<int>(kStateCount)) return 0;
    return marking_[static_cast<std::size_t>(i)];
}

int StateMachine::total_tokens() const {
    int sum = 0;
    for (int v : marking_) sum += v;
    return sum;
}

State StateMachine::current_state() const {
    State found = State::Invalid;
    int count = 0;
    for (std::size_t i = 0; i < kStateCount; ++i) {
        if (marking_[i] > 0) { found = static_cast<State>(i); ++count; }
    }
    return count == 1 ? found : State::Invalid;
}

IState* StateMachine::current_state_obj() {
    State s = current_state();
    if (s == State::Invalid) return nullptr;
    return states_[static_cast<std::size_t>(s)].get();
}

void StateMachine::install(State which, std::unique_ptr<IState> state) {
    const int i = static_cast<int>(which);
    if (i < 0 || i >= static_cast<int>(kStateCount)) return;
    states_[static_cast<std::size_t>(i)] = std::move(state);
}

void StateMachine::execute_current() {
    if (IState* s = current_state_obj()) s->execute();
}

${fireImpl}

${emit.section('Per-trigger wrappers')}

${perTrigger}

} // namespace sm
`;
    }

    /* ============================================================
       Example main.cpp — table / switch patterns
       ============================================================ */

    function _emitExampleMain(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const stateNames = cpp.states.map(s =>
            '    /* State::' + emit.pad(s.cppEnum + ' */', 18) + '"' + s.name.replace(/"/g, '\\"') + '",'
        ).join('\n');

        const setHandlers = cpp.states.map(s =>
            '    machine.set_handler(sm::State::' + s.cppEnum +
            ', []{ std::cout << "  → handler: ' + s.name.replace(/"/g, '\\"') + '\\n"; });'
        ).join('\n');

        const fireSequence = cpp.triggers.length
            ? cpp.triggers.slice(0, 3).map(t =>
                `    std::cout << "\\nFire ${t.name.replace(/"/g, '\\"')}:\\n";\n    machine.${t.fnName}();\n    print(machine);`
              ).join('\n')
            : '    std::cout << "\\n(No triggers defined — nothing to fire.)\\n";';

        return `// main.cpp — example driver for ${ir.name}.
// Lambdas are registered as state handlers. Replace with your own logic.

#include "state_machine.hpp"
#include <iostream>

namespace {

constexpr std::array<std::string_view, sm::kStateCount> kStateNames = {{
${stateNames}
}};

void print(sm::StateMachine& machine) {
    std::cout << "  Marking: ";
    for (std::size_t i = 0; i < sm::kStateCount; ++i) {
        std::cout << kStateNames[i] << "=" << machine.tokens_in(static_cast<sm::State>(i)) << " ";
    }
    sm::State cs = machine.current_state();
    if (cs == sm::State::Invalid) {
        std::cout << "(current: invalid — not singleton)\\n";
    } else {
        std::cout << "(current: " << kStateNames[static_cast<std::size_t>(cs)] << ")\\n";
        machine.execute_current();
    }
}

} // anonymous namespace

int main() {
    sm::StateMachine machine;

${setHandlers}

    std::cout << "Initial:\\n";
    print(machine);

${fireSequence}

    return 0;
}
`;
    }

    /* ============================================================
       Example main.cpp — OOP pattern
       Shows user-side subclassing of generated state classes.
       ============================================================ */

    function _emitExampleMainOop(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const userSubclasses = cpp.states.map(s =>
`class My${s.cppClass} : public sm::${s.cppClass} {
public:
    void execute() override { std::cout << "  → handler: ${s.name.replace(/"/g, '\\"')}\\n"; }
};`
        ).join('\n\n');

        const installs = cpp.states.map(s =>
            '    machine.install(sm::State::' + s.cppEnum + ', std::make_unique<My' + s.cppClass + '>());'
        ).join('\n');

        const stateNames = cpp.states.map(s =>
            '    /* State::' + emit.pad(s.cppEnum + ' */', 18) + '"' + s.name.replace(/"/g, '\\"') + '",'
        ).join('\n');

        const fireSequence = cpp.triggers.length
            ? cpp.triggers.slice(0, 3).map(t =>
                `    std::cout << "\\nFire ${t.name.replace(/"/g, '\\"')}:\\n";\n    machine.${t.fnName}();\n    print(machine);`
              ).join('\n')
            : '    std::cout << "\\n(No triggers defined — nothing to fire.)\\n";';

        return `// main.cpp — OOP example for ${ir.name}.
// Inherits from the generated per-state classes to provide execute() logic.

#include "state_machine.hpp"
#include <iostream>
#include <memory>

${emit.section('User state subclasses — your behaviour lives here')}

${userSubclasses}

namespace {

constexpr std::array<std::string_view, sm::kStateCount> kStateNames = {{
${stateNames}
}};

void print(sm::StateMachine& machine) {
    std::cout << "  Marking: ";
    for (std::size_t i = 0; i < sm::kStateCount; ++i) {
        std::cout << kStateNames[i] << "=" << machine.tokens_in(static_cast<sm::State>(i)) << " ";
    }
    sm::State cs = machine.current_state();
    if (cs == sm::State::Invalid) {
        std::cout << "(current: invalid — not singleton)\\n";
    } else {
        std::cout << "(current: " << kStateNames[static_cast<std::size_t>(cs)] << ")\\n";
        machine.execute_current();
    }
}

} // anonymous namespace

int main() {
    sm::StateMachine machine;

${installs}

    std::cout << "Initial:\\n";
    print(machine);

${fireSequence}

    return 0;
}
`;
    }

    /* ============================================================
       Makefile + README
       ============================================================ */

    function _emitMakefile(ctx) {
        return `# Makefile — generated by Machine Studio
CXX      = g++
CXXFLAGS = -Wall -Wextra -std=c++17 -O2
TARGET   = state_machine

$(TARGET): state_machine.cpp main.cpp state_machine.hpp
\t$(CXX) $(CXXFLAGS) -o $@ state_machine.cpp main.cpp

run: $(TARGET)
\t./$(TARGET)

clean:
\trm -f $(TARGET)

.PHONY: run clean
`;
    }

    function _patternBlurb(p) {
        if (p === 'table')  return 'data tables + std::function handlers';
        if (p === 'switch') return 'single switch over trigger ids';
        return 'one class per state, virtual execute()';
    }

    function _emitReadme(ctx) {
        const ir  = ctx.ir;
        const cpp = ctx.cpp;

        const sanitizeRows = ir.sanitizeMap.map(m =>
            '| ' + m.original.replace(/\|/g, '\\|') + ' | `' + m.generated + '` |'
        ).join('\n') || '| _no entities_ | |';

        const warnings = (ir.warnings && ir.warnings.length)
            ? '\n## ⚠ Warnings during generation\n\n' +
              ir.warnings.map(w => '- ' + w).join('\n') + '\n'
            : '';

        const apiExample = ctx.opts.pattern === 'oop' ? `
\`\`\`cpp
#include "state_machine.hpp"

class MyIdle : public sm::${cpp.states[0].cppClass} {
public:
    void execute() override { /* your logic */ }
};

int main() {
    sm::StateMachine machine;
    machine.install(sm::State::${cpp.states[0].cppEnum}, std::make_unique<MyIdle>());
    ${cpp.triggers.length ? 'machine.' + cpp.triggers[0].fnName + '();' : '/* fire triggers... */'}
    machine.execute_current();
}
\`\`\`
` : `
\`\`\`cpp
#include "state_machine.hpp"

int main() {
    sm::StateMachine machine;
    machine.set_handler(sm::State::${cpp.states[0].cppEnum}, []{ /* your logic */ });
    ${cpp.triggers.length ? 'machine.' + cpp.triggers[0].fnName + '();' : '/* fire triggers... */'}
    machine.execute_current();
}
\`\`\`
`;

        return `# ${ir.name} — Generated C++ State Machine

Generated by **Machine Studio** on ${ctx.stamp}.
Pattern: **${ctx.opts.pattern}** — ${_patternBlurb(ctx.opts.pattern)}.
Target standard: **C++17**.

## Files

| File | Purpose |
|------|---------|
| \`state_machine.hpp\` | Public API: \`sm::State\`, \`sm::Trigger\`, \`sm::StateMachine\`${ctx.opts.pattern === 'oop' ? ', `sm::IState`, per-state classes' : ''} |
| \`state_machine.cpp\` | Firing engine, state attributes, ${ctx.hasGates ? 'gate logic, ' : ''}two-phase step semantics |
| \`main.cpp\` | Example driver with stub handlers |
| \`Makefile\` | Build target (\`g++ -std=c++17\`) |

## Build & run

\`\`\`sh
make
make run
\`\`\`

## API
${apiExample}

## State handlers — how you plug in behaviour

${ctx.opts.pattern === 'oop' ? `In the OOP pattern, each state has a corresponding class declared in
\`state_machine.hpp\` (e.g. \`sm::${cpp.states[0].cppClass}\`). You inherit
from it in your own code and override \`execute()\`, then install your
subclass into the machine:

\`\`\`cpp
class MyState : public sm::${cpp.states[0].cppClass} {
public:
    void execute() override { /* your logic */ }
};
machine.install(sm::State::${cpp.states[0].cppEnum}, std::make_unique<MyState>());
\`\`\`

Generated default \`execute()\` bodies are empty — they live in
\`state_machine.cpp\` and are only invoked when you haven't installed
your own subclass.` :
`Per-state behaviour is registered as a \`std::function<void()>\`:

\`\`\`cpp
machine.set_handler(sm::State::${cpp.states[0].cppEnum}, []{
    /* your logic */
});
machine.execute_current();   // invokes the singleton-state handler
\`\`\``}

## Petri-net vs FSM semantics

\`sm::StateMachine\` is a Petri net under the hood: states hold token
counts and triggers fire transitions that move tokens around. Two
accessor styles are provided:

- **Petri-net** (\`tokens_in\`, \`total_tokens\`) always works.
- **FSM** (\`current_state\`, ${ctx.opts.pattern === 'oop' ? '`current_state_obj`, ' : ''}\`execute_current\`) is a convenience
  for single-token machines — \`current_state()\` returns \`State::Invalid\`
  when the marking holds zero or more than one token.

If the machine uses SPLIT or concurrent branches, expect
\`State::Invalid\` after the split — use \`tokens_in\` in that case.

## Identifier sanitization

| Original | Generated |
|----------|-----------|
${sanitizeRows}
${warnings}
## Regeneration

Re-export from Machine Studio to overwrite \`state_machine.hpp\`/\`.cpp\`.
Your user code (subclasses, handlers, integration) stays in your own
\`.cpp\` files and is preserved across regenerations.
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
