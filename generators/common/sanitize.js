/**
 * generators/common/sanitize.js
 * Machine Studio [MS] — Name sanitization for code generation.
 *
 * User-given names ("My Trigger!", "Étape 1", "") get turned into
 * valid C identifiers and disambiguated against the symbols already
 * used in the generated unit. Language emitters share this module
 * because the rules are essentially the same for every C-family
 * target.
 *
 * Public:
 *   sanitize.toIdent(name, fallback)   → "my_trigger" / "etape_1" / fallback
 *   sanitize.toEnum(name, fallback)    → "MY_TRIGGER" / "ETAPE_1" / FALLBACK
 *   sanitize.disambiguate(base, taken) → base, base_2, base_3, ...
 */

const sanitize = (() => {

    function toIdent(name, fallback) {
        if (name == null) return fallback || 'unnamed';
        let s = String(name);

        // Strip diacritics (NFKD splits "é" into "e" + combining accent,
        // then we drop the combining range U+0300–U+036F).
        try {
            s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        } catch (e) { /* older browsers: skip */ }

        s = s.toLowerCase()
             .replace(/[^a-z0-9_]+/g, '_')   // non-alnum → underscore
             .replace(/^_+|_+$/g, '')         // strip outer underscores
             .replace(/__+/g, '_');           // collapse __ → _

        if (!s) return fallback || 'unnamed';
        if (/^[0-9]/.test(s)) s = '_' + s;   // C identifiers can't start with digit
        return s;
    }

    function toEnum(name, fallback) {
        return toIdent(name, fallback).toUpperCase();
    }

    /* Append _2, _3, ... until we find a name not in the taken set.
       Mutates `taken` to record the chosen value. */
    function disambiguate(base, taken) {
        if (!taken.has(base)) { taken.add(base); return base; }
        for (let i = 2; i < 100000; i++) {
            const cand = base + '_' + i;
            if (!taken.has(cand)) { taken.add(cand); return cand; }
        }
        return base + '_x'; // unreachable in practice
    }

    return { toIdent, toEnum, disambiguate };
})();
