/**
 * fmt.js
 * Machine Studio [MS] — Shared formatting and id helpers.
 *
 * Tiny utility module so every other module can pull the same
 * escaping / id-generation routine without duplicating it.
 */

const fmt = (() => {

    /* HTML-escape a string for safe injection into innerHTML. */
    function escHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* Generate a short, unique id with a per-prefix incrementing
       counter. Output looks like "s_1", "t_2", "g_3", "trg_4" —
       readable and predictable. The counters live for the page
       session and are rehydrated past any existing IDs on JSON
       load via bumpUid(), so loaded files never collide with new
       items created afterwards. */
    const _counters = Object.create(null);

    function uid(prefix) {
        const p = prefix || 'id';
        _counters[p] = (_counters[p] || 0) + 1;
        return p + '_' + _counters[p];
    }

    /* Ensure the counter for `prefix` is at least `n`. Called from
       Machine.fromJSON after scanning existing IDs in a loaded file
       so subsequent uid(prefix) calls don't return values already
       taken by the loaded data. */
    function bumpUid(prefix, n) {
        const p = prefix || 'id';
        if (!_counters[p] || _counters[p] < n) _counters[p] = n;
    }

    /* Reset all counters back to zero. Used when a brand-new machine
       is created so IDs start fresh at 1. */
    function resetUid() {
        Object.keys(_counters).forEach(k => delete _counters[k]);
    }

    /* Clamp a number to a range, with fallback if NaN. */
    function clamp(n, lo, hi, fallback) {
        const x = parseFloat(n);
        if (isNaN(x)) return fallback;
        return Math.max(lo, Math.min(hi, x));
    }

    /* Parse a positive integer with a fallback. */
    function posInt(v, fallback) {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) return fallback;
        return n;
    }

    /* Build the download filename for a machine. Machine Studio saves a
       single self-contained file — both sub-models, positions, the active
       formalism — with the `.fsm` extension (the analogue of FAS's single
       project file). The payload is JSON; the extension is just `.fsm`. */
    function machineFilename(name) {
        const base = (String(name == null ? '' : name).trim()
                        .replace(/\s+/g, '_')
                        .replace(/[^\w.-]+/g, '')) || 'machine';
        return base + '.fsm';
    }

    return { escHtml, uid, bumpUid, resetUid, clamp, posInt, machineFilename };
})();
