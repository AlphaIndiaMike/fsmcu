/**
 * canvas.js
 * Machine Studio [MS] — Cytoscape-backed diagram canvas.
 *
 * Owns the cytoscape instance, translates Machine → graph elements,
 * routes node/edge taps to the dialog layer, persists position
 * changes back into the Machine, applies status colours during
 * simulation and runs the dagre auto-layout on demand.
 *
 * Public:
 *   canvas.init(containerId, callbacks)
 *     callbacks = {
 *       onStateClick(stateId),
 *       onGateClick(gateId),
 *       onTransitionClick(transitionId),
 *       onPositionChange(kind, id, x, y)   // kind: 'state' | 'gate'
 *     }
 *   canvas.render(machine)                  — full rebuild
 *   canvas.applyStatuses(statuses)          — runtime colour + token labels
 *   canvas.setEditMode(bool)                — enable/disable drag & edit clicks
 *   canvas.autoLayout()                     — dagre arrange
 *   canvas.fit()                            — fit-to-viewport
 *
 * Depends on: cytoscape, cytoscape-dagre, dagre (lib/),
 *             config.js, fmt.js, machine.js (Machine type)
 */

const canvas = (() => {

    let cy        = null;
    let api       = {};
    let lastMachine = null;
    let editMode  = true;

    /* Cytoscape-dagre registration is done once at first init. */
    let _dagreRegistered = false;

    /* ── init ─────────────────────────────────────────────────────── */

    function init(containerId, callbacks) {
        api = callbacks || {};

        if (!_dagreRegistered && typeof cytoscapeDagre !== 'undefined') {
            cytoscape.use(cytoscapeDagre);
            _dagreRegistered = true;
        }

        const c = CONFIG.statusColors;

        cy = cytoscape({
            container: document.getElementById(containerId),
            wheelSensitivity: 0.25,
            minZoom: 0.3,
            maxZoom: 2.5,
            boxSelectionEnabled: false,
            selectionType: 'single',
            style: [
                /* ── State nodes (default softbox, idle/grey) ──── */
                {
                    selector: 'node[type="state"]',
                    style: {
                        'shape':                'round-rectangle',
                        'width':                'label',
                        'height':               'label',
                        'padding':              '14px',
                        'background-color':     c.idle.bg,
                        'border-color':         c.idle.border,
                        'border-width':         2,
                        'label':                'data(label)',
                        'text-wrap':            'wrap',
                        'text-valign':          'center',
                        'text-halign':          'center',
                        'color':                c.idle.fg,
                        'font-family':          'Outfit, sans-serif',
                        'font-size':            13,
                        'font-weight':          500,
                        'line-height':          1.35,
                        'transition-property':  'background-color, border-color, color',
                        'transition-duration':  '180ms'
                    }
                },
                /* Start state: circle (ellipse). */
                {
                    selector: 'node[type="state"][kind="start"]',
                    style: {
                        'shape':   'ellipse',
                        'padding': '20px'
                    }
                },
                /* End state: sharp square. */
                {
                    selector: 'node[type="state"][kind="end"]',
                    style: {
                        'shape': 'rectangle'
                    }
                },
                /* ── Status overrides via classes ─────────────── */
                {
                    selector: 'node.st-active',
                    style: {
                        'background-color': c.active.bg,
                        'border-color':     c.active.border,
                        'color':            c.active.fg
                    }
                },
                {
                    selector: 'node.st-full',
                    style: {
                        'background-color': c.full.bg,
                        'border-color':     c.full.border,
                        'color':            c.full.fg
                    }
                },
                {
                    selector: 'node.st-fail',
                    style: {
                        'background-color': c.fail.bg,
                        'border-color':     c.fail.border,
                        'color':            c.fail.fg
                    }
                },
                /* ── Gate nodes ──────────────────────────────── */
                {
                    selector: 'node[type="gate"]',
                    style: {
                        'shape':             'round-rectangle',
                        'width':             54,
                        'height':            38,
                        'background-color':  '#2c3340',
                        'border-color':      '#1a1f29',
                        'border-width':      2,
                        'label':             'data(label)',
                        'color':             '#ffffff',
                        'text-valign':       'center',
                        'text-halign':       'center',
                        'font-family':       'Outfit, sans-serif',
                        'font-size':         11,
                        'font-weight':       700,
                        'letter-spacing':    1
                    }
                },
                /* ── Edges ───────────────────────────────────── */
                {
                    selector: 'edge',
                    style: {
                        'width':              2,
                        'line-color':         '#8a94a6',
                        'target-arrow-color': '#8a94a6',
                        'target-arrow-shape': 'triangle',
                        'curve-style':        'bezier',
                        'label':              'data(label)',
                        'font-family':        'JetBrains Mono, monospace',
                        'font-size':          10,
                        'color':              '#4a5568',
                        'text-background-color':   '#ffffff',
                        'text-background-opacity': 0.95,
                        'text-background-padding': 2,
                        'text-background-shape':   'roundrectangle',
                        'edge-text-rotation': 'autorotate'
                    }
                },
                {
                    selector: 'edge[type="gate-in"], edge[type="gate-out"]',
                    style: {
                        'line-color':         '#5d6678',
                        'target-arrow-color': '#5d6678',
                        'line-style':         'solid'
                    }
                },
                /* Self-loops: render as a clearly visible arc above the
                   node so it can be clicked to edit/delete. Without
                   these properties cytoscape draws a degenerate
                   ~zero-length bezier that is effectively invisible
                   and unclickable. */
                {
                    selector: 'edge.self-loop',
                    style: {
                        'curve-style':             'bezier',
                        'loop-direction':          '-45deg',
                        'loop-sweep':              '-60deg',
                        'control-point-step-size': 80,
                        'edge-text-rotation':      'none'
                    }
                },
                /* Hover affordance in edit mode. */
                {
                    selector: 'node:active',
                    style: { 'overlay-opacity': 0 }
                }
            ],
            elements: []
        });

        cy.on('tap', 'node', evt => {
            if (!editMode) return;
            const n = evt.target;
            const t = n.data('type');
            if (t === 'state' && api.onStateClick) api.onStateClick(n.id());
            if (t === 'gate'  && api.onGateClick)  api.onGateClick(n.id());
        });

        cy.on('tap', 'edge', evt => {
            if (!editMode) return;
            const e = evt.target;
            // Only "transition" edges open a dialog. The synthetic
            // gate-in / gate-out edges are part of the gate widget
            // and edited via the gate's modal.
            if (e.data('type') === 'transition' && api.onTransitionClick) {
                api.onTransitionClick(e.id());
            }
        });

        cy.on('dragfree', 'node', evt => {
            const n  = evt.target;
            const t  = n.data('type');
            const p  = n.position();
            if (api.onPositionChange) api.onPositionChange(t, n.id(), p.x, p.y);
        });

        // Resize handling: when the middle pane changes size (window
        // resize or drawer toggle), cytoscape needs a kick.
        window.addEventListener('resize', () => { if (cy) cy.resize(); });
    }

    /* ── render ───────────────────────────────────────────────────── */

    function render(machine) {
        lastMachine = machine;
        if (!cy) return;
        const els = _machineToElements(machine);
        cy.elements().remove();
        cy.add(els);
        _refreshGrabbable();
    }

    /* Build the cytoscape elements list from the Machine. Layout uses
       saved x/y when present; otherwise places new items on a coarse
       grid so they don't all stack at the origin. */
    function _machineToElements(machine) {
        const els = [];

        machine.states.forEach((s, i) => {
            const pos = (s.x || s.y) ? { x: s.x, y: s.y }
                                     : _gridSpot(i);
            els.push({
                group: 'nodes',
                data: {
                    id:    s.id,
                    type:  'state',
                    kind:  s.kind,
                    label: _stateLabel(s, 0)
                },
                position: pos,
                classes:  'st-idle'
            });
        });

        machine.gates.forEach((g, i) => {
            const pos = (g.x || g.y) ? { x: g.x, y: g.y }
                                     : _gridSpot(machine.states.length + i);
            els.push({
                group: 'nodes',
                data: { id: g.id, type: 'gate', label: g.type },
                position: pos
            });

            if (g.type === 'SPLIT') {
                // SPLIT: one input edge (carrying the trigger label),
                // many output edges fanning out.
                const srcId = g.inputs && g.inputs[0];
                if (srcId && machine.stateById(srcId)) {
                    els.push({
                        group: 'edges',
                        data: {
                            id:     g.id + '__in',
                            source: srcId, target: g.id,
                            type:   'gate-in',
                            label:  _triggerLabel(machine, g.triggerId)
                        }
                    });
                }
                (g.outputs || []).forEach(dstId => {
                    if (!machine.stateById(dstId)) return;
                    els.push({
                        group: 'edges',
                        data: {
                            id:     g.id + '__out__' + dstId,
                            source: g.id, target: dstId,
                            type:   'gate-out',
                            label:  ''
                        }
                    });
                });
            } else {
                // AND / OR / XOR: many input edges, one output edge
                // (which carries the trigger label).
                g.inputs.forEach(srcId => {
                    if (!machine.stateById(srcId)) return;
                    els.push({
                        group: 'edges',
                        data: {
                            id:     g.id + '__in__' + srcId,
                            source: srcId, target: g.id,
                            type:   'gate-in',
                            label:  ''
                        }
                    });
                });
                if (g.to && machine.stateById(g.to)) {
                    els.push({
                        group: 'edges',
                        data: {
                            id:     g.id + '__out',
                            source: g.id, target: g.to,
                            type:   'gate-out',
                            label:  _triggerLabel(machine, g.triggerId)
                        }
                    });
                }
            }
        });

        machine.transitions.forEach(t => {
            els.push({
                group: 'edges',
                data: {
                    id:     t.id,
                    source: t.from, target: t.to,
                    type:   'transition',
                    label:  _triggerLabel(machine, t.triggerId)
                },
                // Self-loop transitions need explicit loop styling —
                // a bezier between a node and itself degenerates to
                // zero length. The .self-loop class triggers the
                // loop-direction / loop-sweep style block.
                classes: t.from === t.to ? 'self-loop' : ''
            });
        });

        return els;
    }

    function _stateLabel(state, tokens) {
        return state.name + '\n[' + tokens + '/' + state.bufferCap + ']';
    }

    function _triggerLabel(machine, triggerId) {
        if (!triggerId) return '(no trigger)';
        const trg = machine.triggerById(triggerId);
        if (!trg) return '(no trigger)';
        return trg.name + (trg.kind === 'timer' ? ' ⏱' : ' ▶');
    }

    function _gridSpot(i) {
        const cols = 4;
        const gx   = 200;
        const gy   = 140;
        return { x: 120 + (i % cols) * gx, y: 100 + Math.floor(i / cols) * gy };
    }

    /* ── runtime status / tokens ──────────────────────────────────── */

    function applyStatuses(statuses) {
        if (!cy || !lastMachine) return;
        statuses.forEach(({ id, tokens, status }) => {
            const n = cy.getElementById(id);
            if (!n || n.length === 0) return;
            const s = lastMachine.stateById(id);
            if (!s) return;
            n.data('label', _stateLabel(s, tokens));
            n.removeClass('st-idle st-active st-full st-fail');
            n.addClass('st-' + status);
        });
    }

    /* Reset every state visually to idle (used when leaving sim mode). */
    function resetVisuals() {
        if (!cy || !lastMachine) return;
        cy.nodes('[type="state"]').forEach(n => {
            const s = lastMachine.stateById(n.id());
            if (!s) return;
            n.data('label', _stateLabel(s, 0));
            n.removeClass('st-active st-full st-fail');
            n.addClass('st-idle');
        });
    }

    /* ── edit / sim mode ──────────────────────────────────────────── */

    function setEditMode(on) {
        editMode = !!on;
        _refreshGrabbable();
    }

    function _refreshGrabbable() {
        if (!cy) return;
        if (editMode) cy.nodes().grabify();
        else          cy.nodes().ungrabify();
    }

    /* ── auto-layout ──────────────────────────────────────────────── */

    function autoLayout() {
        if (!cy) return;
        try {
            cy.layout({
                name:      'dagre',
                rankDir:   'LR',
                nodeSep:   55,
                edgeSep:   25,
                rankSep:   100,
                animate:   true,
                animationDuration: 320
            }).run();
        } catch (err) {
            // Dagre not loaded — fall back to a quick grid layout.
            cy.layout({ name: 'grid', cols: 4 }).run();
        }

        // After the layout settles, persist positions back into the
        // model. Doing it on a one-shot timer avoids fighting the
        // animation.
        setTimeout(() => {
            if (!lastMachine || !api.onPositionChange) return;
            cy.nodes().forEach(n => {
                const p = n.position();
                api.onPositionChange(n.data('type'), n.id(), p.x, p.y);
            });
        }, 360);
    }

    function fit() {
        if (!cy) return;
        // Container may have changed size (drawer toggle, intro→studio
        // reveal, window resize) — resize first so fit measures right.
        cy.resize();
        cy.fit(undefined, 40);
    }

    return {
        init, render, applyStatuses, resetVisuals,
        setEditMode, autoLayout, fit
    };
})();
