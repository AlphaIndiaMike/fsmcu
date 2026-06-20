/**
 * catalog.js
 * Machine Studio [MS] — Left-pane Catalog.
 *
 * Mode-aware list of "add" buttons grouped by category. The actual
 * create flow lives in main.js / dialogs.js — this module just renders
 * the buttons for the active mode and routes clicks through one
 * callback.
 *
 *   FSM   — states, transitions, triggers, groups. No Petri gates: a
 *           finite-state machine has no AND/OR/XOR/SPLIT token logic.
 *   PETRI — everything above PLUS the four logic gates.
 *
 * Public:
 *   catalog.render(containerId, onPick, mode)
 *     onPick(kind)   kind ∈
 *       'state', 'transition',
 *       'trigger-manual', 'trigger-timer',
 *       'group',
 *       'gate-AND', 'gate-OR', 'gate-XOR', 'gate-SPLIT'   (Petri only)
 *   catalog.setMode(mode)      — re-render for 'FSM' | 'PETRI'
 *   catalog.setEnabled(bool)   — disable in sim mode
 *
 * Depends on: fmt.js
 */

const catalog = (() => {

    /* Shared building blocks, present in both formalisms. */
    const COMMON = [
        { group: 'Building blocks', items: [
            { kind: 'state',          icon: '◯',  label: 'Add State',          hint: 'A node the machine can be in.' },
            { kind: 'transition',     icon: '→',  label: 'Add Transition',     hint: 'Connect two states with a trigger.' }
        ]},
        { group: 'Triggers', items: [
            { kind: 'trigger-manual', icon: '▶',  label: 'Add Manual Trigger', hint: 'A button you press to advance.' },
            { kind: 'trigger-timer',  icon: '⏱',  label: 'Add Timer Trigger',  hint: 'Fires every N seconds.' }
        ]},
        { group: 'Organize', items: [
            { kind: 'group',          icon: '▭',  label: 'Add Group',          hint: 'A labelled boundary that bundles related states.' }
        ]}
    ];

    /* Petri-only logic gates. */
    const GATES = { group: 'Logic gates', items: [
        { kind: 'gate-AND',   icon: '∧',  label: 'AND',   hint: 'Fires when every input has tokens.' },
        { kind: 'gate-OR',    icon: '∨',  label: 'OR',    hint: 'Fires when any input has tokens.' },
        { kind: 'gate-XOR',   icon: '⊕',  label: 'XOR',   hint: 'Fires only when exactly one input has tokens.' },
        { kind: 'gate-SPLIT', icon: '⇉',  label: 'SPLIT', hint: 'One source fans out atomically to many destinations.' }
    ]};

    /* Build the section list for a mode. Gates sit between Triggers and
       Organize so the layout reads blocks → triggers → gates → organize. */
    function _sectionsFor(mode) {
        if (mode === 'PETRI') {
            return [COMMON[0], COMMON[1], GATES, COMMON[2]];
        }
        return [COMMON[0], COMMON[1], COMMON[2]];
    }

    let enabled    = true;
    let _container = null;
    let _onPick    = null;
    let _mode      = 'PETRI';

    function render(containerId, onPick, mode) {
        _container = containerId;
        _onPick    = onPick;
        if (mode) _mode = (mode === 'FSM') ? 'FSM' : 'PETRI';
        _paint();
    }

    function _paint() {
        const root = document.getElementById(_container);
        if (!root) return;
        let html = '';
        _sectionsFor(_mode).forEach(group => {
            html += `<div class="cat-group">${fmt.escHtml(group.group)}</div>`;
            group.items.forEach(it => {
                html += `
                    <button class="cat-item${enabled ? '' : ' disabled'}" data-kind="${it.kind}" title="${fmt.escHtml(it.hint)}">
                        <span class="cat-icon">${it.icon}</span>
                        <span class="cat-label">${fmt.escHtml(it.label)}</span>
                    </button>`;
            });
        });
        root.innerHTML = html;
        root.querySelectorAll('.cat-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!enabled) return;
                if (_onPick) _onPick(btn.getAttribute('data-kind'));
            });
        });
    }

    function setMode(mode) {
        _mode = (mode === 'FSM') ? 'FSM' : 'PETRI';
        _paint();
    }

    function setEnabled(on) {
        enabled = !!on;
        document.querySelectorAll('.cat-item').forEach(b => {
            if (enabled) b.classList.remove('disabled');
            else         b.classList.add('disabled');
        });
    }

    return { render, setMode, setEnabled };
})();
