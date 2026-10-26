/**
 * Rulebook — a library of world rules for SillyTavern.
 *
 * Rules are behavioural instructions ("the character falls for you instantly",
 * "never write purple prose"), each with its own switch. They compose into one
 * prompt block, group into switchable sets, and can be overridden per chat.
 *
 * The heavy lifting lives in src/: rules.js (model), generate.js (AI authoring),
 * ui.js (DOM). This file owns SillyTavern — settings, chat metadata, injection.
 */

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import * as stApp from '../../../../script.js';
import {
    DEFAULT_TEMPLATE,
    EXTENSION_FOLDER,
    EXTENSION_KEY,
    INJECT_KEY,
    META_KEY,
    applyBook,
    composeRules,
    createRule,
    exportPack,
    findConflicts,
    importPack,
    moveRule,
    normalizeOverrides,
    normalizeSettings,
    removeRule,
    saveBook,
    setOverride,
    starterRules,
    tokenEstimate,
    withEffective,
} from './src/rules.js';
import {
    RulebookParseError,
    buildAtomizePrompt,
    buildAuthorPrompt,
    buildRemixPrompt,
    parseRulesResponse,
} from './src/generate.js';
import { buildHud, buildModal } from './src/ui.js';

const LOG = '[Rulebook]';
const MENU_ICON = 'fa-scale-balanced';

/* ------------------------------------------------------------------ plumbing */

const settings = normalizeSettings(extension_settings[EXTENSION_KEY] ?? (extension_settings[EXTENSION_KEY] = {}));
extension_settings[EXTENSION_KEY] = settings;

let overrides = {};
let hud = null;
let modal = null;
let popup = null;
let booted = false;
let lastView = null;

const ai = {
    status: 'idle',
    kind: 'author',
    description: '',
    count: 3,
    category: 'auto',
    direction: 'softer',
    baseRuleId: null,
    candidates: [],
    error: '',
};

function saveSettings() {
    try {
        stApp.saveSettingsDebounced?.();
    } catch (error) {
        console.warn(LOG, 'could not save settings', error);
    }
}

function toast(kind, text) {
    try {
        window.toastr?.[kind]?.(text, 'Rulebook');
    } catch {
        /* toasts are cosmetic */
    }
}

function chatBag() {
    const context = getContext();
    const bag = context.chatMetadata ?? window.chatMetadata ?? window.chat_metadata;
    return bag && typeof bag === 'object' ? bag : null;
}

function saveMetadata() {
    const context = getContext();
    const save = context.saveMetadataDebounced
        ?? context.saveMetadata
        ?? window.saveMetadataDebounced
        ?? window.saveMetadata;
    if (typeof save === 'function') {
        save();
        return;
    }
    saveSettings();
}

function loadOverrides() {
    const bag = chatBag();
    overrides = normalizeOverrides(bag?.[META_KEY]?.overrides, settings.rules);
}

function persistOverrides() {
    const bag = chatBag();
    if (!bag) {
        return;
    }
    const current = bag[META_KEY] && typeof bag[META_KEY] === 'object' ? bag[META_KEY] : {};
    bag[META_KEY] = { ...current, overrides };
    try {
        saveMetadata();
    } catch (error) {
        console.warn(LOG, 'could not save chat metadata', error);
    }
}

function contextSize() {
    return Number(stApp.max_context ?? getContext().maxContext ?? 0) || 0;
}

/* ---------------------------------------------------------------------- view */

function buildView() {
    const context = getContext();
    const rules = withEffective(settings.rules, overrides);
    const preview = composeRules(rules, {
        template: settings.inject.template,
        charName: context.name2 || '',
        userName: context.name1 || '',
    });

    const bookCounts = new Map();
    for (const rule of rules.filter(entry => entry.effective)) {
        for (const book of settings.books) {
            if (book.ruleIds.includes(rule.id)) {
                bookCounts.set(book.id, (bookCounts.get(book.id) ?? 0) + 1);
            }
        }
    }

    return {
        rules,
        books: settings.books.map(book => ({
            ...book,
            count: book.ruleIds.length,
            activeCount: bookCounts.get(book.id) ?? 0,
        })),
        activeCount: rules.filter(rule => rule.effective).length,
        totalCount: rules.length,
        tokens: settings.inject.enabled ? tokenEstimate(preview) : 0,
        contextMax: contextSize(),
        conflicts: findConflicts(rules),
        preview: settings.inject.enabled ? preview : '',
        inject: settings.inject,
        hud: settings.hud,
        overrides: Object.keys(overrides).length,
        chatTitle: context.name2 || '',
        ai,
    };
}

/* ----------------------------------------------------------------- injection */

function injectView(view) {
    if (typeof stApp.setExtensionPrompt !== 'function') {
        return;
    }
    const types = stApp.extension_prompt_types ?? {};
    const inPrompt = types.IN_PROMPT ?? 0;
    const inChat = types.IN_CHAT ?? 1;
    const beforePrompt = types.BEFORE_PROMPT ?? 2;

    const position = settings.inject.position === 'in_chat'
        ? inChat
        : settings.inject.position === 'before_prompt' ? beforePrompt : inPrompt;
    const depth = position === inChat ? settings.inject.depth : 0;

    try {
        // An empty string is the only way to clear the key: leaving the previous
        // chat's rules in place is the one bug nobody notices until the story drifts.
        stApp.setExtensionPrompt(
            INJECT_KEY,
            view.preview || '',
            position,
            depth,
            false,
            Number(settings.inject.role) || 0,
        );
    } catch (error) {
        console.warn(LOG, 'could not inject the rules', error);
    }
}

/* ---------------------------------------------------------------------- HUD */

let hudObserver = null;

/**
 * The HUD sits above the message box, whose height changes the moment a long
 * message is typed. Watch it instead of measuring once, or the chip ends up
 * underneath the textarea.
 */
function placeHud() {
    if (!hud) {
        return;
    }
    const sendForm = document.getElementById('send_form');
    const height = sendForm?.getBoundingClientRect().height || 0;
    hud.style.setProperty('--rb-hud-bottom', `${Math.round(height + 12)}px`);
}

function mountHud(view) {
    hud?.remove();
    hud = null;
    hudObserver?.disconnect();
    hudObserver = null;

    const element = buildHud({ view, dispatch });
    if (!element) {
        return;
    }

    document.body.append(element);
    hud = element;
    placeHud();

    const sendForm = document.getElementById('send_form');
    if (typeof ResizeObserver === 'function' && sendForm) {
        hudObserver = new ResizeObserver(() => placeHud());
        hudObserver.observe(sendForm);
    }
}

/* -------------------------------------------------------------------- modal */

function openModal() {
    if (popup) {
        return;
    }

    const instance = buildModal({ getView: buildView, dispatch });
    const host = document.createElement('div');
    host.className = 'rb-popup';
    host.append(instance.el);

    const dialog = new Popup(host, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    popup = dialog;
    modal = instance;
    // Marked so style.css can suppress ST's own close button for this dialog only.
    dialog.dlg?.classList?.add?.('rb-dialog');
    instance.paint();

    Promise.resolve(dialog.show()).finally(() => {
        popup = null;
        modal = null;
    });
}

function closeModal() {
    popup?.complete?.(POPUP_RESULT.AFFIRMATIVE);
    popup = null;
    modal = null;
}

/* ------------------------------------------------------------------- refresh */

function refresh() {
    lastView = buildView();
    injectView(lastView);
    mountHud(lastView);
    modal?.paint();
    updateReadout(lastView);
}

function updateReadout(view) {
    const element = document.getElementById('rb-readout');
    if (!element) {
        return;
    }
    const percent = view.contextMax > 0 ? Math.round((view.tokens / view.contextMax) * 1000) / 10 : null;
    element.textContent = `${view.activeCount} of ${view.totalCount} rules on · ${view.tokens} tok${percent === null ? '' : ` · ${percent}% of context`}`;
}

/* --------------------------------------------------------------------- rules */

function findRule(idOrLabel) {
    const needle = String(idOrLabel ?? '').trim().toLowerCase();
    if (!needle) {
        return null;
    }
    const byId = settings.rules.find(rule => rule.id.toLowerCase() === needle);
    if (byId) {
        return byId;
    }
    const byLabel = settings.rules.find(rule => rule.label.toLowerCase() === needle);
    if (byLabel) {
        return byLabel;
    }
    return settings.rules.find(rule => rule.label.toLowerCase().includes(needle)) ?? null;
}

function setRuleEffective(id, value) {
    const rule = settings.rules.find(entry => entry.id === id);
    if (!rule) {
        return;
    }
    if (typeof overrides[id] === 'boolean') {
        overrides = setOverride(overrides, id, value);
        persistOverrides();
        return;
    }
    rule.enabled = Boolean(value);
    rule.updatedAt = Date.now();
    saveSettings();
}

function cycleOverride(id) {
    const rule = settings.rules.find(entry => entry.id === id);
    if (!rule) {
        return;
    }
    const current = overrides[id];
    const next = current === undefined ? !rule.enabled : current === true ? false : null;
    overrides = setOverride(overrides, id, next);
    persistOverrides();
    toast('info', next === null
        ? `"${rule.label}" follows the global switch again.`
        : `"${rule.label}" forced ${next ? 'on' : 'off'} in this chat.`);
}

function friendlyError(error) {
    if (error instanceof RulebookParseError) {
        return error.message;
    }
    const message = String(error?.message ?? error ?? 'Unknown error');
    if (/abort|stop/i.test(message)) {
        return 'Generation stopped.';
    }
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/* ------------------------------------------------------------------------ AI */

async function callModel(prompt) {
    if (typeof stApp.generateRaw !== 'function') {
        throw new Error('This SillyTavern build has no generateRaw — update SillyTavern.');
    }
    const raw = await stApp.generateRaw({ prompt });

    if (typeof raw !== 'string') {
        throw new Error('The model returned nothing.');
    }
    return raw;
}

async function runAi({ description, kind, count } = {}) {
    if (ai.status === 'running') {
        return;
    }
    const text = String(description ?? ai.description ?? '').trim();
    const base = ai.baseRuleId ? settings.rules.find(rule => rule.id === ai.baseRuleId) : null;

    if (!base && !text) {
        toast('warning', 'Write what you want first — one line is enough.');
        return;
    }

    ai.status = 'running';
    ai.description = text;
    ai.kind = kind ?? ai.kind;
    ai.count = Math.max(1, Math.min(8, Number(count) || ai.count));
    ai.error = '';
    ai.candidates = [];
    refresh();

    try {
        const prompt = base
            ? buildRemixPrompt({ rule: base, direction: ai.direction, count: ai.count })
            : ai.kind === 'atomize'
                ? buildAtomizePrompt({ blob: text, count: ai.count })
                : buildAuthorPrompt({ description: text, count: ai.count, category: ai.category });

        const raw = await callModel(prompt);
        const parsed = parseRulesResponse(raw);

        // Models over-produce. Asking for three and showing five reads as a bug.
        ai.candidates = parsed.slice(0, ai.count).map(candidate => ({ ...candidate, checked: true }));
        ai.status = 'done';
        if (!ai.candidates.length) {
            ai.status = 'error';
            ai.error = 'The model produced no rules. Try a more concrete description.';
        }
    } catch (error) {
        ai.status = 'error';
        ai.error = friendlyError(error);
    }

    refresh();
}

function addCandidates(indexes) {
    const picked = indexes.map(index => ai.candidates[index]).filter(Boolean);
    if (!picked.length) {
        return;
    }
    for (const candidate of picked) {
        settings.rules.push(createRule({ ...candidate, source: 'ai', enabled: true }));
    }
    ai.candidates = [];
    ai.status = 'idle';
    saveSettings();
    toast('success', `${picked.length} rule${picked.length === 1 ? '' : 's'} added.`);
}

/* ------------------------------------------------------------------- export */

function downloadPack() {
    try {
        const blob = new Blob([JSON.stringify(exportPack(settings), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `rulebook-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('success', `Exported ${settings.rules.length} rules and ${settings.books.length} sets.`);
    } catch (error) {
        toast('error', `Could not export: ${friendlyError(error)}`);
    }
}

async function readPack(file) {
    try {
        const text = await file.text();
        const result = importPack(text, settings);
        saveSettings();
        toast('success', `Added ${result.added} rule${result.added === 1 ? '' : 's'}${result.skipped ? `, skipped ${result.skipped} already here` : ''}.`);
    } catch (error) {
        toast('error', `Import failed: ${friendlyError(error)}`);
    }
    refresh();
}

/* ------------------------------------------------------------------ dispatch */

async function dispatch(action, payload = {}) {
    try {
        await handle(action, payload);
    } catch (error) {
        console.error(LOG, `${action} failed`, error);
        toast('error', friendlyError(error));
    }
}

async function handle(action, payload) {
    const id = payload?.id;

    switch (action) {
        case 'close':
            closeModal();
            return;

        case 'open-modal':
        case 'hud-expand':
            if (action === 'hud-expand') {
                settings.hud.expanded = !settings.hud.expanded;
                saveSettings();
                refresh();
                return;
            }
            openModal();
            return;

        case 'toggle-global': {
            const rule = settings.rules.find(entry => entry.id === id);
            if (!rule) {
                return;
            }
            const current = typeof overrides[id] === 'boolean' ? overrides[id] : rule.enabled;
            setRuleEffective(id, !current);
            break;
        }

        case 'cycle-override':
            cycleOverride(id);
            break;

        case 'pin': {
            const rule = settings.rules.find(entry => entry.id === id);
            if (!rule) {
                return;
            }
            rule.pinned = !rule.pinned;
            saveSettings();
            break;
        }

        case 'duplicate': {
            const source = settings.rules.find(entry => entry.id === id);
            if (!source) {
                return;
            }
            const copy = createRule({ ...source, id: null, label: `${source.label} copy`, updatedAt: Date.now() });
            const index = settings.rules.indexOf(source);
            settings.rules.splice(index + 1, 0, copy);
            saveSettings();
            toast('success', 'Duplicated.');
            break;
        }

        case 'delete': {
            const rule = settings.rules.find(entry => entry.id === id);
            if (!rule) {
                return;
            }
            const answer = await callGenericPopup?.(`Delete "${rule.label}"?`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Keep' });
            if (answer === false || answer === POPUP_RESULT.NEGATIVE) {
                return;
            }
            removeRule(settings, id);
            overrides = setOverride(overrides, id, null);
            persistOverrides();
            saveSettings();
            refresh();
            return;
        }

        case 'rule-create': {
            const rule = createRule(payload.patch ?? {});
            settings.rules.push(rule);
            saveSettings();
            toast('success', `"${rule.label}" created.`);
            break;
        }

        case 'rule-save': {
            const rule = settings.rules.find(entry => entry.id === id);
            if (!rule) {
                return;
            }
            Object.assign(rule, payload.patch, { updatedAt: Date.now() });
            saveSettings();
            break;
        }

        case 'apply-book': {
            const result = applyBook(settings, id, payload.mode === 'add' ? 'add' : 'replace');
            saveSettings();
            toast('success', `Set applied — ${result.on} on, ${result.off} off.`);
            break;
        }

        case 'save-book': {
            const book = saveBook(settings, payload.name);
            saveSettings();
            toast('success', `Saved "${book.name}" with ${book.ruleIds.length} rules.`);
            break;
        }

        case 'delete-book': {
            const book = settings.books.find(entry => entry.id === id);
            if (!book) {
                return;
            }
            const answer = await callGenericPopup?.(`Delete the set "${book.name}"? The rules stay in the library.`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Keep' });
            if (answer === false || answer === POPUP_RESULT.NEGATIVE) {
                return;
            }
            settings.books = settings.books.filter(entry => entry.id !== id);
            saveSettings();
            break;
        }

        case 'all-on':
        case 'all-off': {
            const value = action === 'all-on';
            for (const rule of settings.rules) {
                rule.enabled = value;
                if (typeof overrides[rule.id] === 'boolean') {
                    overrides = setOverride(overrides, rule.id, value);
                }
            }
            persistOverrides();
            saveSettings();
            break;
        }

        case 'clear-overrides':
            overrides = {};
            persistOverrides();
            toast('info', 'This chat follows the global switches again.');
            break;

        case 'inject-patch': {
            const patch = payload ?? {};
            if (patch.template !== undefined) {
                settings.inject.template = String(patch.template).slice(0, 2000) || DEFAULT_TEMPLATE;
            }
            if (patch.position && ['in_prompt', 'in_chat', 'before_prompt'].includes(patch.position)) {
                settings.inject.position = patch.position;
            }
            if (patch.depth !== undefined) {
                settings.inject.depth = Math.max(0, Math.min(20, Number(patch.depth) || 0));
            }
            if (patch.role !== undefined) {
                settings.inject.role = [0, 1, 2].includes(Number(patch.role)) ? Number(patch.role) : 0;
            }
            saveSettings();
            break;
        }

        case 'inject-reset':
            settings.inject.template = DEFAULT_TEMPLATE;
            saveSettings();
            break;

        case 'copy-preview': {
            const text = lastView?.preview ?? '';
            if (!text) {
                toast('warning', 'Nothing is active — there is no block to copy.');
                return;
            }
            await navigator.clipboard?.writeText?.(text);
            toast('success', 'Injected block copied.');
            return;
        }

        case 'export':
            downloadPack();
            return;

        case 'import':
            if (payload.file) {
                await readPack(payload.file);
            }
            return;

        case 'ai-run':
            await runAi({ description: payload.description, kind: payload.kind, count: payload.count });
            return;

        case 'ai-checked': {
            const checked = new Set(payload.checked ?? []);
            ai.candidates.forEach((candidate, index) => {
                candidate.checked = checked.has(index);
            });
            return;
        }

        case 'ai-add':
            addCandidates(payload.indexes ?? []);
            break;

        case 'ai-clear':
            ai.baseRuleId = null;
            ai.candidates = [];
            ai.status = 'idle';
            ai.error = '';
            break;

        case 'ai-category':
            ai.category = payload.category || 'auto';
            return;

        case 'ai-direction':
            ai.direction = payload.direction || 'softer';
            return;

        case 'ai-remix': {
            const rule = settings.rules.find(entry => entry.id === id);
            if (!rule) {
                return;
            }
            ai.baseRuleId = rule.id;
            ai.status = 'idle';
            ai.candidates = [];
            ai.error = '';
            ai.description = '';
            return;
        }

        case 'master-toggle':
            settings.inject.enabled = Boolean(payload.value);
            break;

        case 'hud-toggle':
            settings.hud.enabled = Boolean(payload.value);
            break;

        default:
            return;
    }

    saveSettings();
    refresh();
}

/* ------------------------------------------------------------ settings panel */

function mountSettingsPanel() {
    const host = document.querySelector('#extensions_settings');
    if (!host) {
        return;
    }

    renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings')
        .then(html => {
            host.insertAdjacentHTML('beforeend', html);
            wireSettingsPanel();
        })
        .catch(error => console.error(LOG, 'could not render the settings panel', error));
}

function wireSettingsPanel() {
    const master = document.getElementById('rb-master');
    const hudToggle = document.getElementById('rb-hud-toggle');
    const open = document.getElementById('rb-open');

    // ST toggles drawers through a delegated handler on '.inline-drawer-toggle'
    // that reads `closest('.inline-drawer')` — settings.html carries that wrapper.
    // If a future ST build changes the contract, drive the content ourselves
    // rather than leaving a header that does nothing.
    const panel = document.getElementById('rb-settings');
    const header = panel?.querySelector('.inline-drawer-header');
    const drawerContent = panel?.querySelector('.inline-drawer-content');
    if (header && drawerContent && !panel.querySelector('.inline-drawer')) {
        header.addEventListener('click', () => {
            const openState = drawerContent.style.display !== 'block';
            drawerContent.style.display = openState ? 'block' : 'none';
            header.querySelector('.inline-drawer-icon')?.classList.toggle('down', !openState);
        });
    }

    if (master) {
        master.checked = settings.inject.enabled;
        master.addEventListener('change', () => {
            settings.inject.enabled = master.checked;
            saveSettings();
            refresh();
        });
    }

    if (hudToggle) {
        hudToggle.checked = settings.hud.enabled;
        hudToggle.addEventListener('change', () => {
            settings.hud.enabled = hudToggle.checked;
            saveSettings();
            refresh();
        });
    }

    open?.addEventListener('click', () => openModal());

    if (lastView) {
        updateReadout(lastView);
    } else {
        const view = buildView();
        updateReadout(view);
    }
}

/* ---------------------------------------------------------------- wand menu */

function addWandEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('rb-wand')) {
        return true;
    }
    const entry = document.createElement('div');
    entry.id = 'rb-wand';
    entry.innerHTML = `<div class="extensionsMenuExtensionButton fa-solid ${MENU_ICON}"></div><span>Rulebook</span>`;
    entry.addEventListener('click', () => openModal());
    menu.append(entry);
    return true;
}

function waitForWandMenu(attempt = 0) {
    if (addWandEntry() || attempt > 40) {
        return;
    }
    setTimeout(() => waitForWandMenu(attempt + 1), 250);
}

/* -------------------------------------------------------------------- events */

function onEvent(name, handler) {
    const context = getContext();
    const source = context.eventSource ?? window.eventSource;
    const types = context.eventTypes ?? window.event_types ?? {};
    const type = types[name];
    if (!source?.on || type === undefined) {
        return;
    }
    source.on(type, (...args) => {
        try {
            handler(...args);
        } catch (error) {
            console.error(LOG, `handler for ${name} failed`, error);
        }
    });
}

function registerEvents() {
    onEvent('CHAT_CHANGED', () => {
        loadOverrides();
        refresh();
    });

    onEvent('CHARACTER_SELECTED', () => refresh());

    window.addEventListener('resize', () => {
        if (lastView) {
            mountHud(lastView);
        }
    });
}

/* -------------------------------------------------------------- slash command */

function renderRulesText() {
    const view = buildView();
    if (!view.totalCount) {
        return 'No rules yet — open the rulebook from the wand menu.';
    }
    const on = view.rules.filter(rule => rule.effective);
    const lines = on.length
        ? on.map(rule => `• ${rule.label} (${rule.category}, ${rule.strength})`).join('\n')
        : '(nothing active)';
    return [
        `${on.length} of ${view.totalCount} rules on · ${view.tokens} tokens`,
        lines,
        view.conflicts.length ? `\nConflicts: ${view.conflicts.map(entry => entry.group).join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

function registerSlashCommands() {
    if (!SlashCommandParser?.addCommandObject) {
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rules',
        callback: () => renderRulesText(),
        returns: 'the active rules and their token cost',
        helpString: '<div>List the rules that are switched on, and what they cost.</div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rule',
        callback: async (_named, unnamed) => {
            const raw = String(unnamed ?? '').trim();
            if (!raw) {
                return renderRulesText();
            }
            const match = raw.match(/^(.*?)\s+(on|off|toggle|chat-on|chat-off|chat-clear)$/i);
            const label = (match ? match[1] : raw).trim();
            const verb = match ? match[2].toLowerCase() : 'toggle';
            const rule = findRule(label);

            if (!rule) {
                return `No rule matches "${label}".`;
            }

            if (verb === 'chat-clear') {
                overrides = setOverride(overrides, rule.id, null);
                persistOverrides();
            } else if (verb === 'chat-on' || verb === 'chat-off') {
                overrides = setOverride(overrides, rule.id, verb === 'chat-on');
                persistOverrides();
            } else {
                const current = typeof overrides[rule.id] === 'boolean' ? overrides[rule.id] : rule.enabled;
                setRuleEffective(rule.id, verb === 'on' ? true : verb === 'off' ? false : !current);
            }

            refresh();
            const effective = withEffective([rule], overrides)[0];
            return `"${rule.label}" is ${effective.effective ? 'on' : 'off'}${effective.overridden ? ' (forced in this chat)' : ''}.`;
        },
        returns: 'the state of the rule after the change',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'rule label (or part of it), then on / off / toggle / chat-on / chat-off / chat-clear',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
            <div>Switch a rule by name.</div>
            <div><code>/rule instant</code> — toggle it</div>
            <div><code>/rule instant off</code> — turn it off globally</div>
            <div><code>/rule instant chat-on</code> — force it on for this chat only</div>
            <div><code>/rule instant chat-clear</code> — follow the global switch again</div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rulebook',
        callback: async (_named, unnamed) => {
            const raw = String(unnamed ?? '').trim();
            const [first, ...rest] = raw.split(/\s+/);
            const remainder = rest.join(' ').trim();
            const verb = (first ?? '').toLowerCase();

            if (!raw || verb === 'list') {
                if (!settings.books.length) {
                    return 'No sets yet. Switch on some rules, then /rulebook save <name>.';
                }
                return settings.books.map(book => `• ${book.name} (${book.ruleIds.length} rules)`).join('\n');
            }

            if (verb === 'save') {
                if (!remainder) {
                    return 'Name the set: /rulebook save <name>';
                }
                const book = saveBook(settings, remainder);
                saveSettings();
                refresh();
                return `Saved "${book.name}" with ${book.ruleIds.length} rules.`;
            }

            const additive = verb === 'add';
            const name = additive ? remainder : raw;
            const book = settings.books.find(entry => entry.name.toLowerCase() === name.toLowerCase());

            if (!book) {
                return `No set named "${name}".`;
            }

            const result = applyBook(settings, book.id, additive ? 'add' : 'replace');
            saveSettings();
            refresh();
            return `"${book.name}" applied — ${result.on} on, ${result.off} off.`;
        },
        returns: 'the set that was applied, or the list of sets',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'set name, or "add <name>", "save <name>", "list"',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
            <div>Switch rule sets.</div>
            <div><code>/rulebook list</code> — show the sets</div>
            <div><code>/rulebook Slow romance</code> — apply it (everything else off)</div>
            <div><code>/rulebook add Slow romance</code> — stack it on top</div>
            <div><code>/rulebook save Slow romance</code> — save the current selection as that set</div>
        `,
    }));
}

/* ---------------------------------------------------------------------- boot */

async function bootstrap() {
    if (booted) {
        return;
    }
    booted = true;

    if (!settings.rules.length && !settings.seeded) {
        settings.rules = starterRules();
        settings.seeded = true;
        saveSettings();
    }

    loadOverrides();
    mountSettingsPanel();
    registerEvents();
    waitForWandMenu();
    registerSlashCommands();
    refresh();
}

jQuery(() => {
    bootstrap().catch(error => console.error(LOG, 'failed to start', error));
});

export { settings };
