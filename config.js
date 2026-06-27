/**
 * config.js
 * Machine Studio [MS] — Central configuration.
 *
 * Loaded FIRST so every module can read CONFIG. Pure data only — no
 * computation here. Tune defaults, breakpoints and status colours in
 * this single place.
 */

const CONFIG = {

    /* Software version of the tool itself (semver). Shown in the header
       badge and stamped into saved JSON + exported code. BUMP THIS ON
       EVERY ITERATION — patch for fixes, minor for new features, major
       for breaking changes. */
    appVersion:  '1.0.4',
    releaseDate: '2026-06-26',

    /* JSON file-format version. v1 = legacy single flat model (states,
       transitions, gates, triggers at top level). v2 stores TWO fully
       independent sub-models — `fsm` and `petri` — selected by `mode`,
       and adds state `groups`. Legacy v1 files load as the PETRI
       sub-model (their flat arrays carry every Petri property), so
       nothing a user saved before is lost. */
    fileVersion: 2,

    /* Default colour for newly-created groups. Cycled through this
       palette so consecutive groups don't collide visually. Tuned to
       sit calmly against the gainsboro / slate canvas. */
    groupColors: [
        '#6b7689', '#7c8aa0', '#5f8a78', '#9a7f8c',
        '#8a8466', '#6f8499', '#a07d6b', '#7a8c6e'
    ],

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
