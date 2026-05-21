/**
 * catalog.js
 * Machine Studio [MS] — Left-pane Catalog.
 *
 * Static list of "add" buttons grouped by category. The actual
 * create flow lives in main.js / dialogs.js — this module just
 * renders the buttons and routes clicks through one callback.
 *
 * Public:
 *   catalog.render(containerId, onPick)
 *     onPick(kind)   kind ∈
 *       'state', 'transition',
 *       'trigger-manual', 'trigger-timer',
 *       'gate-AND', 'gate-OR', 'gate-XOR'
 *   catalog.setEnabled(bool)   — disable in sim mode
 *
 * Depends on: fmt.js
 */

const catalog = (() => {

    const ITEMS = [
        { group: 'Building blocks', items: [
            { kind: 'state',          icon: '◯',  label: 'Add State',         hint: 'A petri-net place — holds tokens.' },
            { kind: 'transition',     icon: '→',  label: 'Add Transition',    hint: 'Connect two states with a trigger.' }
        ]},
        { group: 'Triggers', items: [
            { kind: 'trigger-manual', icon: '▶',  label: 'Add Manual Trigger', hint: 'A button you press to advance.' },
            { kind: 'trigger-timer',  icon: '⏱',  label: 'Add Timer Trigger',  hint: 'Fires every N seconds.' }
        ]},
        { group: 'Logic gates', items: [
            { kind: 'gate-AND',   icon: '∧',  label: 'AND',   hint: 'Fires when every input has tokens.' },
            { kind: 'gate-OR',    icon: '∨',  label: 'OR',    hint: 'Fires when any input has tokens.' },
            { kind: 'gate-XOR',   icon: '⊕',  label: 'XOR',   hint: 'Fires only when exactly one input has tokens.' },
            { kind: 'gate-SPLIT', icon: '⇉',  label: 'SPLIT', hint: 'One source fans out atomically to many destinations.' }
        ]}
    ];

    let enabled = true;

    function render(containerId, onPick) {
        const root = document.getElementById(containerId);
        if (!root) return;
        let html = '';
        ITEMS.forEach(group => {
            html += `<div class="cat-group">${fmt.escHtml(group.group)}</div>`;
            group.items.forEach(it => {
                html += `
                    <button class="cat-item" data-kind="${it.kind}" title="${fmt.escHtml(it.hint)}">
                        <span class="cat-icon">${it.icon}</span>
                        <span class="cat-label">${fmt.escHtml(it.label)}</span>
                    </button>`;
            });
        });
        root.innerHTML = html;
        root.querySelectorAll('.cat-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!enabled) return;
                if (onPick) onPick(btn.getAttribute('data-kind'));
            });
        });
    }

    function setEnabled(on) {
        enabled = !!on;
        document.querySelectorAll('.cat-item').forEach(b => {
            if (enabled) b.classList.remove('disabled');
            else         b.classList.add('disabled');
        });
    }

    return { render, setEnabled };
})();
