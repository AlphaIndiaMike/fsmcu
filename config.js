/**
 * config.js
 * Machine Studio [MS] — Central configuration.
 *
 * Loaded FIRST so every module can read CONFIG. Pure data only — no
 * computation here. Tune defaults, breakpoints and status colours in
 * this single place.
 */

const CONFIG = {

    /* App version. Bumped when the JSON file format changes in a
       backwards-incompatible way. */
    fileVersion: 1,

    /* Petri-net defaults applied to every newly-created state. The
       state properties modal exposes them for per-state editing. */
    stateDefaults: {
        inputCost:   1,
        outputYield: 1,
        bufferCap:   5
    },

    /* Initial marking on the start state when Sim Start is pressed.
       Kept at 1 by request — the user must fire a trigger to advance. */
    startMarking: 1,

    /* Timer trigger defaults (seconds for period & initial delay). */
    timerDefaults: {
        period:       5,
        oneShot:      false,
        initialDelay: 0
    },

    /* How long (ms) the transient red/yellow flash lingers on a state
       after a failed firing before reverting to its underlying colour. */
    flashMs: 1000,

    /* Status colours — applied as cytoscape classes on state nodes.
       Foreground (background-color) + matching border. Kept in sync
       with the .st-* rules in styles.css. */
    statusColors: {
        idle:    { bg: '#e6e8eb', fg: '#3c4252', border: '#bcc3cd' },
        active:  { bg: '#bce5cc', fg: '#0e4a2e', border: '#5fbe8a' },
        full:    { bg: '#f3c1bd', fg: '#5b1814', border: '#d96258' },
        fail:    { bg: '#f7e3a4', fg: '#604609', border: '#d6a93b' }
    },

    /* Responsive breakpoint: at/under this width the side panels become
       toggleable drawers. Mirrors the example's pattern; the CSS @media
       value in styles.css must stay in sync. */
    layout: {
        minMainWidth:     800,
        mobileBreakpoint: 1000
    }
};
