/**
 * Rulebook — all DOM.
 *
 * No SillyTavern imports: the caller supplies the view object, a `dispatch`
 * callback and the modal paints itself. The harness loads this exact file.
 */

import { CATEGORIES, STRENGTHS, filterRules, tokenEstimate } from './rules.js';
import { DIRECTIONS } from './generate.js';

const ICONS = {
    scale: 'fa-scale-balanced',
    x: 'fa-xmark',
    plus: 'fa-plus',
    pen: 'fa-pen',
    copy: 'fa-clone',
    trash: 'fa-trash-can',
    pin: 'fa-thumbtack',
    wand: 'fa-wand-magic-sparkles',
    book: 'fa-book',
    list: 'fa-list-check',
    eye: 'fa-eye',
    chat: 'fa-comment-dots',
    download: 'fa-file-arrow-down',
    upload: 'fa-file-arrow-up',
    alert: 'fa-triangle-exclamation',
    check: 'fa-check',
    power: 'fa-power-off',
    spinner: 'fa-spinner',
    chevron: 'fa-chevron-right',
};

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[character]));
}

function icon(name, extra = '') {
    return `<i class="fa-solid ${ICONS[name] ?? name} ${extra}" aria-hidden="true"></i>`;
}

function categoryLabel(id) {
    return CATEGORIES.find(entry => entry.id === id)?.label ?? 'Other';
}

function strengthLabel(id) {
    return STRENGTHS.find(entry => entry.id === id)?.label ?? 'Always';
}

function relTime(stamp) {
    const value = Number(stamp) || 0;
    if (!value) {
        return '';
    }
    const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
    if (seconds < 90) {
        return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 36) {
        return `${hours}h ago`;
    }
    return `${Math.round(hours / 24)}d ago`;
}

function overrideLabel(rule) {
    if (!rule.overridden) {
        return 'Follows the global switch';
    }
    return rule.effective ? 'Forced on in this chat' : 'Forced off in this chat';
}

/* ---------------------------------------------------------------------- HUD */

export function buildHud({ view, dispatch }) {
    if (!view.hud.enabled) {
        return null;
    }
    const pinned = view.rules.filter(rule => rule.pinned);
    if (!pinned.length) {
        return null;
    }

    const root = document.createElement('div');
    root.className = `rb-hud${view.hud.expanded ? ' is-open' : ''}`;
    root.dataset.ref = 'hud';

    const chips = pinned.map(rule => `
        <button type="button" class="rb-hud-chip${rule.effective ? ' is-on' : ''}" data-act="toggle-global" data-id="${esc(rule.id)}" title="${esc(rule.label)} — ${rule.effective ? 'on' : 'off'}">
            ${icon(rule.effective ? 'check' : 'power')}<span>${esc(rule.label)}</span>
        </button>`).join('');

    root.innerHTML = `
        <button type="button" class="rb-hud-pill" data-act="hud-expand" aria-expanded="${view.hud.expanded ? 'true' : 'false'}">
            ${icon('scale')}<span>${view.activeCount}</span>
        </button>
        <div class="rb-hud-panel">
            <div class="rb-hud-head">
                <span>${view.activeCount} of ${view.totalCount} rules on</span>
                <button type="button" class="rb-icon-btn" data-act="open-modal" aria-label="Open Rulebook">${icon('book')}</button>
            </div>
            <div class="rb-hud-chips">${chips}</div>
            <div class="rb-hud-foot">${view.tokens} tok in the prompt</div>
        </div>`;

    root.addEventListener('click', event => {
        const button = event.target.closest('[data-act]');
        if (!button) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        dispatch(button.dataset.act, { id: button.dataset.id });
    });

    return root;
}

/* -------------------------------------------------------------------- modal */

export function buildModal({ getView, dispatch }) {
    const root = document.createElement('div');
    root.className = 'rb-root rb-modal';
    root.innerHTML = `
        <header class="rb-head">
            <div class="rb-head-text">
                <div class="rb-eyebrow">${icon('scale')}<span>Rulebook</span></div>
                <h3 class="rb-title">World rules</h3>
                <p class="rb-sub" data-ref="sub"></p>
            </div>
            <button type="button" class="rb-icon-btn" data-act="close" aria-label="Close" title="Close">${icon('x')}</button>
        </header>
        <nav class="rb-tabs" role="tablist">
            <button type="button" class="rb-tab" data-act="tab" data-tab="rules" role="tab">${icon('list')}<span>Rules</span></button>
            <button type="button" class="rb-tab" data-act="tab" data-tab="sets" role="tab">${icon('book')}<span>Sets</span></button>
            <button type="button" class="rb-tab" data-act="tab" data-tab="compose" role="tab">${icon('eye')}<span>Compose</span></button>
            <button type="button" class="rb-tab" data-act="tab" data-tab="author" role="tab">${icon('wand')}<span>Author</span></button>
        </nav>
        <div class="rb-body" data-ref="body"></div>
        <footer class="rb-foot">
            <span class="rb-note" data-ref="foot"></span>
            <div class="rb-foot-actions">
                <button type="button" class="rb-btn" data-act="export">${icon('download')}<span>Export</span></button>
                <button type="button" class="rb-btn" data-act="import">${icon('upload')}<span>Import</span></button>
                <button type="button" class="rb-btn rb-btn-primary" data-act="close">Done</button>
            </div>
        </footer>
        <input type="file" accept="application/json,.json" class="rb-file" data-ref="file" hidden>`;

    const body = root.querySelector('[data-ref="body"]');
    const sub = root.querySelector('[data-ref="sub"]');
    const foot = root.querySelector('[data-ref="foot"]');
    const fileInput = root.querySelector('[data-ref="file"]');

    let tab = 'rules';
    let editorId = null;
    let search = '';
    let category = 'all';
    let onlyOn = false;
    let aiKind = 'author';
    let aiCount = 3;
    let lastCandidates = 0;

    /* -------------------------------------------------------------- painting */

    function snapshotFocus() {
        const active = document.activeElement;
        if (!active || !root.contains(active)) {
            return null;
        }
        const holder = active.closest('[data-fkey]');
        if (!holder) {
            return null;
        }
        return {
            key: holder.dataset.fkey,
            start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
            end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
            scroll: root.querySelector('[data-ref="body"]')?.scrollTop ?? 0,
        };
    }

    function restoreFocus(state) {
        if (!state) {
            return;
        }
        const holder = root.querySelector(`[data-fkey="${state.key}"]`);
        if (holder) {
            holder.focus({ preventScroll: true });
            if (state.start !== null && typeof holder.setSelectionRange === 'function') {
                try {
                    holder.setSelectionRange(state.start, state.end ?? state.start);
                } catch {
                    /* not a text input */
                }
            }
        }
        const scroller = root.querySelector('[data-ref="body"]');
        if (scroller) {
            scroller.scrollTop = state.scroll;
        }
    }

    function paint() {
        const view = getView();
        const focus = snapshotFocus();

        root.querySelectorAll('.rb-tab').forEach(button => {
            const active = button.dataset.tab === tab;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
        });

        sub.textContent = view.chatTitle
            ? `${view.chatTitle} · ${view.activeCount} of ${view.totalCount} rules on · ${view.tokens} token${view.tokens === 1 ? '' : 's'}`
            : `${view.activeCount} of ${view.totalCount} rules on · ${view.tokens} tokens`;

        foot.textContent = view.overrides
            ? `${view.overrides} per-chat override${view.overrides === 1 ? '' : 's'} active in this chat`
            : 'Changes apply immediately. Closing keeps everything.';

        if (editorId !== null) {
            body.innerHTML = editorView(view);
        } else if (tab === 'rules') {
            body.innerHTML = rulesView(view);
        } else if (tab === 'sets') {
            body.innerHTML = setsView(view);
        } else if (tab === 'compose') {
            body.innerHTML = composeView(view);
        } else {
            body.innerHTML = authorView(view);
        }

        restoreFocus(focus);

        // Drafts land below the fold; without this the panel looks like it did
        // nothing for a second after the model answers.
        if (tab === 'author' && editorId === null && view.ai.candidates.length > lastCandidates) {
            const scroller = root.querySelector('[data-ref="body"]');
            if (scroller) {
                scroller.scrollTop = scroller.scrollHeight;
            }
        }
        lastCandidates = view.ai.candidates.length;
    }

    /* ------------------------------------------------------------ rules tab */

    // Search, category and the only-on filter live here, in the modal, so typing
    // never has to round-trip through the extension's settings.
    function visibleFor(view) {
        return filterRules(view.rules, { query: search, category, onlyOn });
    }

    function rulesView(view) {
        const visible = visibleFor(view);
        const rows = visible.length
            ? visible.map(rule => rowView(rule)).join('')
            : `<div class="rb-empty">
                    ${view.totalCount
                        ? 'No rule matches that filter.'
                        : 'No rules yet. Write one, or let the AI draft a few — the Author tab is one click away.'}
                    <button type="button" class="rb-btn rb-btn-primary" data-act="new">${icon('plus')}<span>New rule</span></button>
               </div>`;

        return `
            <div class="rb-toolbar">
                <div class="rb-search">
                    <input type="text" class="rb-input" data-fkey="search" data-field="search" value="${esc(search)}" placeholder="Search rules, tags, topics…" aria-label="Search rules">
                </div>
                <button type="button" class="rb-btn rb-btn-primary" data-act="new">${icon('plus')}<span>New</span></button>
            </div>
            <div class="rb-filterbar">
                <button type="button" class="rb-chip${category === 'all' ? ' is-on' : ''}" data-act="filter-cat" data-cat="all">All <span class="rb-chip-count">${view.totalCount}</span></button>
                ${CATEGORIES.map(entry => {
                    const count = view.rules.filter(rule => rule.category === entry.id).length;
                    if (!count) {
                        return '';
                    }
                    return `<button type="button" class="rb-chip${category === entry.id ? ' is-on' : ''}" data-act="filter-cat" data-cat="${entry.id}">${esc(entry.label)} <span class="rb-chip-count">${count}</span></button>`;
                }).join('')}
                <button type="button" class="rb-chip rb-chip-quiet${onlyOn ? ' is-on' : ''}" data-act="only-on" aria-pressed="${onlyOn ? 'true' : 'false'}">Only on</button>
            </div>
            ${view.conflicts.length ? `
                <div class="rb-warn">
                    ${icon('alert')}
                    <div>
                        <strong>${view.conflicts.length} conflict${view.conflicts.length === 1 ? '' : 's'} in the active set</strong>
                        <span>${view.conflicts.map(entry => esc(entry.group)).join(', ')} — see Compose.</span>
                    </div>
                </div>` : ''}
            <div class="rb-list">${rows}</div>`;
    }

    function rowView(rule) {
        const tokens = tokenEstimate(rule.text);
        const meta = [
            `<span class="rb-badge is-${rule.strength}">${esc(strengthLabel(rule.strength))}</span>`,
            `<span class="rb-badge is-cat">${esc(categoryLabel(rule.category))}</span>`,
            rule.source === 'ai' ? '<span class="rb-badge is-ai">AI</span>' : '',
            (rule.tags ?? []).slice(0, 3).map(tag => `<span class="rb-tag">#${esc(tag)}</span>`).join(''),
        ].filter(Boolean).join('');

        return `
            <div class="rb-row${rule.effective ? ' is-on' : ''}${rule.overridden ? ' is-overridden' : ''}" data-id="${esc(rule.id)}">
                <button type="button" class="rb-switch" data-act="toggle-global" data-id="${esc(rule.id)}" role="switch" aria-checked="${rule.effective ? 'true' : 'false'}" aria-label="${esc(rule.label)} — ${rule.effective ? 'on' : 'off'}" title="Global switch">
                    <span class="rb-switch-dot"></span>
                </button>
                <div class="rb-row-main" data-act="edit" data-id="${esc(rule.id)}" role="button" tabindex="0">
                    <div class="rb-row-label">${esc(rule.label)}</div>
                    <div class="rb-row-text">${esc(rule.text)}</div>
                    <div class="rb-row-meta">${meta}<span class="rb-dim">${tokens} tok</span></div>
                </div>
                <div class="rb-row-tools">
                    <button type="button" class="rb-mini${rule.overridden ? ' is-live' : ''}" data-act="cycle-override" data-id="${esc(rule.id)}" title="${esc(overrideLabel(rule))} — click to cycle: follow global → force on → force off" aria-label="Per-chat override">${icon('chat')}</button>
                    <button type="button" class="rb-mini${rule.pinned ? ' is-live' : ''}" data-act="pin" data-id="${esc(rule.id)}" title="${rule.pinned ? 'Unpin from the chat HUD' : 'Pin to the chat HUD'}" aria-label="Pin">${icon('pin')}</button>
                    <button type="button" class="rb-mini" data-act="duplicate" data-id="${esc(rule.id)}" title="Duplicate" aria-label="Duplicate">${icon('copy')}</button>
                    <button type="button" class="rb-mini rb-danger" data-act="delete" data-id="${esc(rule.id)}" title="Delete" aria-label="Delete">${icon('trash')}</button>
                </div>
            </div>`;
    }

    /* ----------------------------------------------------------- editor view */

    function editorView(view) {
        const rule = editorId === 'new'
            ? { id: 'new', label: '', text: '', category: 'style', strength: 'hard', group: '', stance: '', tags: [], pinned: false, source: 'hand' }
            : view.rules.find(entry => entry.id === editorId) ?? null;

        if (!rule) {
            return '<div class="rb-empty">That rule is gone. <button type="button" class="rb-btn" data-act="cancel-edit">Back to the list</button></div>';
        }

        const tagText = (rule.tags ?? []).join(', ');

        return `
            <div class="rb-editor">
                <div class="rb-editor-head">
                    <button type="button" class="rb-back" data-act="cancel-edit">${icon('chevron')}<span>All rules</span></button>
                    <span class="rb-dim">${editorId === 'new' ? 'New rule' : `Edited ${relTime(rule.updatedAt) || 'recently'}`}</span>
                </div>
                <label class="rb-field">
                    <span class="rb-label">Name</span>
                    <input type="text" class="rb-input" data-k="label" data-fkey="edit-label" value="${esc(rule.label)}" placeholder="Instant attraction" maxlength="80">
                </label>
                <label class="rb-field">
                    <span class="rb-label">Rule <em>what the model must do</em></span>
                    <textarea class="rb-input rb-textarea" data-k="text" data-fkey="edit-text" rows="5" maxlength="4000" placeholder="Always: {{char}} is drawn to {{user}} from the first exchange…">${esc(rule.text)}</textarea>
                    <span class="rb-hint">{{char}} and {{user}} are filled in from the chat. <span data-ref="rule-tokens">${tokenEstimate(rule.text)} tok</span></span>
                </label>
                <div class="rb-grid2">
                    <label class="rb-field">
                        <span class="rb-label">Category</span>
                        <select class="rb-input" data-k="category">
                            ${CATEGORIES.map(entry => `<option value="${entry.id}"${entry.id === rule.category ? ' selected' : ''}>${esc(entry.label)}</option>`).join('')}
                        </select>
                    </label>
                    <label class="rb-field">
                        <span class="rb-label">Strength</span>
                        <select class="rb-input" data-k="strength">
                            ${STRENGTHS.map(entry => `<option value="${entry.id}"${entry.id === rule.strength ? ' selected' : ''}>${esc(entry.label)} — ${esc(entry.hint)}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="rb-grid2">
                    <label class="rb-field">
                        <span class="rb-label">Topic <em>optional</em></span>
                        <input type="text" class="rb-input" data-k="group" value="${esc(rule.group)}" placeholder="romance pace" maxlength="40">
                    </label>
                    <label class="rb-field">
                        <span class="rb-label">Stance <em>optional</em></span>
                        <input type="text" class="rb-input" data-k="stance" value="${esc(rule.stance)}" placeholder="instant" maxlength="40">
                    </label>
                </div>
                <p class="rb-hint rb-hint-block">Two <strong>enabled</strong> rules with the same topic and a different stance are reported as a conflict. Leave both blank when a rule does not control a contested topic.</p>
                <label class="rb-field">
                    <span class="rb-label">Tags <em>comma separated</em></span>
                    <input type="text" class="rb-input" data-k="tags" value="${esc(tagText)}" placeholder="romance, fast">
                </label>
                <div class="rb-editor-foot">
                    <span class="rb-dim">${editorId === 'new' ? 'Saved rules start switched on.' : ''}</span>
                    <div class="rb-foot-actions">
                        ${editorId === 'new' ? '' : `<button type="button" class="rb-btn" data-act="remix" data-id="${esc(editorId)}">${icon('wand')}<span>Remix</span></button>`}
                        <button type="button" class="rb-btn" data-act="cancel-edit">Cancel</button>
                        <button type="button" class="rb-btn rb-btn-primary" data-act="save-rule">${icon('check')}<span>${editorId === 'new' ? 'Create' : 'Save'}</span></button>
                    </div>
                </div>
            </div>`;
    }

    /* ------------------------------------------------------------- sets view */

    function setsView(view) {
        const books = view.books.length
            ? view.books.map(book => `
                <div class="rb-book" data-id="${esc(book.id)}">
                    <div class="rb-book-main">
                        <div class="rb-book-top">
                            <strong>${esc(book.name)}</strong>
                            <span class="rb-dim">${book.count} rule${book.count === 1 ? '' : 's'} · ${book.activeCount} on</span>
                        </div>
                        ${book.note ? `<p class="rb-book-note">${esc(book.note)}</p>` : ''}
                    </div>
                    <div class="rb-book-tools">
                        <button type="button" class="rb-btn" data-act="apply-book" data-id="${esc(book.id)}" data-mode="replace" title="Turn on this set and turn everything else off">Apply</button>
                        <button type="button" class="rb-btn" data-act="apply-book" data-id="${esc(book.id)}" data-mode="add" title="Turn this set on alongside whatever is already on">Add</button>
                        <button type="button" class="rb-mini rb-danger" data-act="delete-book" data-id="${esc(book.id)}" title="Delete set" aria-label="Delete set">${icon('trash')}</button>
                    </div>
                </div>`).join('')
            : '<div class="rb-empty">No sets yet. Switch on the rules you want, then save them as a set — a named mode you can jump between.</div>';

        return `
            <div class="rb-panel">
                <p class="rb-note rb-note-top">A set is a saved selection. <strong>Apply</strong> makes it the only active set; <strong>Add</strong> stacks it on top of what is already on. Per-chat overrides survive either way.</p>
                <div class="rb-savebook">
                    <input type="text" class="rb-input" data-fkey="book-name" data-ref="book-name" placeholder="Name this selection — e.g. Slow romance" maxlength="60">
                    <button type="button" class="rb-btn rb-btn-primary" data-act="save-book">${icon('plus')}<span>Save current</span></button>
                </div>
                <div class="rb-books">${books}</div>
            </div>
            <div class="rb-panel">
                <h4 class="rb-h4">Selection</h4>
                <p class="rb-hint">${view.activeCount} of ${view.totalCount} rules are on${view.overrides ? `, with ${view.overrides} overridden in this chat` : ''}.</p>
                <div class="rb-foot-actions">
                    <button type="button" class="rb-btn" data-act="all-on">Turn all on</button>
                    <button type="button" class="rb-btn" data-act="all-off">Turn all off</button>
                    ${view.overrides ? '<button type="button" class="rb-btn rb-danger" data-act="clear-overrides">Clear chat overrides</button>' : ''}
                </div>
            </div>`;
    }

    /* ---------------------------------------------------------- compose view */

    function composeView(view) {
        const percent = view.contextMax > 0 ? Math.min(100, Math.round((view.tokens / view.contextMax) * 1000) / 10) : null;
        const inChat = view.inject.position === 'in_chat';
        const conflicts = view.conflicts.length
            ? view.conflicts.map(entry => `
                <div class="rb-conflict">
                    ${icon('alert')}
                    <div>
                        <strong>${esc(entry.group)}</strong>
                        <span>${entry.rules.map(rule => `${esc(rule.label)} (${esc(rule.stance)})`).join(' vs ')}</span>
                    </div>
                </div>`).join('')
            : `<p class="rb-hint">${icon('check')} No contradictions in the active set.</p>`;

        return `
            <div class="rb-stats">
                <div class="rb-stat"><span class="rb-stat-num">${view.tokens}</span><span class="rb-stat-key">tokens</span></div>
                <div class="rb-stat"><span class="rb-stat-num">${percent === null ? '—' : `${percent}%`}</span><span class="rb-stat-key">of context</span></div>
                <div class="rb-stat"><span class="rb-stat-num">${view.activeCount}</span><span class="rb-stat-key">rules on</span></div>
                <div class="rb-stat"><span class="rb-stat-num">${view.overrides}</span><span class="rb-stat-key">chat overrides</span></div>
            </div>
            ${percent !== null && percent >= 10 ? `<div class="rb-warn">${icon('alert')}<div><strong>${percent}% of the context is rules</strong><span>Every turn pays this before the story starts. Consider moving style rules into a set you switch on only when you need them.</span></div></div>` : ''}
            <div class="rb-panel">
                <h4 class="rb-h4">Conflicts</h4>
                ${conflicts}
            </div>
            <div class="rb-panel">
                <h4 class="rb-h4">Where it goes</h4>
                <div class="rb-grid3">
                    <label class="rb-field">
                        <span class="rb-label">Position</span>
                        <select class="rb-input" data-field="position">
                            <option value="in_prompt"${view.inject.position === 'in_prompt' ? ' selected' : ''}>Main prompt (cache friendly)</option>
                            <option value="in_chat"${view.inject.position === 'in_chat' ? ' selected' : ''}>In chat</option>
                            <option value="before_prompt"${view.inject.position === 'before_prompt' ? ' selected' : ''}>Before main prompt</option>
                        </select>
                    </label>
                    <label class="rb-field${inChat ? '' : ' is-off'}">
                        <span class="rb-label">Depth</span>
                        <input type="number" class="rb-input" data-field="depth" min="0" max="20" value="${view.inject.depth}" ${inChat ? '' : 'disabled'}>
                    </label>
                    <label class="rb-field${inChat ? '' : ' is-off'}">
                        <span class="rb-label">Role</span>
                        <select class="rb-input" data-field="role" ${inChat ? '' : 'disabled'}>
                            <option value="0"${Number(view.inject.role) === 0 ? ' selected' : ''}>System</option>
                            <option value="1"${Number(view.inject.role) === 1 ? ' selected' : ''}>User</option>
                            <option value="2"${Number(view.inject.role) === 2 ? ' selected' : ''}>Assistant</option>
                        </select>
                    </label>
                </div>
                <p class="rb-hint">Rules belong in the <strong>main prompt</strong> with the <strong>system</strong> role: the block is static, so keeping it in the prefix keeps the prompt cache warm, and the model reads it as instruction rather than as something a character said. <strong>Depth</strong> only applies to <em>In chat</em> — it counts messages back from the end; <strong>role</strong> is the message role the block is inserted as. Some backends reject a system message mid-conversation, which is when <em>User</em> is the right answer.</p>
                <label class="rb-field">
                    <span class="rb-label">Template <em>{{rules}} is where the rules land</em></span>
                    <textarea class="rb-input rb-textarea rb-mono" data-ref="template" data-fkey="template" rows="4">${esc(view.inject.template)}</textarea>
                </label>
                <div class="rb-foot-actions">
                    <button type="button" class="rb-btn" data-act="save-template">Apply template</button>
                    <button type="button" class="rb-btn" data-act="reset-template">Reset to default</button>
                </div>
            </div>
            <div class="rb-panel">
                <div class="rb-h4-row">
                    <h4 class="rb-h4">Exactly what the model sees</h4>
                    <button type="button" class="rb-btn" data-act="copy-preview">${icon('copy')}<span>Copy</span></button>
                </div>
                ${view.preview
                    ? `<pre class="rb-preview" data-ref="preview">${esc(view.preview)}</pre>`
                    : '<p class="rb-hint">Nothing is active, so nothing is injected — the prompt key is cleared.</p>'}
            </div>`;
    }

    /* ----------------------------------------------------------- author view */

    function authorView(view) {
        const ai = view.ai;
        const running = ai.status === 'running';

        const candidates = ai.candidates.length
            ? ai.candidates.map((candidate, index) => `
                <label class="rb-cand" data-idx="${index}">
                    <input type="checkbox" class="rb-cand-check" data-idx="${index}" ${candidate.checked ? 'checked' : ''}>
                    <div class="rb-cand-main">
                        <div class="rb-cand-top">
                            <strong>${esc(candidate.label)}</strong>
                            <span class="rb-badge is-${candidate.strength}">${esc(strengthLabel(candidate.strength))}</span>
                            <span class="rb-badge is-cat">${esc(categoryLabel(candidate.category))}</span>
                            ${candidate.group ? `<span class="rb-dim">${esc(candidate.group)} · ${esc(candidate.stance || '—')}</span>` : ''}
                        </div>
                        <p class="rb-cand-text">${esc(candidate.text)}</p>
                    </div>
                </label>`).join('')
            : '';

        const kindSwitch = `
            <div class="rb-seg" role="group" aria-label="What to convert">
                <button type="button" class="rb-seg-btn${aiKind === 'author' ? ' is-on' : ''}" data-act="ai-kind" data-kind="author">Describe it</button>
                <button type="button" class="rb-seg-btn${aiKind === 'atomize' ? ' is-on' : ''}" data-act="ai-kind" data-kind="atomize">Paste a prompt</button>
            </div>`;

        const placeholder = ai.baseRuleId
            ? 'Optional: keep the same meaning but make it drier, or shorter.'
            : aiKind === 'author'
                ? 'She falls for him instantly and is bad at hiding it. No purple prose.'
                : 'Paste the whole messy prompt or note here — it will be split into single rules.';

        const remixBar = ai.baseRuleId && view.rules.some(rule => rule.id === ai.baseRuleId)
            ? `<div class="rb-remixbar">
                   ${icon('wand')}
                   <span>Remixing <strong>${esc(view.rules.find(rule => rule.id === ai.baseRuleId).label)}</strong></span>
                   <div class="rb-seg">
                       ${DIRECTIONS.map(entry => `<button type="button" class="rb-seg-btn${ai.direction === entry.id ? ' is-on' : ''}" data-act="ai-direction" data-direction="${entry.id}">${esc(entry.label)}</button>`).join('')}
                   </div>
                   <button type="button" class="rb-mini" data-act="ai-clear" title="Stop remixing" aria-label="Stop remixing">${icon('x')}</button>
               </div>`
            : '';

        return `
            <div class="rb-panel">
                <p class="rb-note rb-note-top">Rules are written with <strong>{{char}}</strong> and <strong>{{user}}</strong> instead of names, so one rule works across cards. Nothing is added until you tick it.</p>
                ${remixBar}
                ${ai.baseRuleId ? '' : kindSwitch}
                <label class="rb-field">
                    <span class="rb-label">${ai.baseRuleId ? 'Direction note <em>optional</em>' : aiKind === 'author' ? 'Description' : 'Prompt dump'}</span>
                    <textarea class="rb-input rb-textarea" data-ref="ai-input" data-fkey="ai-input" rows="${aiKind === 'atomize' && !ai.baseRuleId ? 7 : 4}" placeholder="${esc(placeholder)}">${esc(ai.description)}</textarea>
                </label>
                <div class="rb-airow">
                    <label class="rb-field rb-field-inline">
                        <span class="rb-label">How many</span>
                        <select class="rb-input rb-input-short" data-field="ai-count">
                            ${[1, 2, 3, 4, 5, 6, 8].map(value => `<option value="${value}"${value === aiCount ? ' selected' : ''}>${value}</option>`).join('')}
                        </select>
                    </label>
                    ${ai.baseRuleId ? '' : `<label class="rb-field rb-field-inline">
                        <span class="rb-label">Category</span>
                        <select class="rb-input" data-field="ai-category">
                            <option value="auto"${ai.category === 'auto' ? ' selected' : ''}>Let it choose</option>
                            ${CATEGORIES.map(entry => `<option value="${entry.id}"${ai.category === entry.id ? ' selected' : ''}>${esc(entry.label)}</option>`).join('')}
                        </select>
                    </label>`}
                    <button type="button" class="rb-btn rb-btn-primary rb-ai-run" data-act="ai-run" ${running ? 'disabled' : ''}>
                        ${running ? `${icon('spinner', 'fa-spin')}<span>Thinking…</span>` : `${icon('wand')}<span>${ai.baseRuleId ? 'Remix' : aiKind === 'author' ? 'Draft rules' : 'Split it up'}</span>`}
                    </button>
                </div>
                ${ai.status === 'error' ? `<div class="rb-warn is-error">${icon('alert')}<div><strong>Nothing was added</strong><span>${esc(ai.error)}</span></div></div>` : ''}
            </div>
            ${ai.candidates.length ? `
                <div class="rb-panel">
                    <div class="rb-h4-row">
                        <h4 class="rb-h4">${ai.candidates.length} draft${ai.candidates.length === 1 ? '' : 's'}</h4>
                        <div class="rb-foot-actions">
                            <button type="button" class="rb-btn" data-act="ai-toggle-all">Toggle all</button>
                            <button type="button" class="rb-btn rb-btn-primary" data-act="ai-add" data-mode="checked">${icon('plus')}<span>Add selected</span></button>
                        </div>
                    </div>
                    <div class="rb-cands">${candidates}</div>
                </div>` : ''}`;
    }

    /* --------------------------------------------------------------- events */

    root.addEventListener('click', event => {
        const button = event.target.closest('[data-act]');
        if (!button || !root.contains(button)) {
            return;
        }
        const action = button.dataset.act;
        const id = button.dataset.id;

        switch (action) {
            case 'close':
                dispatch('close');
                return;
            case 'tab':
                tab = button.dataset.tab;
                editorId = null;
                paint();
                return;
            case 'new':
                editorId = 'new';
                paint();
                return;
            case 'edit':
                editorId = id;
                paint();
                return;
            case 'cancel-edit':
                editorId = null;
                paint();
                return;
            case 'save-rule': {
                const patch = readEditor();
                if (!patch.text) {
                    body.querySelector('[data-k="text"]')?.focus();
                    return;
                }
                dispatch(editorId === 'new' ? 'rule-create' : 'rule-save', { id: editorId === 'new' ? null : editorId, patch });
                editorId = null;
                paint();
                return;
            }
            case 'filter-cat':
                category = button.dataset.cat;
                paint();
                return;
            case 'only-on':
                onlyOn = !onlyOn;
                paint();
                return;
            case 'toggle-global':
            case 'pin':
            case 'duplicate':
            case 'delete':
            case 'cycle-override':
                dispatch(action, { id });
                paint();
                return;
            case 'remix':
                dispatch('ai-remix', { id });
                tab = 'author';
                editorId = null;
                paint();
                return;
            case 'apply-book':
                dispatch('apply-book', { id, mode: button.dataset.mode });
                paint();
                return;
            case 'delete-book':
                dispatch('delete-book', { id });
                paint();
                return;
            case 'save-book': {
                const input = root.querySelector('[data-ref="book-name"]');
                const name = String(input?.value ?? '').trim();
                if (!name) {
                    input?.focus();
                    return;
                }
                dispatch('save-book', { name });
                paint();
                return;
            }
            case 'all-on':
            case 'all-off':
            case 'clear-overrides':
                dispatch(action);
                paint();
                return;
            case 'save-template': {
                const template = root.querySelector('[data-ref="template"]')?.value ?? '';
                dispatch('inject-patch', { template });
                paint();
                return;
            }
            case 'reset-template':
                dispatch('inject-reset');
                paint();
                return;
            case 'copy-preview':
                dispatch('copy-preview');
                return;
            case 'export':
                dispatch('export');
                return;
            case 'import':
                fileInput.click();
                return;
            case 'hud-expand':
                dispatch('hud-expand');
                return;
            case 'open-modal':
                dispatch('open-modal');
                return;
            case 'ai-kind':
                aiKind = button.dataset.kind;
                paint();
                return;
            case 'ai-direction':
                dispatch('ai-direction', { direction: button.dataset.direction });
                paint();
                return;
            case 'ai-clear':
                dispatch('ai-clear');
                paint();
                return;
            case 'ai-run': {
                const description = root.querySelector('[data-ref="ai-input"]')?.value ?? '';
                dispatch('ai-run', { description, kind: aiKind, count: aiCount });
                return;
            }
            case 'ai-toggle-all': {
                const checks = [...body.querySelectorAll('.rb-cand-check')];
                const allOn = checks.every(check => check.checked);
                checks.forEach(check => { check.checked = !allOn; });
                dispatch('ai-checked', { checked: checks.filter(check => check.checked).map(check => Number(check.dataset.idx)) });
                return;
            }
            case 'ai-add': {
                const checks = [...body.querySelectorAll('.rb-cand-check')];
                const indexes = checks.filter(check => check.checked).map(check => Number(check.dataset.idx));
                if (!indexes.length) {
                    return;
                }
                dispatch('ai-add', { indexes });
                return;
            }
            default:
                break;
        }

        if (action && action.startsWith('remix')) {
            dispatch(action, { id });
        }
    });

    root.addEventListener('input', event => {
        const field = event.target.closest('[data-field]')?.dataset.field;
        if (field === 'search') {
            search = event.target.value;
            const visible = visibleFor(getView());
            const list = body.querySelector('.rb-list');
            if (list) {
                list.innerHTML = visible.length
                    ? visible.map(rule => rowView(rule)).join('')
                    : '<div class="rb-empty">No rule matches that filter.</div>';
                return;
            }
            paint();
            return;
        }
        if (event.target.dataset.k === 'text') {
            const holder = body.querySelector('[data-ref="rule-tokens"]');
            if (holder) {
                holder.textContent = `${tokenEstimate(event.target.value)} tok`;
            }
        }
    });

    root.addEventListener('change', event => {
        const field = event.target.closest('[data-field]')?.dataset.field;
        if (field === 'position' || field === 'depth' || field === 'role') {
            const value = event.target.value;
            dispatch('inject-patch', { [field]: field === 'depth' || field === 'role' ? Number(value) : value });
            paint();
            return;
        }
        if (field === 'ai-count') {
            aiCount = Number(event.target.value);
            return;
        }
        if (field === 'ai-category') {
            dispatch('ai-category', { category: event.target.value });
            return;
        }
        if (event.target.classList.contains('rb-cand-check')) {
            dispatch('ai-checked', { checked: [...body.querySelectorAll('.rb-cand-check')].filter(check => check.checked).map(check => Number(check.dataset.idx)) });
        }
    });

    root.addEventListener('keydown', event => {
        const row = event.target.closest('.rb-row-main[data-act="edit"]');
        if (row && (event.key === 'Enter' || event.key === ' ') && event.target === row) {
            event.preventDefault();
            editorId = row.dataset.id;
            paint();
        }
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) {
            dispatch('import', { file });
        }
        fileInput.value = '';
    });

    function readEditor() {
        const get = key => body.querySelector(`[data-k="${key}"]`)?.value ?? '';
        return {
            label: get('label').trim(),
            text: get('text').trim(),
            category: get('category') || 'style',
            strength: get('strength') === 'soft' ? 'soft' : 'hard',
            group: get('group').trim(),
            stance: get('stance').trim(),
            tags: get('tags').split(',').map(tag => tag.trim()).filter(Boolean),
        };
    }

    return {
        el: root,
        paint,
        setTab(next) {
            tab = next;
            editorId = null;
            paint();
        },
        getTab: () => tab,
    };
}
