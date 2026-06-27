/**
 * controls.js
 * Machine Studio [MS] — Right-pane Controls.
 *
 * Renders:
 *   · the simulation status message line
 *   · the trigger list (manual + timer, each with its own controls)
 *   · the global edit/sim controls
 *
 * Triggers row layout:
 *   Edit mode:
 *     [name]                        [✏ rename] [× delete]
 *     manual → "Manual trigger"
 *     timer  → "Timer · 5s · ↻ repeats"
 *   Sim mode:
 *     manual → [Trigger]
 *     timer  → [Start] [Stop] [Configure]
 *
 * Public:
 *   controls.init(containerId, callbacks)
 *   controls.render(machine)
 *   controls.setMode('edit' | 'sim')
 *   controls.setMessage(msg)
 *   controls.setTimerRunning(triggerId, bool)
 *
 * Depends on: fmt.js, machine.js (Machine type), simulator.js (for timer state probe)
 */

const controls = (() => {

    let root      = null;
    let cb        = {};
    let mode      = 'edit';
    let _machine  = null;

    function init(containerId, callbacks) {
        root = document.getElementById(containerId);
        cb   = callbacks || {};
        root.innerHTML = `
            <div class="ctrl-status" id="ctrlStatus">Edit mode.</div>

            <div class="ctrl-section">
                <div class="ctrl-section-hd">Triggers</div>
                <div id="ctrlTriggers" class="ctrl-triggers">
                    <div class="ctrl-empty">No triggers yet. Add one from the Catalog.</div>
                </div>
            </div>

            <div class="ctrl-section ctrl-section-foot">
                <div class="ctrl-section-hd">Simulation</div>
                <div class="ctrl-global">
                    <button class="btn btn-primary" id="btnSimStart">▶ Start Simulation</button>
                    <button class="btn btn-sec"     id="btnSimReset" style="display:none">↺ Reset</button>
                    <button class="btn btn-sec"     id="btnSimStop"  style="display:none">◀ Back to Edit</button>
                    <button class="btn btn-sec"     id="btnAutoLayout" title="Auto-arrange diagram (dagre)">⇄ Auto-arrange</button>
                </div>
            </div>
        `;
        document.getElementById('btnSimStart').addEventListener('click',  () => cb.onStartSim && cb.onStartSim());
        document.getElementById('btnSimReset').addEventListener('click',  () => cb.onResetSim && cb.onResetSim());
        document.getElementById('btnSimStop').addEventListener('click',   () => cb.onStopSim && cb.onStopSim());
        document.getElementById('btnAutoLayout').addEventListener('click', () => cb.onAutoLayout && cb.onAutoLayout());
    }

    function render(machine) {
        _machine = machine;
        const list = document.getElementById('ctrlTriggers');
        if (!machine || machine.triggers.length === 0) {
            list.innerHTML = '<div class="ctrl-empty">No triggers yet. Add one from the Catalog.</div>';
            return;
        }
        let html = '';
        machine.triggers.forEach(t => {
            html += _triggerRow(t);
        });
        list.innerHTML = html;
        _wireTriggerRow(list);
    }

    function _triggerRow(t) {
        const running = (typeof simulator !== 'undefined') &&
                        simulator.isTimerRunning && simulator.isTimerRunning(t.id);

        const head = `
            <div class="trg-top">
                <span class="trg-kind">${t.kind === 'timer' ? '⏱' : '▶'}</span>
                <span class="trg-name" title="${fmt.escHtml(t.name)}">${fmt.escHtml(t.name)}</span>
                <span class="trg-edit-actions">
                    <button class="btn-mini trg-edit" data-id="${t.id}" title="Rename / edit">✏</button>
                    <button class="btn-mini trg-del"  data-id="${t.id}" title="Delete">×</button>
                </span>
            </div>`;

        let meta = '';
        if (t.kind === 'timer') {
            meta = `<div class="trg-meta">Timer · every ${t.period}s` +
                   (t.initialDelay ? ` · delay ${t.initialDelay}s` : '') +
                   (t.oneShot      ? ' · one-shot' : ' · repeats') +
                   `</div>`;
        } else {
            meta = `<div class="trg-meta">Manual trigger</div>`;
        }

        const actions = mode === 'sim' ? _triggerSimActions(t, running) : '';

        return `<div class="trg-row" data-id="${t.id}">${head}${meta}${actions}</div>`;
    }

    function _triggerSimActions(t, running) {
        if (t.kind === 'manual') {
            return `
                <div class="trg-actions">
                    <button class="btn btn-primary trg-fire" data-id="${t.id}">Trigger</button>
                </div>`;
        }
        const startDisabled = running ? 'disabled' : '';
        const stopDisabled  = running ? '' : 'disabled';
        return `
            <div class="trg-actions">
                <button class="btn btn-primary trg-start" data-id="${t.id}" ${startDisabled}>Start</button>
                <button class="btn btn-sec     trg-stop"  data-id="${t.id}" ${stopDisabled}>Stop</button>
                <button class="btn btn-sec     trg-cfg"   data-id="${t.id}">Configure</button>
                <span class="trg-running" ${running ? '' : 'style="display:none"'}>● running</span>
            </div>`;
    }

    function _wireTriggerRow(list) {
        list.querySelectorAll('.trg-edit').forEach(b =>
            b.addEventListener('click', () => cb.onEditTrigger && cb.onEditTrigger(b.getAttribute('data-id'))));
        list.querySelectorAll('.trg-del').forEach(b =>
            b.addEventListener('click', () => cb.onDeleteTrigger && cb.onDeleteTrigger(b.getAttribute('data-id'))));
        list.querySelectorAll('.trg-fire').forEach(b =>
            b.addEventListener('click', () => cb.onFireManual && cb.onFireManual(b.getAttribute('data-id'))));
        list.querySelectorAll('.trg-start').forEach(b =>
            b.addEventListener('click', () => cb.onStartTimer && cb.onStartTimer(b.getAttribute('data-id'))));
        list.querySelectorAll('.trg-stop').forEach(b =>
            b.addEventListener('click', () => cb.onStopTimer && cb.onStopTimer(b.getAttribute('data-id'))));
        list.querySelectorAll('.trg-cfg').forEach(b =>
            b.addEventListener('click', () => cb.onConfigureTimer && cb.onConfigureTimer(b.getAttribute('data-id'))));
    }

    function setMode(m) {
        mode = m;
        const start = document.getElementById('btnSimStart');
        const reset = document.getElementById('btnSimReset');
        const stop  = document.getElementById('btnSimStop');
        const auto  = document.getElementById('btnAutoLayout');
        if (m === 'sim') {
            start.style.display = 'none';
            reset.style.display = '';
            stop.style.display  = '';
            auto.style.display  = 'none';
        } else {
            start.style.display = '';
            reset.style.display = 'none';
            stop.style.display  = 'none';
            auto.style.display  = '';
        }
        if (_machine) render(_machine);
    }

    function setMessage(msg) {
        const el = document.getElementById('ctrlStatus');
        if (!el) return;
        if (!msg) {
            el.textContent = mode === 'sim'
                ? 'Simulation ready.'
                : 'Edit mode.';
            el.classList.remove('msg-ended');
        } else {
            el.textContent = msg;
            if (msg.indexOf('ended') !== -1) el.classList.add('msg-ended');
            else                              el.classList.remove('msg-ended');
        }
    }

    function setTimerRunning(triggerId, isRunning) {
        // Cheapest correct path: re-render the whole list. The list
        // is tiny so this stays imperceptible.
        if (_machine) render(_machine);
    }

    return { init, render, setMode, setMessage, setTimerRunning };
})();
