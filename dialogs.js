/**
 * dialogs.js
 * Machine Studio [MS] — Modal dialog controller.
 *
 * All structural editing (state/transition/gate/trigger) happens
 * through dialogs. Modules above (catalog, controls, canvas) only
 * route to dialogs; dialogs talk to the model through the api object
 * injected at init() so we can refresh + persist consistently.
 *
 * Public:
 *   dialogs.init(api)
 *     api = {
 *       getMachine, refresh,
 *       applyStateCreate/Update/Delete,
 *       applyTransitionCreate/Update/Delete,
 *       applyGateCreate/Update/Delete,
 *       applyTriggerCreate/Update/Delete
 *     }
 *   dialogs.openStateEdit(stateId)
 *   dialogs.openTransitionEdit(transitionIdOrNull)   // null = create
 *   dialogs.openGateEdit(gateIdOrNull, createType)   // createType used if creating
 *   dialogs.openTriggerEdit(triggerIdOrNull, createKind)
 *   dialogs.openTimerConfig(triggerId)
 *   dialogs.confirm(title, message, onOk)
 *
 * Depends on: modal.js, fmt.js, machine.js (Machine type)
 */

const dialogs = (() => {

    let api = null;

    function init(a) {
        api = a;
        modal.init();
    }

    /* ── Form helpers (mirror the example's _field / _err pattern) ─── */

    function _field(label, inner, hint) {
        return `
            <label class="dlg-field">
                <span class="dlg-label">${label}</span>
                ${inner}
                ${hint ? `<span class="dlg-hint">${hint}</span>` : ''}
            </label>`;
    }

    function _errBox() {
        return `<div class="dlg-err" id="dlgErr" style="display:none"></div>`;
    }
    function _err(msg) {
        const box = document.getElementById('dlgErr');
        if (box) { box.textContent = msg || ''; box.style.display = msg ? 'block' : 'none'; }
    }

    function _stateOptions(machine, selectedId, excludeId) {
        return machine.states
            .filter(s => s.id !== excludeId)
            .map(s => `<option value="${s.id}"${s.id === selectedId ? ' selected' : ''}>` +
                       `${fmt.escHtml(s.name)} (${s.kind})</option>`)
            .join('') || '<option value="">— no states yet —</option>';
    }

    function _triggerOptions(machine, selectedId) {
        const none = `<option value="">— none (arrow never fires) —</option>`;
        const opts = machine.triggers.map(t =>
            `<option value="${t.id}"${t.id === selectedId ? ' selected' : ''}>` +
            `${fmt.escHtml(t.name)} (${t.kind})</option>`).join('');
        return none + opts;
    }

    function _groupOptions(machine, selectedId) {
        const none = `<option value="">— none (ungrouped) —</option>`;
        const opts = (machine.groups || []).map(g =>
            `<option value="${g.id}"${g.id === selectedId ? ' selected' : ''}>` +
            `${fmt.escHtml(g.name)}</option>`).join('');
        return none + opts;
    }

    /* ════════════════════════════════════════════════════════════════
       STATE
       ════════════════════════════════════════════════════════════════ */

    function openStateEdit(stateId) {
        const m = api.getMachine();
        const s = m.stateById(stateId);
        if (!s) return;
        const isFsm = m.mode === 'FSM';

        const hasStart = !!m.startState();
        const kindOpts = ['start', 'normal', 'end'].map(k =>
            `<option value="${k}"${k === s.kind ? ' selected' : ''}` +
            (k === 'start' && hasStart && s.kind !== 'start' ? ' disabled' : '') +
            `>${k}${k === 'start' && hasStart && s.kind !== 'start' ? ' (one already exists)' : ''}</option>`
        ).join('');

        const kindHint = isFsm
            ? 'Start = ◯ circle, Normal = softbox, End = ▢ square. The run auto-stops when the active state reaches an end state.'
            : 'Start = ◯ circle, Normal = softbox, End = ▢ square. Sim auto-stops when a token reaches an end state.';

        // Petri-only token economics. A finite-state machine has no token
        // costs, yields or buffers, so these fields are hidden in FSM mode.
        const petriFields = isFsm ? '' : `
            ${_field('Initial tokens',
                `<input class="dlg-inp" id="fInit" type="number" min="0" step="1" value="${s.initialTokens || 0}">`,
                'Tokens placed on this state when Sim Start (or Reset) is pressed. Must be ≤ buffer capacity.')}
            <div class="dlg-row">
                ${_field('Input cost',
                    `<input class="dlg-inp" id="fCost" type="number" min="0" step="1" value="${s.inputCost}">`,
                    'Tokens consumed when firing out.')}
                ${_field('Output yield',
                    `<input class="dlg-inp" id="fYield" type="number" min="0" step="1" value="${s.outputYield}">`,
                    'Tokens delivered to the destination per fire.')}
                ${_field('Buffer capacity',
                    `<input class="dlg-inp" id="fCap" type="number" min="1" step="1" value="${s.bufferCap}">`,
                    'Max tokens this state can hold (red when full).')}
            </div>
            <div class="dlg-note" id="fEcoNote"></div>`;

        modal.open('State — ' + s.name, `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="fName" type="text" value="${fmt.escHtml(s.name)}" maxlength="40">`)}
            ${_field('Kind',
                `<select class="dlg-inp" id="fKind">${kindOpts}</select>`,
                kindHint)}
            ${_field('Group',
                `<select class="dlg-inp" id="fGroup">${_groupOptions(m, s.groupId)}</select>`,
                'Bundle this state inside a labelled boundary. Manage groups from the Catalog.')}
            ${petriFields}
        `, [
            { label: 'Delete', cls: 'btn-danger', onClick: () => _confirmDeleteState(s) },
            { label: 'Cancel', cls: 'btn-sec',    onClick: modal.close },
            { label: 'Save',   cls: 'btn-primary', onClick: () => _saveState(s) }
        ]);

        // Live transfer-function readout (Petri only) — surfaces whether
        // this state produces, consumes or conserves tokens on each fire.
        const inp  = document.getElementById('fCost');
        const out  = document.getElementById('fYield');
        const note = document.getElementById('fEcoNote');
        if (inp && out && note) {
            const upd = () => {
                const c = parseInt(inp.value, 10) || 0;
                const y = parseInt(out.value, 10) || 0;
                const delta = y - c;
                let line;
                if      (delta > 0) line = `<strong>Produces +${delta}</strong> net token(s) per fire — generates tokens.`;
                else if (delta < 0) line = `<strong>Consumes ${delta}</strong> net token(s) per fire — destroys tokens.`;
                else                line = `<strong>Pass-through</strong> — tokens conserved per fire.`;
                note.innerHTML =
                    `Per fire: consume <strong>${c}</strong> token(s) from this state, ` +
                    `deliver <strong>${y}</strong> to the destination. ${line}`;
            };
            inp.addEventListener('input', upd);
            out.addEventListener('input', upd);
            upd();
        }
    }

    function _saveState(s) {
        const m     = api.getMachine();
        const isFsm = m.mode === 'FSM';
        const name  = document.getElementById('fName').value.trim();
        if (!name) { _err('Name is required.'); return; }
        const kind  = document.getElementById('fKind').value;
        const groupSel = document.getElementById('fGroup');
        const groupId  = groupSel && groupSel.value ? groupSel.value : null;

        const patch = { name, kind, groupId };

        if (!isFsm) {
            const init = fmt.posInt(document.getElementById('fInit').value, NaN);
            const cost = fmt.posInt(document.getElementById('fCost').value, NaN);
            const yld  = fmt.posInt(document.getElementById('fYield').value, NaN);
            const cap  = fmt.posInt(document.getElementById('fCap').value, NaN);
            if (isNaN(cost) || isNaN(yld) || isNaN(cap) || isNaN(init)) {
                _err('Initial tokens, cost, yield and capacity must be whole numbers (≥0 / cap ≥1).'); return;
            }
            if (cap  < 1)   { _err('Buffer capacity must be at least 1.'); return; }
            if (init > cap) { _err('Initial tokens (' + init + ') cannot exceed buffer capacity (' + cap + ').'); return; }
            patch.initialTokens = init;
            patch.inputCost     = cost;
            patch.outputYield   = yld;
            patch.bufferCap     = cap;
        }
        api.applyStateUpdate(s.id, patch);
        modal.close();
    }

    function _confirmDeleteState(s) {
        confirm('Delete state?',
            'Remove "' + s.name + '" and every transition/gate that touches it. This cannot be undone.',
            () => { api.applyStateDelete(s.id); modal.close(); });
    }

    /* ════════════════════════════════════════════════════════════════
       GROUP (create + edit) — a labelled boundary that bundles states.
       Works the same in FSM and Petri: membership lives on each state's
       groupId, so a group is just a name + colour + the set of states
       that point at it.
       ════════════════════════════════════════════════════════════════ */

    function openGroupEdit(groupId) {
        const m = api.getMachine();
        if (!m) return;
        const existing = groupId ? m.groupById(groupId) : null;

        const g = existing || {
            id: null,
            name: '',
            color: CONFIG.groupColors[(m.groups || []).length % CONFIG.groupColors.length]
        };

        // Initial members = states currently pointing at this group.
        const members = existing
            ? m.statesInGroup(existing.id).map(s => s.id)
            : [];

        const swatches = CONFIG.groupColors.map(c =>
            `<label class="dlg-swatch" style="background:${c}">
                <input type="radio" name="fColor" value="${c}" ${c === g.color ? 'checked' : ''}>
            </label>`).join('');

        modal.open((existing ? 'Edit group — ' + existing.name : 'New group'), `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="40" value="${fmt.escHtml(g.name)}" placeholder="e.g. Sensor subsystem">`,
                'Label shown on the boundary in the canvas.')}
            <div class="dlg-label">Colour</div>
            <div class="dlg-swatches">${swatches}</div>
            <div class="dlg-label dlg-label--gap">Members</div>
            <div class="dlg-hint" style="margin-bottom:0.4rem">
                Tick the states that belong to this group. A state can be in one group at a time.
            </div>
            <div class="gate-inputs" id="gMembers"></div>
        `, [
            ...(existing ? [{
                label: 'Delete', cls: 'btn-danger',
                onClick: () => confirm('Delete group?',
                    'Remove "' + existing.name + '". States inside it fall back to ungrouped (the states themselves are kept).',
                    () => { api.applyGroupDelete(existing.id); modal.close(); })
            }] : []),
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            { label: existing ? 'Save' : 'Create', cls: 'btn-primary',
              onClick: () => _saveGroup(existing, members) }
        ]);

        // Swatch highlight wiring.
        const syncSwatches = () => document.querySelectorAll('.dlg-swatch').forEach(sw =>
            sw.classList.toggle('dlg-swatch-on', sw.querySelector('input').checked));
        document.querySelectorAll('.dlg-swatch input').forEach(r =>
            r.addEventListener('change', syncSwatches));
        syncSwatches();

        _renderGroupMembers(m, members, 'gMembers');
    }

    function _renderGroupMembers(machine, selected, containerId) {
        const el = document.getElementById(containerId);
        if (!el) return;
        let html = '';
        machine.states.forEach(s => {
            const on = selected.indexOf(s.id) !== -1;
            html += `
                <div class="gi-row ${on ? 'gi-on' : ''}" data-id="${s.id}">
                    <label class="gi-check">
                        <input type="checkbox" data-id="${s.id}" ${on ? 'checked' : ''}>
                        <span>${fmt.escHtml(s.name)} <span class="gi-kind">${s.kind}</span></span>
                    </label>
                </div>`;
        });
        if (!html) {
            html = `<div class="ctrl-empty" style="padding:0.6rem">No states yet — add some first.</div>`;
        }
        el.innerHTML = html;
        el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.getAttribute('data-id');
                if (cb.checked) { if (selected.indexOf(id) === -1) selected.push(id); }
                else            { const i = selected.indexOf(id); if (i !== -1) selected.splice(i, 1); }
                _renderGroupMembers(machine, selected, containerId);
            });
        });
    }

    function _saveGroup(existing, members) {
        const name = document.getElementById('fName').value.trim();
        if (!name) { _err('Name is required.'); return; }
        const col  = (document.querySelector('input[name="fColor"]:checked') || {}).value;
        const patch = { name };
        if (col) patch.color = col;
        if (existing) api.applyGroupUpdate(existing.id, patch, members);
        else          api.applyGroupCreate(patch, members);
        modal.close();
    }

    /* ════════════════════════════════════════════════════════════════
       TRANSITION (create + edit)
       ════════════════════════════════════════════════════════════════ */

    function openTransitionEdit(transitionId) {
        const m = api.getMachine();
        const t = transitionId ? m.transitionById(transitionId) : null;
        if (transitionId && !t) return;

        if (m.states.length < 1) {
            _alert('No states yet', 'Add at least one state from the Catalog before creating a transition.');
            return;
        }

        const fromId = t ? t.from : (m.states[0] && m.states[0].id);
        const toId   = t ? t.to   : (m.states[1] ? m.states[1].id : m.states[0].id);
        const trgId  = t ? t.triggerId : null;

        modal.open(t ? 'Edit Transition' : 'New Transition', `
            ${_errBox()}
            ${_field('From state',
                `<select class="dlg-inp" id="fFrom">${_stateOptions(m, fromId)}</select>`)}
            ${_field('To state',
                `<select class="dlg-inp" id="fTo">${_stateOptions(m, toId)}</select>`)}
            ${_field('Trigger',
                `<select class="dlg-inp" id="fTrigger">${_triggerOptions(m, trgId)}</select>`,
                'The trigger that fires this arrow. Manual triggers fire when you press their button; timer triggers fire on a schedule. Without a trigger, this arrow will never fire.')}
        `, _transitionFooter(t));
    }

    function _transitionFooter(t) {
        const buttons = [];
        if (t) buttons.push({
            label: 'Delete', cls: 'btn-danger',
            onClick: () => confirm('Delete transition?',
                'Remove this arrow from the diagram.',
                () => { api.applyTransitionDelete(t.id); modal.close(); })
        });
        buttons.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        buttons.push({
            label: t ? 'Save' : 'Create',
            cls:   'btn-primary',
            onClick: () => _saveTransition(t)
        });
        return buttons;
    }

    function _saveTransition(existing) {
        const from = document.getElementById('fFrom').value;
        const to   = document.getElementById('fTo').value;
        const trg  = document.getElementById('fTrigger').value || null;
        if (!from || !to) { _err('Pick both a source and a destination state.'); return; }
        // Self-loops are valid: A → A is a fire that consumes inputCost
        // from A and adds outputYield to A. Useful for "tick" patterns
        // where a state cycles tokens against itself.
        if (existing) api.applyTransitionUpdate(existing.id, { from, to, triggerId: trg });
        else          api.applyTransitionCreate({ from, to, triggerId: trg });
        modal.close();
    }

    /* ════════════════════════════════════════════════════════════════
       GATE (create + edit)
       ════════════════════════════════════════════════════════════════ */

    function openGateEdit(gateId, createType) {
        const m = api.getMachine();
        const g = gateId ? m.gateById(gateId) : null;
        const type = g ? g.type : (createType || 'AND');

        if (type === 'SPLIT') return _openSplitGate(m, g);
        return _openLogicGate(m, g, type);
    }

    /* ── AND / OR / XOR — N inputs → 1 output ─────────────────────── */

    function _openLogicGate(m, g, type) {
        if (m.states.length < 2) {
            _alert('Not enough states',
                'A gate needs at least two input states and one target. Add more states first.');
            return;
        }

        const initialInputs = g ? g.inputs.slice() : [];
        const initialTo     = g ? g.to             : '';
        const initialTrg    = g ? g.triggerId      : null;

        modal.open((g ? 'Edit ' : 'New ') + type + ' gate', `
            ${_errBox()}
            <div class="dlg-note">
                <strong>${type}</strong> —
                ${type === 'AND' ? 'fires only when every input has enough tokens. All inputs pay; target gains the sum of yields.' :
                  type === 'OR'  ? 'fires when any input has enough tokens. The first eligible input (top of the list) pays.' :
                                   'fires only when exactly one input has enough tokens.'}
            </div>
            <div class="dlg-label" style="margin-top:0.5rem">Inputs (ordered)</div>
            <div id="gateInputs" class="gate-inputs"></div>
            ${_field('Target state',
                `<select class="dlg-inp" id="fTo">${_stateOptions(m, initialTo)}</select>`)}
            ${_field('Trigger',
                `<select class="dlg-inp" id="fTrigger">${_triggerOptions(m, initialTrg)}</select>`,
                'The gate listens to this trigger. Order in the input list matters for OR (first eligible pays).')}
        `, _logicGateFooter(g, type));

        _renderStatePicker(m, initialInputs, 'gateInputs');
    }

    function _logicGateFooter(g, type) {
        const buttons = [];
        if (g) buttons.push({
            label: 'Delete', cls: 'btn-danger',
            onClick: () => confirm('Delete gate?',
                'Remove this gate and its connecting arrows.',
                () => { api.applyGateDelete(g.id); modal.close(); })
        });
        buttons.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        buttons.push({
            label: g ? 'Save' : 'Create',
            cls:   'btn-primary',
            onClick: () => _saveLogicGate(g, type)
        });
        return buttons;
    }

    function _saveLogicGate(existing, type) {
        const el = document.getElementById('gateInputs');
        const selected = JSON.parse(el.dataset.selected || '[]');
        const to       = document.getElementById('fTo').value;
        const trg      = document.getElementById('fTrigger').value || null;

        if (selected.length < 2) { _err('Pick at least two input states.'); return; }
        if (!to)                  { _err('Pick a target state.'); return; }
        if (selected.indexOf(to) !== -1) {
            _err('Target cannot also be an input.'); return;
        }
        if (existing) {
            api.applyGateUpdate(existing.id, {
                inputs: selected, outputs: [], to, triggerId: trg
            });
        } else {
            api.applyGateCreate({
                type, inputs: selected, outputs: [], to, triggerId: trg
            });
        }
        modal.close();
    }

    /* ── SPLIT — 1 input → N outputs (atomic fan-out) ─────────────── */

    function _openSplitGate(m, g) {
        if (m.states.length < 3) {
            _alert('Not enough states',
                'A SPLIT needs one source and at least two destinations — three states in total. Add more states first.');
            return;
        }

        const initialSrc  = g ? (g.inputs[0] || '') : (m.states[0] && m.states[0].id);
        const initialOuts = g ? (g.outputs || []).slice() : [];
        const initialTrg  = g ? g.triggerId : null;

        modal.open((g ? 'Edit ' : 'New ') + 'SPLIT gate', `
            ${_errBox()}
            <div class="dlg-note">
                <strong>SPLIT</strong> — atomic fan-out. Each destination is a
                parallel transition firing simultaneously: source loses
                <em>N&nbsp;×&nbsp;inputCost</em> in total (one cost per branch),
                each destination gains <em>outputYield</em>. All-or-nothing:
                if the source has too few tokens for every branch, or any
                destination is too full to receive, nothing moves.
            </div>
            ${_field('Source state',
                `<select class="dlg-inp" id="fSrc">${_stateOptions(m, initialSrc)}</select>`,
                'The single state that pays — once per destination.')}
            <div class="dlg-label" style="margin-top:0.5rem">Destinations (ordered)</div>
            <div id="splitOutputs" class="gate-inputs"></div>
            ${_field('Trigger',
                `<select class="dlg-inp" id="fTrigger">${_triggerOptions(m, initialTrg)}</select>`,
                'The gate listens to this trigger.')}
        `, _splitGateFooter(g));

        _renderStatePicker(m, initialOuts, 'splitOutputs', initialSrc);

        // When the source changes, re-render the outputs picker so the
        // newly-chosen source is excluded from the destinations list.
        document.getElementById('fSrc').addEventListener('change', e => {
            _renderStatePicker(m, initialOuts, 'splitOutputs', e.target.value);
        });
    }

    function _splitGateFooter(g) {
        const buttons = [];
        if (g) buttons.push({
            label: 'Delete', cls: 'btn-danger',
            onClick: () => confirm('Delete gate?',
                'Remove this SPLIT and its connecting arrows.',
                () => { api.applyGateDelete(g.id); modal.close(); })
        });
        buttons.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        buttons.push({
            label: g ? 'Save' : 'Create',
            cls:   'btn-primary',
            onClick: () => _saveSplitGate(g)
        });
        return buttons;
    }

    function _saveSplitGate(existing) {
        const src = document.getElementById('fSrc').value;
        const trg = document.getElementById('fTrigger').value || null;
        const el  = document.getElementById('splitOutputs');
        const outs = JSON.parse(el.dataset.selected || '[]');

        if (!src)              { _err('Pick a source state.'); return; }
        if (outs.length < 2)   { _err('Pick at least two destinations.'); return; }
        if (outs.indexOf(src) !== -1) {
            _err('Source cannot also be a destination.'); return;
        }
        if (existing) {
            api.applyGateUpdate(existing.id, {
                inputs: [src], outputs: outs, to: null, triggerId: trg
            });
        } else {
            api.applyGateCreate({
                type: 'SPLIT', inputs: [src], outputs: outs, to: null, triggerId: trg
            });
        }
        modal.close();
    }

    /* Generic ordered state picker — used by both AND/OR/XOR gate
       inputs and SPLIT gate outputs. Mutates the `selected` array
       in place, re-renders into the container on every change, and
       stashes the JSON-encoded selection on the container's dataset
       so the save handler can read it back. `excludeId` (optional)
       hides one state from the list — handy for SPLIT, where the
       source can't also be an output. */
    function _renderStatePicker(machine, selected, containerId, excludeId) {
        const el = document.getElementById(containerId);
        if (!el) return;

        // If excludeId was set after the selection was made, drop it
        // from selected so we don't keep a hidden invalid entry.
        if (excludeId) {
            const dropIdx = selected.indexOf(excludeId);
            if (dropIdx !== -1) selected.splice(dropIdx, 1);
        }

        let html = '';
        machine.states.forEach(s => {
            if (s.id === excludeId) return;
            const idx     = selected.indexOf(s.id);
            const checked = idx !== -1 ? 'checked' : '';
            const pos     = idx !== -1 ? (idx + 1) : '';
            html += `
                <div class="gi-row ${idx !== -1 ? 'gi-on' : ''}" data-id="${s.id}">
                    <label class="gi-check">
                        <input type="checkbox" data-id="${s.id}" ${checked}>
                        <span>${fmt.escHtml(s.name)}</span>
                    </label>
                    <span class="gi-pos">${pos}</span>
                    <button class="btn-mini gi-up"   data-id="${s.id}" title="Move earlier">▲</button>
                    <button class="btn-mini gi-down" data-id="${s.id}" title="Move later">▼</button>
                </div>`;
        });
        if (!html) {
            html = `<div class="ctrl-empty" style="padding:0.6rem">No selectable states.</div>`;
        }
        el.innerHTML = html;

        el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.getAttribute('data-id');
                if (cb.checked) { if (selected.indexOf(id) === -1) selected.push(id); }
                else            { const i = selected.indexOf(id); if (i !== -1) selected.splice(i, 1); }
                _renderStatePicker(machine, selected, containerId, excludeId);
            });
        });
        el.querySelectorAll('.gi-up').forEach(b => {
            b.addEventListener('click', () => {
                const id = b.getAttribute('data-id');
                const i  = selected.indexOf(id);
                if (i > 0) {
                    [selected[i-1], selected[i]] = [selected[i], selected[i-1]];
                    _renderStatePicker(machine, selected, containerId, excludeId);
                }
            });
        });
        el.querySelectorAll('.gi-down').forEach(b => {
            b.addEventListener('click', () => {
                const id = b.getAttribute('data-id');
                const i  = selected.indexOf(id);
                if (i !== -1 && i < selected.length - 1) {
                    [selected[i+1], selected[i]] = [selected[i], selected[i+1]];
                    _renderStatePicker(machine, selected, containerId, excludeId);
                }
            });
        });
        el.dataset.selected = JSON.stringify(selected);
    }

    /* ════════════════════════════════════════════════════════════════
       TRIGGER (create + edit)
       ════════════════════════════════════════════════════════════════ */

    function openTriggerEdit(triggerId, createKind) {
        const m = api.getMachine();
        const t = triggerId ? m.triggerById(triggerId) : null;
        const kind = t ? t.kind : (createKind || 'manual');

        const timerFields = `
            <div class="dlg-row">
                ${_field('Period (s)',
                    `<input class="dlg-inp" id="fPeriod" type="number" min="1" step="1" value="${t && t.period != null ? t.period : 5}">`,
                    'Fires every N seconds.')}
                ${_field('Initial delay (s)',
                    `<input class="dlg-inp" id="fDelay" type="number" min="0" step="1" value="${t && t.initialDelay != null ? t.initialDelay : 0}">`,
                    'Wait this long after Start before the first fire.')}
            </div>
            ${_field('Mode',
                `<label class="dlg-check">
                    <input type="checkbox" id="fOneShot" ${(t && t.oneShot) ? 'checked' : ''}>
                    <span>One-shot — fire only once, then stop</span>
                </label>`,
                'Unchecked = repeats every period; checked = fires once after the initial delay.')}
        `;

        modal.open((t ? 'Edit ' : 'New ') + (kind === 'timer' ? 'Timer Trigger' : 'Manual Trigger'), `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="32" value="${fmt.escHtml(t ? t.name : '')}" placeholder="${kind === 'timer' ? 'e.g. Heartbeat' : 'e.g. Advance'}">`)}
            ${kind === 'timer' ? timerFields : ''}
        `, [
            ...(t ? [{ label: 'Delete', cls: 'btn-danger', onClick: () => _confirmDeleteTrigger(t) }] : []),
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            { label: t ? 'Save' : 'Create', cls: 'btn-primary',
              onClick: () => _saveTrigger(t, kind) }
        ]);
    }

    function _saveTrigger(existing, kind) {
        const name = document.getElementById('fName').value.trim();
        if (!name) { _err('Name is required.'); return; }
        const patch = { name, kind };
        if (kind === 'timer') {
            const period = fmt.posInt(document.getElementById('fPeriod').value, NaN);
            const delay  = fmt.posInt(document.getElementById('fDelay').value, NaN);
            if (isNaN(period) || period < 1) { _err('Period must be at least 1 second.'); return; }
            if (isNaN(delay))                 { _err('Initial delay must be ≥ 0.');       return; }
            patch.period       = period;
            patch.initialDelay = delay;
            patch.oneShot      = document.getElementById('fOneShot').checked;
        }
        if (existing) api.applyTriggerUpdate(existing.id, patch);
        else          api.applyTriggerCreate(patch);
        modal.close();
    }

    function _confirmDeleteTrigger(t) {
        confirm('Delete trigger?',
            'Any arrows/gates that referenced "' + t.name + '" will keep their geometry but lose their trigger.',
            () => { api.applyTriggerDelete(t.id); modal.close(); });
    }

    /* ── Timer Configure (subset of trigger edit) ─────────────────── */

    function openTimerConfig(triggerId) {
        openTriggerEdit(triggerId);   // same dialog, full editor
    }

    /* ════════════════════════════════════════════════════════════════
       GENERIC CONFIRM / ALERT
       ════════════════════════════════════════════════════════════════ */

    function confirm(title, message, onOk) {
        modal.open(title, `<div class="dlg-msg">${fmt.escHtml(message)}</div>`, [
            { label: 'Cancel',  cls: 'btn-sec',    onClick: modal.close },
            // Close BEFORE running onOk: if onOk opens another modal
            // (e.g. "Discard? → New Machine name picker"), an onOk-then-close
            // order would tear the new modal down one frame after opening it.
            { label: 'Confirm', cls: 'btn-danger', onClick: () => { modal.close(); if (onOk) onOk(); } }
        ]);
    }

    function _alert(title, message) {
        modal.open(title, `<div class="dlg-msg">${fmt.escHtml(message)}</div>`, [
            { label: 'OK', cls: 'btn-primary', onClick: modal.close }
        ]);
    }

    /* ════════════════════════════════════════════════════════════════
       NEW MACHINE (name picker)
       ════════════════════════════════════════════════════════════════ */

    function openNewMachine(onCreate, onDemo) {
        const footer = [];
        if (typeof onDemo === 'function') {
            footer.push({
                label: 'Load demo', cls: 'btn-sec btn-left',
                onClick: () => { modal.close(); onDemo(); }
            });
        }
        footer.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        footer.push({
            label: 'Create', cls: 'btn-primary',
            onClick: () => {
                const name = document.getElementById('fName').value.trim();
                const sel  = document.getElementById('fMode');
                const mode = (sel && sel.value === 'FSM') ? 'FSM' : 'PETRI';
                modal.close();
                if (onCreate) onCreate(name, mode);
            }
        });
        modal.open('New Machine', `
            ${_errBox()}
            ${_field('Formalism',
                `<select class="dlg-inp" id="fMode">
                    <option value="PETRI">Petri net — token model (places, gates, capacities)</option>
                    <option value="FSM">FSM — finite-state machine (one active state)</option>
                </select>`,
                'Petri is the full token model; FSM is the simpler single-active-state machine. You can switch formalism any time from the header.')}
            ${_field('Machine name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="60" placeholder="e.g. Traffic-light controller">`,
                'Optional — used as the JSON filename when you Save.')}
            ${typeof onDemo === 'function'
                ? '<div class="dlg-note">New here? Press <strong>Load demo</strong> for a worked example that fills BOTH a Petri net and an FSM — switch formalism from the header to compare them.</div>'
                : ''}
        `, footer);
    }

    /* ════════════════════════════════════════════════════════════════
       EXPORT — generate state machine code in C / C++
       ════════════════════════════════════════════════════════════════ */

    function openExport() {
        const m = api.getMachine();
        if (!m || m.states.length === 0) {
            _alert('Nothing to export',
                'Add at least one state to your machine before exporting.');
            return;
        }
        if (typeof generators === 'undefined') {
            _alert('Generator unavailable',
                'The code generation module did not load. Make sure the generators/ folder is present.');
            return;
        }

        const langs = generators.languages();
        if (!langs.length) {
            _alert('No generators',
                'No language generators are registered.');
            return;
        }

        // Default selection: C if available, else first registered.
        const initLang = langs.find(l => l.id === 'c') || langs[0];

        const langOpts = langs.map(l =>
            `<option value="${l.id}"${l.id === initLang.id ? ' selected' : ''}>${fmt.escHtml(l.name)}</option>`
        ).join('');

        const fsm = (m.mode === 'FSM');
        modal.open('Export — Generate State Machine Code', `
            ${_errBox()}
            <div class="dlg-msg" style="margin-bottom:0.8rem">
                Generate compilable code from
                <strong>${fmt.escHtml(m.name || 'machine')}</strong>.
                This machine is in <strong>${fsm ? 'FSM' : 'Petri-net'}</strong> mode —
                ${fsm
                    ? 'a classic finite-state machine (transition table) will be generated.'
                    : 'the Petri-net token engine will be generated.'}
                Implement the per-state handler bodies in your own file —
                regeneration won't overwrite them.
            </div>
            ${_field('Language',
                `<select class="dlg-inp" id="fLang">${langOpts}</select>`)}
            ${_field('Pattern',
                `<select class="dlg-inp" id="fPattern"></select>`,
                'How the firing engine is structured in the emitted code.')}
            ${_field('Trigger API',
                `<select class="dlg-inp" id="fTrigAPI">
                    <option value="per-trigger" selected>Both — per-trigger functions (recommended) + sm_fire(id)</option>
                    <option value="id-only">Integer dispatch only — sm_fire(TRIG_XXX)</option>
                </select>`,
                'Both styles are always emitted; this only changes which is featured in the example.')}
            <div class="dlg-checks">
                <label class="dlg-check">
                    <input type="checkbox" id="fIncTests" checked>
                    <span>Include unit tests <em>(${fsm ? 'Unity / GoogleTest' : 'Unity / GoogleTest'} template)</em></span>
                </label>
                <label class="dlg-check">
                    <input type="checkbox" id="fIncImage" checked>
                    <span>Include diagram image <em>(diagram.png)</em></span>
                </label>
            </div>
        `, [
            { label: 'Cancel',   cls: 'btn-sec',     onClick: modal.close },
            { label: 'Generate', cls: 'btn-primary', onClick: () => _doGenerate(m) }
        ]);

        const langSel    = document.getElementById('fLang');
        const patternSel = document.getElementById('fPattern');

        function repopulatePatterns() {
            const lang = generators.language(langSel.value);
            const patternLabels = {
                'table':  'Table-driven — transitions table + per-state handler array (recommended)',
                'switch': 'Switch/case — single dispatch function with switch on trigger',
                'oop':    'OOP — one class per state (C++ only)'
            };
            patternSel.innerHTML = lang.supportedPatterns
                .map(p => `<option value="${p}">${patternLabels[p] || p}</option>`)
                .join('');
        }
        langSel.addEventListener('change', repopulatePatterns);
        repopulatePatterns();
    }

    function _doGenerate(machine) {
        const lang       = document.getElementById('fLang').value;
        const pattern    = document.getElementById('fPattern').value;
        const triggerApi = document.getElementById('fTrigAPI').value;
        const incTests   = document.getElementById('fIncTests').checked;
        const incImage   = document.getElementById('fIncImage').checked;

        const result = generators.run({
            machine, language: lang, pattern, triggerApi, includes: {}
        });

        if (!result.ok) {
            _err(result.error || 'Generation failed.');
            return;
        }

        let files = result.files;

        // Tests are emitted by default; drop them if the user opted out.
        if (!incTests) {
            files = files.filter(f => !/(^|\/)test_/.test(f.name));
        }

        // Fold in a PNG of the diagram (binary entry → base64 in the zip).
        if (incImage && api.getDiagramImage) {
            try {
                const png = api.getDiagramImage();
                if (png) files = files.concat([{ name: 'diagram.png', content: png, base64: true }]);
            } catch (e) { /* non-fatal: ship the code without the image */ }
        }

        generators.downloadZip(files, machine.name || 'state_machine');
        modal.close();
    }

    /* ════════════════════════════════════════════════════════════════
       RENAME — name (or rename) the active machine
       ════════════════════════════════════════════════════════════════ */

    function openRename(current, onSubmit) {
        const submit = () => {
            const name = document.getElementById('fRename').value.trim();
            modal.close();
            if (typeof onSubmit === 'function') onSubmit(name);
        };
        modal.open('Name this machine', `
            ${_field('Machine name',
                `<input class="dlg-inp" id="fRename" type="text" maxlength="60"
                        placeholder="e.g. Traffic-light controller" value="${fmt.escHtml(current || '')}">`,
                'The name shows in the header and is used as the download filename. ' +
                'Leave blank to keep it untitled.')}
        `, [
            { label: 'Cancel',    cls: 'btn-sec',     onClick: modal.close },
            { label: 'Save name', cls: 'btn-primary', onClick: submit }
        ]);
        const f = document.getElementById('fRename');
        if (f) {
            f.focus();
            f.select();
            f.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        }
    }

    function _doExport() {
        // Legacy entry point — keep for any external callers.
        openExport();
    }

    return {
        init,
        openStateEdit, openTransitionEdit, openGateEdit, openGroupEdit,
        openTriggerEdit, openTimerConfig, openExport, openNewMachine,
        openRename,
        confirm
    };
})();
