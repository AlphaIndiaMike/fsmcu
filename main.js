/**
 * main.js
 * Machine Studio [MS] — Application orchestrator.
 *
 * Wires Machine, simulator, canvas, catalog, controls and dialogs.
 * Owns the single render cycle, the edit↔sim mode flag, file I/O
 * and the responsive drawer behaviour. Exposes a small `main`
 * surface to the HTML onclick attributes.
 *
 * Depends on: every other JS module in this folder.
 */

const main = (() => {

    let machine = null;
    let mode    = 'edit';     // 'edit' | 'sim'

    /* ── init ─────────────────────────────────────────────────────── */

    function init() {
        // Cytoscape canvas
        canvas.init('cyCanvas', {
            onStateClick:      _onStateClick,
            onGateClick:       _onGateClick,
            onTransitionClick: _onTransitionClick,
            onPositionChange:  _onPositionChange
        });

        // Catalog (left pane)
        catalog.render('catalogList', _onCatalogPick);

        // Controls (right pane)
        controls.init('controlsPane', {
            onStartSim:       _startSim,
            onResetSim:       _resetSim,
            onStopSim:        _stopSim,
            onAutoLayout:     () => { canvas.autoLayout(); setTimeout(canvas.fit, 380); },
            onFireManual:     _onFireManual,
            onStartTimer:     _onStartTimer,
            onStopTimer:      _onStopTimer,
            onConfigureTimer: tid => dialogs.openTimerConfig(tid),
            onEditTrigger:    tid => dialogs.openTriggerEdit(tid),
            onDeleteTrigger:  _onDeleteTrigger
        });

        // Simulator (callbacks update canvas + controls)
        simulator.init({
            onStatusChange: statuses => canvas.applyStatuses(statuses),
            onSimMessage:   msg      => controls.setMessage(msg)
        });

        // Dialogs (model mutators)
        dialogs.init({
            getMachine:              () => machine,
            applyStateUpdate:        _applyStateUpdate,
            applyStateDelete:        _applyStateDelete,
            applyTransitionUpdate:   (id, p) => { machine.updateTransition(id, p); _refresh(); },
            applyTransitionCreate:   (data)  => { machine.addTransition(data);     _refresh(); },
            applyTransitionDelete:   (id)    => { machine.deleteTransition(id);    _refresh(); },
            applyGateUpdate:         (id, p) => { machine.updateGate(id, p);       _refresh(); },
            applyGateCreate:         (data)  => { machine.addGate(data);           _refresh(); },
            applyGateDelete:         (id)    => { machine.deleteGate(id);          _refresh(); },
            applyTriggerUpdate:      (id, p) => { machine.updateTrigger(id, p);    _refresh(); },
            applyTriggerCreate:      (data)  => { machine.addTrigger(data);        _refresh(); },
            applyTriggerDelete:      (id)    => { machine.deleteTrigger(id);       _refresh(); }
        });

        _bindEvents();
        _showIntro();
    }

    function _bindEvents() {
        document.getElementById('fileInput')
            .addEventListener('change', _handleUpload);

        // Responsive drawers (collapse below 1000px)
        const lT = document.getElementById('drawerCatalog');
        const rT = document.getElementById('drawerControls');
        if (lT) lT.addEventListener('click', e => {
            e.stopPropagation();
            document.body.classList.toggle('show-catalog');
            document.body.classList.remove('show-controls');
        });
        if (rT) rT.addEventListener('click', e => {
            e.stopPropagation();
            document.body.classList.toggle('show-controls');
            document.body.classList.remove('show-catalog');
        });
        document.addEventListener('click', e => {
            const b = document.body;
            if (!b.classList.contains('show-catalog') &&
                !b.classList.contains('show-controls')) return;
            if (e.target.closest('.panel-left,.panel-right,.drawer-btn')) return;
            b.classList.remove('show-catalog', 'show-controls');
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape')
                document.body.classList.remove('show-catalog', 'show-controls');
        });
    }

    /* ── intro / studio screens ───────────────────────────────────── */

    function _showIntro() {
        document.getElementById('introScreen').style.display = 'flex';
        document.getElementById('studio').style.display      = 'none';
    }

    function _showStudio() {
        document.getElementById('introScreen').style.display = 'none';
        document.getElementById('studio').style.display      = 'flex';
        // Cytoscape needs a tick to measure now that the container is visible.
        setTimeout(() => { canvas.fit(); }, 0);
    }

    /* ── render cycle ─────────────────────────────────────────────── */

    function _refresh() {
        if (!machine) return;
        canvas.render(machine);
        controls.render(machine);
        _updateHeaderName();
    }

    function _updateHeaderName() {
        const el = document.getElementById('machineNamePill');
        if (!el) return;
        if (machine && machine.name) {
            el.textContent     = machine.name;
            el.style.display   = '';
        } else {
            el.style.display = 'none';
        }
    }

    /* ── catalog handlers ─────────────────────────────────────────── */

    function _onCatalogPick(kind) {
        if (mode !== 'edit' || !machine) return;
        switch (kind) {
            case 'state':
                _quickAddState();
                break;
            case 'transition':
                dialogs.openTransitionEdit(null);
                break;
            case 'trigger-manual':
                dialogs.openTriggerEdit(null, 'manual');
                break;
            case 'trigger-timer':
                dialogs.openTriggerEdit(null, 'timer');
                break;
            case 'gate-AND':
            case 'gate-OR':
            case 'gate-XOR':
            case 'gate-SPLIT':
                dialogs.openGateEdit(null, kind.replace('gate-', ''));
                break;
        }
    }

    function _quickAddState() {
        // If no start exists yet, this one becomes start.
        const kind = machine.startState() ? 'normal' : 'start';
        const s = machine.addState({ kind });
        _refresh();
        // Open the edit dialog so the user can rename / tune props.
        dialogs.openStateEdit(s.id);
    }

    /* ── canvas handlers ──────────────────────────────────────────── */

    function _onStateClick(id)      { if (mode === 'edit') dialogs.openStateEdit(id); }
    function _onGateClick(id)       { if (mode === 'edit') dialogs.openGateEdit(id, null); }
    function _onTransitionClick(id) { if (mode === 'edit') dialogs.openTransitionEdit(id); }

    function _onPositionChange(kind, id, x, y) {
        if (!machine) return;
        if (kind === 'state') machine.updateState(id, { x, y });
        if (kind === 'gate')  machine.updateGate(id,  { x, y });
        // No re-render needed — the visual is already at the new spot.
    }

    /* ── trigger handlers ─────────────────────────────────────────── */

    function _onFireManual(triggerId) {
        if (mode !== 'sim') return;
        simulator.fireTrigger(triggerId);
    }
    function _onStartTimer(triggerId) {
        if (mode !== 'sim') return;
        if (simulator.startTimer(triggerId)) controls.render(machine);
    }
    function _onStopTimer(triggerId) {
        if (mode !== 'sim') return;
        if (simulator.stopTimer(triggerId)) controls.render(machine);
    }
    function _onDeleteTrigger(triggerId) {
        if (mode !== 'edit') return;
        const t = machine.triggerById(triggerId);
        if (!t) return;
        dialogs.confirm('Delete trigger?',
            'Remove "' + t.name + '". Arrows/gates referencing it lose their trigger.',
            () => { machine.deleteTrigger(triggerId); _refresh(); });
    }

    /* ── state mutations (dialog → here) ──────────────────────────── */

    function _applyStateUpdate(id, patch) {
        machine.updateState(id, patch);
        _refresh();
    }
    function _applyStateDelete(id) {
        machine.deleteState(id);
        _refresh();
    }

    /* ── simulation lifecycle ─────────────────────────────────────── */

    function _startSim() {
        if (!machine) return;
        if (!machine.startState()) {
            dialogs.confirm('No start state',
                'Mark one state as kind = "start" before running the simulation. Open the state and pick "start" as its kind.',
                () => {});
            return;
        }
        mode = 'sim';
        canvas.setEditMode(false);
        catalog.setEnabled(false);
        controls.setMode('sim');
        // Render BEFORE seeding: canvas.render() builds fresh nodes
        // with st-idle classes, which would otherwise wipe the colours
        // simulator.startSim emits via onStatusChange.
        _refresh();
        simulator.startSim(machine);
    }

    function _resetSim() {
        if (mode !== 'sim') return;
        simulator.resetSim();
        controls.render(machine);
    }

    function _stopSim() {
        mode = 'edit';
        simulator.stopSim();
        canvas.setEditMode(true);
        canvas.resetVisuals();
        catalog.setEnabled(true);
        controls.setMode('edit');
        controls.setMessage('');
    }

    /* ── file I/O ─────────────────────────────────────────────────── */

    function newMachine() {
        // Guard against accidental clicks when there's unsaved work.
        const hasContent = machine &&
            (machine.states.length   > 0 ||
             machine.triggers.length > 0);

        if (hasContent) {
            dialogs.confirm('Discard current machine?',
                'You\'ll lose any unsaved changes to "' +
                (machine.name || 'this machine') +
                '". Use Save first if you want to keep it.',
                () => dialogs.openNewMachine(_proceedNewMachine));
            return;
        }
        dialogs.openNewMachine(_proceedNewMachine);
    }

    function _proceedNewMachine(name) {
        // Reset uid counters so a fresh machine restarts at s_1, t_1...
        fmt.resetUid();
        machine = new Machine(name || '');
        _activate();
    }

    function exportMachine() {
        if (!machine) return;
        dialogs.openExport();
    }

    function downloadMachine() {
        if (!machine) return;
        const json = JSON.stringify(machine.toJSON(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = (machine.name || 'machine').replace(/\s+/g, '_') + '.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    function triggerUpload() {
        document.getElementById('fileInput').click();
    }

    function _handleUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try {
                machine = Machine.fromJSON(JSON.parse(e.target.result));
                _activate();
            } catch (err) {
                alert('Could not load machine: ' + err.message);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    function _activate() {
        _showStudio();
        mode = 'edit';
        canvas.setEditMode(true);
        catalog.setEnabled(true);
        controls.setMode('edit');
        controls.setMessage('');
        _refresh();
        // Fit & auto-layout if positions are all zero (fresh load with
        // no positions set).
        const anyPositioned = machine.states.some(s => s.x || s.y);
        if (!anyPositioned && machine.states.length > 0) {
            setTimeout(() => { canvas.autoLayout(); }, 60);
        } else {
            setTimeout(() => { canvas.fit(); }, 60);
        }
    }

    return {
        init,
        newMachine, downloadMachine, triggerUpload, exportMachine
    };
})();

/* Bootstrapping. */
window.addEventListener('DOMContentLoaded', () => {
    if (typeof cytoscape === 'undefined') {
        document.body.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;
                justify-content:center;height:100vh;gap:1rem;
                font-family:'Outfit',sans-serif;color:#5b1814;
                background:#f3c1bd;text-align:center;padding:2rem;">
                <div style="font-size:1.1rem;font-weight:600;">Cytoscape not loaded</div>
                <div style="font-size:0.82rem;color:#555;max-width:520px;line-height:1.6;">
                    The diagram library is missing. Make sure
                    <code>lib/cytoscape.min.js</code>,
                    <code>lib/dagre.min.js</code> and
                    <code>lib/cytoscape-dagre.js</code>
                    are next to <code>index.html</code>.
                </div>
            </div>`;
        return;
    }
    main.init();
});
