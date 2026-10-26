/**
 * Rulebook — the data model.
 *
 * No SillyTavern imports in this file: the harness loads it as a plain module, so
 * the same normalisation, composition and conflict logic runs outside ST.
 */

export const EXTENSION_KEY = 'st-rulebook';
export const INJECT_KEY = 'st-rulebook-rules';
export const META_KEY = 'st-rulebook';
export const EXTENSION_FOLDER = 'third-party/st-rulebook';

export const CATEGORIES = [
    { id: 'romance', label: 'Romance', icon: 'fa-heart' },
    { id: 'drama', label: 'Drama', icon: 'fa-masks-theater' },
    { id: 'conflict', label: 'Conflict', icon: 'fa-khanda' },
    { id: 'world', label: 'World', icon: 'fa-globe' },
    { id: 'style', label: 'Style', icon: 'fa-feather-pointed' },
    { id: 'meta', label: 'Meta', icon: 'fa-gears' },
];

export const CATEGORY_IDS = CATEGORIES.map(entry => entry.id);
const CATEGORY_SET = new Set(CATEGORY_IDS);
const CATEGORY_INDEX = new Map(CATEGORIES.map((entry, index) => [entry.id, index]));

export const STRENGTHS = [
    { id: 'hard', label: 'Always', hint: 'Non-negotiable. The model must obey it.' },
    { id: 'soft', label: 'Prefer', hint: 'A tendency. The model leans this way but may break it for the scene.' },
];

export const DEFAULT_TEMPLATE = [
    'RULES FOR THIS SCENE',
    'Follow every rule below. Where a rule contradicts the character card or the persona, the rule wins.',
    '',
    '{{rules}}',
].join('\n');

export const DEFAULT_INJECT = {
    enabled: true,
    position: 'in_prompt',
    depth: 1,
    role: 0,
    template: DEFAULT_TEMPLATE,
};

/* ------------------------------------------------------------------ identity */

export function uid(prefix = 'r') {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function text(value, max, fallback = '') {
    const trimmed = String(value ?? '').replace(/\r/g, '').trim();
    return (trimmed || fallback).slice(0, max);
}

export function deriveLabel(body) {
    const words = String(body ?? '')
        .replace(/[*_`>#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, 7)
        .join(' ');
    return words.replace(/[.,;:!?]+$/, '');
}

/* --------------------------------------------------------------------- rules */

export function normalizeRule(raw, index = 0) {
    const body = text(raw?.text, 4000);
    const label = text(raw?.label, 80) || deriveLabel(body) || `Rule ${index + 1}`;
    const category = CATEGORY_SET.has(raw?.category) ? raw.category : 'style';
    const strength = raw?.strength === 'soft' ? 'soft' : 'hard';
    const tags = Array.isArray(raw?.tags)
        ? [...new Set(raw.tags.map(tag => text(tag, 24).toLowerCase()).filter(Boolean))].slice(0, 8)
        : [];

    return {
        id: text(raw?.id, 40) || uid('r'),
        label,
        text: body,
        category,
        strength,
        group: text(raw?.group, 40).toLowerCase(),
        stance: text(raw?.stance, 40).toLowerCase(),
        tags,
        pinned: Boolean(raw?.pinned),
        enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
        source: raw?.source === 'ai' ? 'ai' : 'hand',
        updatedAt: Number(raw?.updatedAt) || Date.now(),
    };
}

export function createRule(partial = {}) {
    return normalizeRule({ ...partial, id: partial.id || uid('r') }, 0);
}

export function normalizeBook(raw, ruleIds) {
    const ids = Array.isArray(raw?.ruleIds) ? raw.ruleIds.map(id => text(id, 40)) : [];
    return {
        id: text(raw?.id, 40) || uid('b'),
        name: text(raw?.name, 60) || 'Untitled set',
        note: text(raw?.note, 200),
        ruleIds: ids.filter(id => !ruleIds || ruleIds.has(id)),
        updatedAt: Number(raw?.updatedAt) || Date.now(),
    };
}

/* ------------------------------------------------------------------ settings */

export function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const rules = [];
    const seen = new Set();

    for (const [index, entry] of (Array.isArray(source.rules) ? source.rules : []).entries()) {
        const rule = normalizeRule(entry, index);
        // A duplicated id would make every switch write to the wrong row.
        if (seen.has(rule.id)) {
            rule.id = uid('r');
        }
        seen.add(rule.id);
        if (rule.text) {
            rules.push(rule);
        }
    }

    const ids = new Set(rules.map(rule => rule.id));
    const books = (Array.isArray(source.books) ? source.books : [])
        .map(entry => normalizeBook(entry, ids))
        .filter(book => book.name);

    const inject = source.inject && typeof source.inject === 'object' ? source.inject : {};
    const hud = source.hud && typeof source.hud === 'object' ? source.hud : {};

    return {
        version: 1,
        rules,
        books,
        inject: {
            enabled: inject.enabled === undefined ? true : Boolean(inject.enabled),
            position: ['in_prompt', 'in_chat', 'before_prompt'].includes(inject.position) ? inject.position : 'in_prompt',
            depth: Math.max(0, Math.min(20, Number(inject.depth) || 0)),
            role: [0, 1, 2].includes(Number(inject.role)) ? Number(inject.role) : 0,
            template: text(inject.template, 2000) || DEFAULT_TEMPLATE,
        },
        hud: {
            enabled: hud.enabled === undefined ? true : Boolean(hud.enabled),
            expanded: Boolean(hud.expanded),
        },
    };
}

/* ----------------------------------------------------------------- overrides */

export function normalizeOverrides(raw, rules) {
    const valid = new Set(rules.map(rule => rule.id));
    const out = {};
    if (!raw || typeof raw !== 'object') {
        return out;
    }
    for (const [id, value] of Object.entries(raw)) {
        if (valid.has(id) && typeof value === 'boolean') {
            out[id] = value;
        }
    }
    return out;
}

export function setOverride(overrides, id, value) {
    const next = { ...(overrides ?? {}) };
    if (value === null || value === undefined) {
        delete next[id];
    } else {
        next[id] = Boolean(value);
    }
    return next;
}

export function overrideCount(overrides) {
    return Object.keys(overrides ?? {}).length;
}

export function isEffective(rule, overrides) {
    const override = overrides?.[rule.id];
    return typeof override === 'boolean' ? override : rule.enabled;
}

export function withEffective(rules, overrides) {
    return rules.map(rule => ({
        ...rule,
        effective: isEffective(rule, overrides),
        overridden: typeof overrides?.[rule.id] === 'boolean',
    }));
}

export function activeRules(rules, overrides) {
    return withEffective(rules, overrides).filter(rule => rule.effective);
}

/* ---------------------------------------------------------------- conflict */

/**
 * Two enabled rules in the same contested group with different stances contradict
 * each other. Rules with no group, or with no stance, are never flagged: silence
 * beats a false positive that trains people to ignore the warning.
 */
export function findConflicts(rules) {
    const groups = new Map();

    for (const rule of rules) {
        if (!rule.effective || !rule.group || !rule.stance) {
            continue;
        }
        if (!groups.has(rule.group)) {
            groups.set(rule.group, []);
        }
        groups.get(rule.group).push(rule);
    }

    const conflicts = [];
    for (const [group, members] of groups) {
        const stances = new Set(members.map(rule => rule.stance));
        if (stances.size > 1) {
            conflicts.push({ group, stances: [...stances], rules: members });
        }
    }
    return conflicts;
}

/* ------------------------------------------------------------------ compose */

export function tokenEstimate(body) {
    const value = String(body ?? '');
    if (!value) {
        return 0;
    }
    // 4 characters per token is close enough for English; a CJK character is
    // roughly one token on its own, so it has to weigh more than a letter.
    let weight = 0;
    for (const character of value) {
        weight += character.charCodeAt(0) > 0x2e80 ? 4 : 1;
    }
    return Math.max(1, Math.ceil(weight / 4));
}

export function substituteMacros(body, { charName = 'the character', userName = 'the user' } = {}) {
    return String(body ?? '')
        .replace(/\{\{char\}\}/gi, charName || 'the character')
        .replace(/\{\{user\}\}/gi, userName || 'the user');
}

function ruleLine(rule, names) {
    const marker = rule.strength === 'hard' ? 'Always' : 'Prefer';
    return `- ${marker}: ${substituteMacros(rule.text, names)}`;
}

/**
 * Renders the injected block. Returns '' when nothing is active, which the caller
 * must treat as "clear the prompt key" rather than "leave the last block in place".
 */
export function composeRules(rules, { template = DEFAULT_TEMPLATE, charName = '', userName = '' } = {}) {
    const active = rules.filter(rule => rule.effective && rule.text);
    if (!active.length) {
        return '';
    }

    const names = { charName, userName };
    const buckets = new Map();

    for (const rule of active) {
        const key = CATEGORY_SET.has(rule.category) ? rule.category : 'style';
        if (!buckets.has(key)) {
            buckets.set(key, []);
        }
        buckets.get(key).push(rule);
    }

    const sections = [...buckets.entries()]
        .sort((a, b) => (CATEGORY_INDEX.get(a[0]) ?? 99) - (CATEGORY_INDEX.get(b[0]) ?? 99))
        .map(([category, members]) => {
            const label = CATEGORIES.find(entry => entry.id === category)?.label ?? 'Other';
            const lines = members
                .slice()
                .sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'hard' ? -1 : 1))
                .map(rule => ruleLine(rule, names));
            return `${label.toUpperCase()}\n${lines.join('\n')}`;
        });

    const pattern = String(template ?? DEFAULT_TEMPLATE);
    const body = sections.join('\n\n');
    return (pattern.includes('{{rules}}') ? pattern : `${pattern}\n\n{{rules}}`)
        .replace(/\{\{rules\}\}/g, body)
        .replace(/\{\{char\}\}/gi, names.charName || 'the character')
        .replace(/\{\{user\}\}/gi, names.userName || 'the user')
        .trim();
}

/* ------------------------------------------------------------------- search */

export function filterRules(rules, { query = '', category = 'all', onlyOn = false } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    return rules.filter(rule => {
        if (onlyOn && !rule.effective) {
            return false;
        }
        if (category && category !== 'all' && rule.category !== category) {
            return false;
        }
        if (!needle) {
            return true;
        }
        return [rule.label, rule.text, rule.group, rule.stance, ...(rule.tags ?? [])]
            .join(' ')
            .toLowerCase()
            .includes(needle);
    });
}

/* --------------------------------------------------------------------- sets */

export function applyBook(settings, bookId, mode = 'replace') {
    const book = settings.books.find(entry => entry.id === bookId);
    if (!book) {
        return { on: 0, off: 0 };
    }
    const members = new Set(book.ruleIds);
    let on = 0;
    let off = 0;

    for (const rule of settings.rules) {
        const shouldBeOn = members.has(rule.id) ? true : mode === 'replace' ? false : rule.enabled;
        if (shouldBeOn !== rule.enabled) {
            rule.enabled = shouldBeOn;
            rule.updatedAt = Date.now();
            if (shouldBeOn) {
                on += 1;
            } else {
                off += 1;
            }
        }
    }
    return { on, off };
}

export function saveBook(settings, name, note = '') {
    const enabled = settings.rules.filter(rule => rule.enabled).map(rule => rule.id);
    const existing = settings.books.find(book => book.name.toLowerCase() === String(name).toLowerCase());
    if (existing) {
        existing.ruleIds = enabled;
        existing.note = text(note, 200) || existing.note;
        existing.updatedAt = Date.now();
        return existing;
    }
    const book = normalizeBook({ id: uid('b'), name: text(name, 60), note, ruleIds: enabled }, new Set(settings.rules.map(rule => rule.id)));
    settings.books.push(book);
    return book;
}

export function moveRule(settings, id, delta) {
    const index = settings.rules.findIndex(rule => rule.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= settings.rules.length) {
        return false;
    }
    const [rule] = settings.rules.splice(index, 1);
    settings.rules.splice(target, 0, rule);
    return true;
}

export function removeRule(settings, id) {
    const before = settings.rules.length;
    settings.rules = settings.rules.filter(rule => rule.id !== id);
    for (const book of settings.books) {
        book.ruleIds = book.ruleIds.filter(ruleId => ruleId !== id);
    }
    return settings.rules.length < before;
}

/* ------------------------------------------------------------ import/export */

export function exportPack(settings) {
    return {
        format: 'st-rulebook',
        version: 1,
        exportedAt: new Date().toISOString(),
        rules: settings.rules.map(rule => ({
            // The id travels with the pack: book memberships are written in terms
            // of it, and without it every set arrives empty on the other side.
            id: rule.id,
            label: rule.label,
            text: rule.text,
            category: rule.category,
            strength: rule.strength,
            group: rule.group,
            stance: rule.stance,
            tags: rule.tags,
            pinned: rule.pinned,
            enabled: rule.enabled,
            source: rule.source,
        })),
        books: settings.books.map(book => ({ name: book.name, note: book.note, ruleIds: book.ruleIds })),
    };
}

/**
 * Merges a pack into the library. Rules that already exist (same normalised text)
 * are skipped rather than duplicated; book memberships are remapped onto whichever
 * id the rule ended up with, including the ids of skipped rules.
 */
export function importPack(raw, settings) {
    const pack = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!pack || typeof pack !== 'object') {
        throw new Error('That file is not a Rulebook pack.');
    }
    if (pack.format && pack.format !== 'st-rulebook') {
        throw new Error('That file belongs to another extension.');
    }

    const incoming = Array.isArray(pack.rules) ? pack.rules : [];
    if (!incoming.length) {
        throw new Error('The pack contains no rules.');
    }

    const byText = new Map(settings.rules.map(rule => [rule.text.toLowerCase(), rule.id]));
    const idMap = new Map();
    let added = 0;
    let skipped = 0;

    for (const entry of incoming) {
        const rule = normalizeRule(entry, settings.rules.length);
        if (!rule.text) {
            continue;
        }
        const key = rule.text.toLowerCase();
        if (byText.has(key)) {
            idMap.set(rule.id, byText.get(key));
            skipped += 1;
            continue;
        }
        if (settings.rules.some(existing => existing.id === rule.id)) {
            rule.id = uid('r');
        }
        settings.rules.push(rule);
        byText.set(key, rule.id);
        idMap.set(rule.id, rule.id);
        added += 1;
    }

    let books = 0;
    for (const entry of Array.isArray(pack.books) ? pack.books : []) {
        const name = text(entry?.name, 60);
        if (!name) {
            continue;
        }
        const ids = (Array.isArray(entry.ruleIds) ? entry.ruleIds : [])
            .map(id => idMap.get(id))
            .filter(Boolean);
        const existing = settings.books.find(book => book.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            existing.ruleIds = [...new Set([...existing.ruleIds, ...ids])];
            existing.updatedAt = Date.now();
        } else {
            settings.books.push(normalizeBook({ id: uid('b'), name, note: entry.note, ruleIds: ids }));
        }
        books += 1;
    }

    return { added, skipped, books };
}

/* --------------------------------------------------------------- starter set */

export function starterRules() {
    return [
        createRule({
            label: 'Instant attraction',
            text: '{{char}} is visibly, hopelessly drawn to {{user}} from the first exchange and stops pretending otherwise.',
            category: 'romance',
            strength: 'hard',
            group: 'romance pace',
            stance: 'instant',
            tags: ['romance', 'fast'],
            source: 'hand',
        }),
        createRule({
            label: 'No purple prose',
            text: 'Keep the prose plain. No similes stacked three deep, no "a symphony of" anything, no describing every object in the room.',
            category: 'style',
            strength: 'hard',
            tags: ['prose'],
            source: 'hand',
        }),
        createRule({
            label: 'End on a hook',
            text: 'End every reply with something that demands an answer: a question, a movement, a decision left hanging.',
            category: 'style',
            strength: 'soft',
            tags: ['pacing'],
            source: 'hand',
        }),
    ].map(rule => ({ ...rule, enabled: false }));
}
