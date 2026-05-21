/**
 * generators/index.js
 * Machine Studio [MS] — Code generation entry point.
 *
 * Maintains a registry of language generators. Each *_lang.js file
 * defines a module with this shape:
 *   {
 *     id: 'c',
 *     name: 'C',
 *     supportedPatterns: ['table', 'switch'],
 *     generate(ir, opts) → { ok, files?, previewFile?, error?, warnings? }
 *   }
 *
 * The dialog reads `supportedPatterns` to decide which Pattern options
 * to enable when the user picks a language.
 *
 * Public:
 *   generators.run({ machine, language, pattern, triggerApi, includes })
 *     → { ok, files, previewFile, error?, warnings? }
 *
 *   generators.languages()                — registered languages
 *   generators.language(id)               — one by id
 *
 *   generators.downloadZip(files, name)   — bundles files into a .zip
 *     via JSZip and triggers a download. Falls back to a single
 *     concatenated .txt file if JSZip is unavailable.
 *
 * Depends on: walker.js, c_lang.js, cpp_lang.js
 */

const generators = (() => {

    const registry = new Map();

    function register(lang) {
        if (!lang || !lang.id) return;
        registry.set(lang.id, lang);
    }

    function languages() {
        return Array.from(registry.values());
    }

    function language(id) {
        return registry.get(id);
    }

    function run(opts) {
        opts = opts || {};
        const lang = registry.get(opts.language);
        if (!lang) return { ok: false, error: 'Unknown language: ' + opts.language };

        const ir = walker.walk(opts.machine);
        if (!ir) return { ok: false, error: 'Could not analyze machine.' };

        return lang.generate(ir, {
            pattern:    opts.pattern    || lang.supportedPatterns[0],
            triggerApi: opts.triggerApi || 'per-trigger',
            includes:   opts.includes   || {}
        });
    }

    /* Download files as a zip via JSZip. If JSZip isn't loaded
       (unlikely — lib/jszip.min.js is bundled — but we degrade
       gracefully), concatenate everything into a single .txt with
       section banners so the user can split it manually. */
    async function downloadZip(files, basename) {
        const safeName = String(basename || 'state_machine').replace(/[^A-Za-z0-9._-]+/g, '_');

        if (typeof JSZip === 'undefined') {
            const concat = files.map(f =>
                '/* ===== ' + f.name + ' =====\n   ' +
                'JSZip not loaded — files concatenated into one. Split by these banners. */\n\n' +
                f.content
            ).join('\n\n');
            _saveBlob(new Blob([concat], { type: 'text/plain' }), safeName + '.txt');
            return;
        }

        const zip = new JSZip();
        const folder = zip.folder(safeName);
        files.forEach(f => folder.file(f.name, f.content));
        const blob = await zip.generateAsync({ type: 'blob' });
        _saveBlob(blob, safeName + '.zip');
    }

    function _saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    return { register, languages, language, run, downloadZip };
})();

/* Synchronous registration — each *_lang.js script tag has already
   executed by the time this file runs, so the globals exist. */
if (typeof c_lang   !== 'undefined') generators.register(c_lang);
if (typeof cpp_lang !== 'undefined') generators.register(cpp_lang);
