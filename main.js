/**
 * main.js
 * Machine Studio [MS] — Application orchestrator.
 *
 * Wires Machine, simulator, canvas, catalog, controls and dialogs.
 * Owns the single render cycle, the edit↔sim interaction flag, the
 * FSM↔Petri formalism toggle, file I/O, the unsaved-changes guard and
 * the responsive drawer behaviour. Exposes a small `main` surface to
 * the HTML onclick attributes.
 *
 * Two orthogonal "modes" live here, kept deliberately distinct:
 *   · interaction mode — 'edit' | 'sim'  (local `mode` variable)
 *   · formalism        — 'FSM' | 'PETRI' (stored on machine.mode)
 *
 * Depends on: every other JS module in this folder.
 */

const main = (() => {

    let machine  = null;
    let mode     = 'edit';     // interaction: 'edit' | 'sim'
    let _unsaved = false;      // model changed since last save / load / new

    /* ── init ─────────────────────────────────────────────────────── */

    function init() {
        // Cytoscape canvas
        canvas.init('cyCanvas', {
            onStateClick:      _onStateClick,
            onGateClick:       _onGateClick,
            onTransitionClick: _onTransitionClick,
            onGroupClick:      _onGroupClick,
            onPositionChange:  _onPositionChange
        });

        // Catalog (left pane) — starts in Petri (the constructor default).
        catalog.render('catalogList', _onCatalogPick, 'PETRI');

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

        // Dialogs (model mutators). Every mutator marks the model dirty.
        dialogs.init({
            getMachine:              () => machine,
            getDiagramImage:         () => canvas.exportPngBase64({ scale: 2 }),
            applyStateUpdate:        _applyStateUpdate,
            applyStateDelete:        _applyStateDelete,
            applyTransitionUpdate:   (id, p) => { machine.updateTransition(id, p); _changed(); },
            applyTransitionCreate:   (data)  => { machine.addTransition(data);     _changed(); },
            applyTransitionDelete:   (id)    => { machine.deleteTransition(id);    _changed(); },
            applyGateUpdate:         (id, p) => { machine.updateGate(id, p);       _changed(); },
            applyGateCreate:         (data)  => { machine.addGate(data);           _changed(); },
            applyGateDelete:         (id)    => { machine.deleteGate(id);          _changed(); },
            applyGroupCreate:        _applyGroupCreate,
            applyGroupUpdate:        _applyGroupUpdate,
            applyGroupDelete:        (id)    => { machine.deleteGroup(id);         _changed(); },
            applyTriggerUpdate:      (id, p) => { machine.updateTrigger(id, p);    _changed(); },
            applyTriggerCreate:      (data)  => { machine.addTrigger(data);        _changed(); },
            applyTriggerDelete:      (id)    => { machine.deleteTrigger(id);       _changed(); }
        });

        _bindEvents();
        _bindModeToggle();
        _showVersion();
        _showIntro();

        // Guard against losing work on refresh / close. The browser shows
        // its own confirmation when we set returnValue; we only arm it
        // while there are unsaved changes, so a clean (just-saved) machine
        // closes without nagging.
        window.addEventListener('beforeunload', e => {
            if (!_unsaved) return;
            e.preventDefault();
            e.returnValue = '';   // required for the prompt to show in Chrome
            return '';
        });
    }

    function _bindEvents() {
        document.getElementById('fileInput')
            .addEventListener('change', _handleUpload);

        // Click the header name pill to rename the machine.
        const pill = document.getElementById('machineNamePill');
        if (pill) pill.addEventListener('click', e => {
            e.stopPropagation();
            _renameProject();
        });

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

    /* ── FSM / Petri formalism toggle (header) ───────────────────────── */

    function _bindModeToggle() {
        document.querySelectorAll('.mode-btn').forEach(b => {
            b.addEventListener('click', () => {
                if (b.classList.contains('disabled')) return;  // no machine yet
                _setFormalism(b.getAttribute('data-appmode'));
            });
        });
        _setModeButtonsEnabled(false);   // disabled until a machine exists
    }

    /* Enable/disable the FSM/Petri toggle. Before a machine exists there
       is nothing to switch, so the buttons are disabled with a tooltip. */
    function _setModeButtonsEnabled(on) {
        document.querySelectorAll('.mode-btn').forEach(b => {
            b.classList.toggle('disabled', !on);
            if (on) {
                b.title = b.getAttribute('data-tip') || '';
            } else {
                if (!b.getAttribute('data-tip')) b.setAttribute('data-tip', b.title);
                b.title = 'Start or open a machine first to choose a formalism.';
            }
        });
    }

    /* Switch the whole studio between FSM and Petri. The two models are
       independent — switching never migrates data, it just shows the
       other model and its tooling. Any running simulation is stopped
       first (you cannot simulate across a model switch). */
    function _setFormalism(target) {
        if (!machine) return;
        const want = (target === 'FSM') ? 'FSM' : 'PETRI';
        if (want === machine.mode) return;
        if (mode === 'sim') _stopSim();
        machine.setMode(want);
        _unsaved = true;             // the saved `mode` field now differs
        _syncFormalismUI(machine.mode);
        canvas.resetVisuals();
        _refresh();
        // If the model we just switched to has never been positioned
        // (e.g. the demo's other formalism, or a freshly emptied model),
        // arrange it once so nodes don't stack at the origin.
        const anyPositioned = machine.states.some(s => s.x || s.y);
        if (!anyPositioned && machine.states.length > 0) {
            setTimeout(() => { canvas.autoLayout(); }, 60);
        } else {
            setTimeout(() => { canvas.fit(); }, 60);
        }
    }

    /* Push the current formalism into the header toggle and the catalog.
       Used by the toggle and on machine load. */
    function _syncFormalismUI(m) {
        const cur = (m === 'FSM') ? 'FSM' : 'PETRI';
        document.querySelectorAll('.mode-btn').forEach(b =>
            b.classList.toggle('on', b.getAttribute('data-appmode') === cur));
        catalog.setMode(cur);
    }

    /* Stamp the tool version into the header badge. Sourced from CONFIG
       so the single bump per iteration propagates everywhere. */
    function _showVersion() {
        const el = document.getElementById('appVersion');
        if (el) el.textContent = 'v' + (CONFIG.appVersion || '?');
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

    /* A model edit happened: mark dirty and re-render. */
    function _changed() {
        _unsaved = true;
        _refresh();
    }

    function _updateHeaderName() {
        const el = document.getElementById('machineNamePill');
        if (!el) return;
        if (machine) {
            // Always show the pill while a machine is active. An untitled
            // machine reads "Untitled — click to name" so the rename
            // affordance is discoverable.
            const named = machine.name && machine.name.trim();
            el.textContent   = named ? machine.name : 'Untitled — click to name';
            el.classList.toggle('is-untitled', !named);
            el.title         = 'Click to rename this machine';
            el.style.display = '';
        } else {
            el.style.display = 'none';
        }
    }

    /* Rename the active machine. The name is the user's to decide; it
       drives the header label and the JSON download filename. */
    function _renameProject() {
        if (!machine) return;
        dialogs.openRename(machine.name || '', (name) => {
            machine.name = (name || '').trim();
            _updateHeaderName();
            _unsaved = true;
        });
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
            case 'group':
                dialogs.openGroupEdit(null);
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
        _changed();
        // Open the edit dialog so the user can rename / tune props.
        dialogs.openStateEdit(s.id);
    }

    /* ── canvas handlers ──────────────────────────────────────────── */

    function _onStateClick(id)      { if (mode === 'edit') dialogs.openStateEdit(id); }
    function _onGateClick(id)       { if (mode === 'edit') dialogs.openGateEdit(id, null); }
    function _onTransitionClick(id) { if (mode === 'edit') dialogs.openTransitionEdit(id); }
    function _onGroupClick(id)      { if (mode === 'edit') dialogs.openGroupEdit(id); }

    function _onPositionChange(kind, id, x, y) {
        if (!machine) return;
        if (kind === 'state') machine.updateState(id, { x, y });
        if (kind === 'gate')  machine.updateGate(id,  { x, y });
        if (kind === 'group') machine.updateGroup(id, { x, y });
        // Moving things is unsaved work worth guarding, but it doesn't
        // change topology so no re-render is needed.
        _unsaved = true;
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
            () => { machine.deleteTrigger(triggerId); _changed(); });
    }

    /* ── state mutations (dialog → here) ──────────────────────────── */

    function _applyStateUpdate(id, patch) {
        machine.updateState(id, patch);
        _changed();
    }
    function _applyStateDelete(id) {
        machine.deleteState(id);
        _changed();
    }

    /* ── group mutations ──────────────────────────────────────────── */

    function _applyGroupCreate(patch, members) {
        const g = machine.addGroup(patch);
        if (members) machine.setGroupMembers(g.id, members);
        _changed();
        return g.id;
    }
    function _applyGroupUpdate(id, patch, members) {
        machine.updateGroup(id, patch);
        if (members) machine.setGroupMembers(id, members);
        _changed();
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
        // Render BEFORE seeding: canvas.render() builds fresh nodes with
        // st-idle classes, which would otherwise wipe the colours
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
        // Guard against accidental clicks when there's unsaved work in
        // EITHER sub-model.
        const hasContent = machine &&
            (machine._models.FSM.states.length    > 0 ||
             machine._models.FSM.triggers.length  > 0 ||
             machine._models.PETRI.states.length  > 0 ||
             machine._models.PETRI.triggers.length > 0);

        if (hasContent) {
            dialogs.confirm('Discard current machine?',
                'You\'ll lose any unsaved changes to "' +
                (machine.name || 'this machine') +
                '". Use Save first if you want to keep it.',
                () => dialogs.openNewMachine(_proceedNewMachine, _proceedDemo));
            return;
        }
        dialogs.openNewMachine(_proceedNewMachine, _proceedDemo);
    }

    function _proceedNewMachine(name, formalism) {
        // Reset uid counters so a fresh machine restarts at s_1, t_1...
        fmt.resetUid();
        machine = new Machine(name || '', formalism === 'FSM' ? 'FSM' : 'PETRI');
        _activate();
    }

    /* Demo: build BOTH a Petri net and an FSM in one machine (no
       formalism question) so the user can switch from the header and
       compare the two formalisms side by side. Opens in Petri — the
       primary formalism. */
    function _proceedDemo() {
        fmt.resetUid();
        machine = (typeof demo !== 'undefined' && demo.build)
            ? demo.build() : new Machine('', 'PETRI');
        // The reference seeds nodes at default spots, so force one
        // auto-arrange on load. A loaded user file keeps its positions.
        _activate(true);
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
        _unsaved = false;   // work has been saved to a file
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

    function _activate(forceLayout) {
        _showStudio();
        mode = 'edit';
        _unsaved = false;          // freshly created or loaded
        canvas.setEditMode(true);
        catalog.setEnabled(true);
        _setModeButtonsEnabled(true);
        _syncFormalismUI(machine.mode);   // reflect loaded formalism
        controls.setMode('edit');
        controls.setMessage('');
        _refresh();
        // Fit & auto-layout if positions are all zero (fresh load with no
        // positions set) or the demo forced it.
        const anyPositioned = machine.states.some(s => s.x || s.y);
        if (forceLayout || (!anyPositioned && machine.states.length > 0)) {
            setTimeout(() => { canvas.autoLayout(); }, 60);
        } else {
            setTimeout(() => { canvas.fit(); }, 60);
        }
    }

    return {
        init,
        newMachine, downloadMachine, triggerUpload, exportMachine,
        loadDemo: _proceedDemo,
        renameProject: _renameProject,
        // Small test/debug surface (mirrors FAS): drive a catalog pick or
        // read the live machine from outside.
        getMachine: () => machine
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
