/**
 * modal.js
 * Machine Studio [MS] — Shared modal overlay primitive.
 *
 * One overlay element, reused by every dialog (state properties,
 * transition editor, gate editor, trigger config, timer config,
 * confirm-delete). Keeping this tiny and shared stops dialogs.js
 * from growing unmanageably.
 *
 * Public:
 *   modal.init()
 *   modal.open(title, bodyHtml, buttons)   buttons:[{label,cls,onClick}]
 *   modal.setFooter(buttons)               replace footer buttons
 *   modal.body()                           the live body element
 *   modal.close()
 *
 * Closing via ✕ / backdrop / Escape simply dismisses — flows record
 * nothing unless a footer button fires, so a dismissal is always a
 * safe abort.
 */

const modal = (() => {

    let elOverlay, elTitle, elBody, elFoot;

    function init() {
        if (elOverlay) return;
        elOverlay = document.createElement('div');
        elOverlay.className = 'modal-overlay';
        elOverlay.id = 'modalOverlay';
        elOverlay.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true">
                <div class="modal-hd">
                    <span class="modal-title" id="modalTitle"></span>
                    <button class="modal-x" id="modalX" title="Close">✕</button>
                </div>
                <div class="modal-body" id="modalBody"></div>
                <div class="modal-foot" id="modalFoot"></div>
            </div>`;
        document.body.appendChild(elOverlay);

        elTitle = document.getElementById('modalTitle');
        elBody  = document.getElementById('modalBody');
        elFoot  = document.getElementById('modalFoot');

        document.getElementById('modalX').addEventListener('click', close);
        elOverlay.addEventListener('mousedown', e => {
            if (e.target === elOverlay) close();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && elOverlay.classList.contains('open')) close();
        });
    }

    function _renderFooter(buttons) {
        elFoot.innerHTML = '';
        (buttons || []).forEach(b => {
            const btn = document.createElement('button');
            btn.className   = 'btn ' + (b.cls || 'btn-sec');
            btn.textContent = b.label;
            btn.addEventListener('click', b.onClick);
            elFoot.appendChild(btn);
        });
    }

    function open(title, bodyHtml, buttons, extraClass) {
        elTitle.textContent = title;
        elBody.innerHTML    = bodyHtml;
        _renderFooter(buttons);
        const modalEl = elOverlay.querySelector('.modal');
        if (modalEl) modalEl.className = 'modal' + (extraClass ? ' ' + extraClass : '');
        elOverlay.classList.add('open');
        const first = elBody.querySelector('input,select,button,textarea');
        if (first) setTimeout(() => first.focus(), 30);
    }

    function setFooter(buttons) { _renderFooter(buttons); }

    function body() { return elBody; }

    function close() {
        elOverlay.classList.remove('open');
        elBody.innerHTML = '';
        elFoot.innerHTML = '';
    }

    return { init, open, setFooter, body, close };
})();
