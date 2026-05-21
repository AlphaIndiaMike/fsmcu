/**
 * generators/common/emit.js
 * Machine Studio [MS] — Tiny text-building helpers for code emitters.
 *
 * Public:
 *   emit.banner(title, meta)        — block-comment banner
 *   emit.section(label)             — short divider comment
 *   emit.headerGuard(symbol, body)  — wraps body in #ifndef/#define/#endif
 *   emit.indent(text, spaces)       — indent each line
 *   emit.pad(s, width)              — pad string to width
 */

const emit = (() => {

    const RULE_LONG  = '═══════════════════════════════════════════════════════════════════';
    const RULE_SHORT = '───────────────────────────────────────────────';

    function banner(title, meta) {
        const lines = ['/* ' + RULE_LONG, ' * ' + title];
        if (meta && meta.length) {
            lines.push(' *');
            meta.forEach(m => lines.push(' * ' + m));
        }
        lines.push(' * ' + RULE_LONG + ' */');
        return lines.join('\n');
    }

    function section(label) {
        return '/* ── ' + label + ' ' + RULE_SHORT.slice(0, Math.max(3, 60 - label.length)) + ' */';
    }

    function headerGuard(symbol, body) {
        return `#ifndef ${symbol}\n#define ${symbol}\n\n${body}\n\n#endif /* ${symbol} */\n`;
    }

    function indent(text, n) {
        const pad = ' '.repeat(n || 4);
        return text.split('\n').map(l => l.length ? pad + l : l).join('\n');
    }

    function pad(s, width) {
        s = String(s);
        if (s.length >= width) return s;
        return s + ' '.repeat(width - s.length);
    }

    return { banner, section, headerGuard, indent, pad };
})();
