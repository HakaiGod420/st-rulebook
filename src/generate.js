/**
 * Rulebook — AI authoring prompts and tolerant parsing.
 *
 * Sentinel-delimited JSON rather than a schema: small models and local backends
 * break on forced JSON, and a sentinel is just text. Fallback: bullets, so a model
 * that ignores the format still yields rules instead of an error.
 *
 * Calls go through `generateRaw` in index.js — these prompts are self-contained and
 * must not leak the open card into a rule the user will reuse elsewhere.
 */

import { CATEGORY_IDS, deriveLabel } from './rules.js';

export const SENTINEL_OPEN = '<<<RULES>>>';
export const SENTINEL_CLOSE = '<<<END>>>';

export class RulebookParseError extends Error {
    constructor(message, raw = '') {
        super(message);
        this.name = 'RulebookParseError';
        this.raw = raw;
    }
}

export const DIRECTIONS = [
    { id: 'softer', label: 'Softer' },
    { id: 'harder', label: 'Harder' },
    { id: 'sharper', label: 'Sharper' },
];

const OUTPUT_RULES = [
    'OUTPUT',
    `- Reply with exactly one JSON array between ${SENTINEL_OPEN} and ${SENTINEL_CLOSE}, and nothing else.`,
    '- Each item: {"label","text","category","strength","group","stance","tags"}.',
    `- "category" is one of: ${CATEGORY_IDS.join(', ')}.`,
    '- "strength" is "hard" for absolute rules (always / never) and "soft" for tendencies (prefer / tends to).',
    '- "group" names the contested topic the rule controls, in two or three words ("romance pace", "violence level", "reply length"). Two rules with the same group and a different "stance" contradict each other, so always give both or neither.',
    '- "tags" is an array of one or two lowercase words.',
    '- Write rule text in third person about the character, or in imperative about the reply. Never address the reader.',
    '- Use the literal tokens {{char}} and {{user}} instead of names, so the rule works on any card.',
    '- No markdown, no commentary, no numbering inside the JSON.',
];

function clampCount(value, fallback = 3) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(1, Math.min(8, number)) : fallback;
}

const EXAMPLE = [
    SENTINEL_OPEN,
    '[{"label":"Instant attraction","text":"{{char}} is hopelessly drawn to {{user}} from the first exchange and stops hiding it.","category":"romance","strength":"hard","group":"romance pace","stance":"instant","tags":["romance"]}]',
    SENTINEL_CLOSE,
];

export function buildAuthorPrompt({ description = '', count = 3, category = 'auto' } = {}) {
    const categoryLine = category && category !== 'auto'
        ? `Every rule must use the category "${category}".`
        : 'Choose the category that fits each rule.';

    return [
        'You write behaviour rules for a roleplay system prompt.',
        `Turn the description below into ${clampCount(count)} separate rules.`,
        '',
        'DESCRIPTION',
        String(description ?? '').trim() || '(empty)',
        '',
        'RULES OF THE JOB',
        '- One behaviour per rule. Never put two instructions in one rule.',
        '- A rule must be checkable: someone reading a reply can tell whether it was followed.',
        '- Do not restate the character card, invent backstory, or write events. Only how the model behaves.',
        '- Keep each rule under 200 characters.',
        `- ${categoryLine}`,
        '',
        ...OUTPUT_RULES,
        '',
        'EXAMPLE',
        ...EXAMPLE,
    ].join('\n');
}

export function buildAtomizePrompt({ blob = '', count = 8 } = {}) {
    return [
        'You split a messy prompt dump into atomic roleplay rules.',
        '',
        'TEXT',
        String(blob ?? '').slice(0, 12000).trim() || '(empty)',
        '',
        'TASK',
        `Extract every instruction in the text that tells the model how to behave, and split each one into its own rule. Produce at most ${clampCount(count, 8)} rules — keep the most specific ones.`,
        '',
        'RULES OF THE JOB',
        '- Drop anything that is not an instruction: greetings, examples, headings, author notes, repetitions of the same point.',
        '- Preserve the original intent and wording wherever the text is already clear.',
        '- If the text contains contradictory instructions, keep both as separate rules — do not resolve them.',
        '- Do not invent rules the text does not contain. Fewer is better than padded.',
        '',
        ...OUTPUT_RULES,
        '',
        'EXAMPLE',
        ...EXAMPLE,
    ].join('\n');
}

export function buildRemixPrompt({ rule, direction = 'softer', count = 3 } = {}) {
    const original = String(rule?.text ?? '').trim();
    const angle = {
        softer: 'kinder and more permissive: same behaviour, lower intensity, more room for the model to bend it',
        harder: 'stricter and more absolute: no escape hatch, no exceptions, no "sometimes"',
        sharper: 'more concrete and more specific: replace vague verbs with observable behaviour',
    }[direction] ?? 'clearer';

    return [
        'You rewrite one roleplay rule into variants.',
        '',
        'ORIGINAL RULE',
        original || '(empty)',
        rule?.label ? `LABEL: ${rule.label}` : '',
        '',
        'TASK',
        `Write ${clampCount(count)} variants that are ${angle}.`,
        'Keep the behaviour the rule controls. Do not add new behaviours, do not change the category.',
        '',
        ...OUTPUT_RULES,
        '',
        'EXAMPLE',
        ...EXAMPLE,
    ].filter(line => line !== '').join('\n');
}

/* ------------------------------------------------------------------- parsing */

function tryJson(body) {
    const normalised = body
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1');

    const attempts = [body, normalised, normalised.replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":')];

    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (Array.isArray(parsed)) {
                return parsed;
            }
            if (parsed && typeof parsed === 'object') {
                for (const key of ['rules', 'items', 'result', 'results']) {
                    if (Array.isArray(parsed[key])) {
                        return parsed[key];
                    }
                }
                // A single rule object is still a valid answer.
                if (typeof parsed.text === 'string') {
                    return [parsed];
                }
            }
        } catch {
            // next attempt
        }
    }
    return null;
}

function fromBullets(block) {
    const lines = block
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^([-*•]|\d+[.)])\s+\S/.test(line));

    if (!lines.length) {
        return null;
    }

    return lines.map(line => ({
        text: line.replace(/^([-*•]|\d+[.)])\s+/, '').trim(),
        label: '',
        category: 'style',
        strength: 'hard',
    }));
}

function coerce(entry, index) {
    if (typeof entry === 'string') {
        return { text: entry };
    }
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    return {
        text: String(entry.text ?? entry.rule ?? entry.instruction ?? '').trim(),
        label: String(entry.label ?? entry.name ?? entry.title ?? '').trim(),
        category: String(entry.category ?? '').trim().toLowerCase(),
        strength: String(entry.strength ?? '').trim().toLowerCase() === 'soft' ? 'soft' : 'hard',
        group: String(entry.group ?? entry.topic ?? '').trim(),
        stance: String(entry.stance ?? entry.position ?? '').trim(),
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        source: 'ai',
        enabled: false,
        _index: index,
    };
}

/**
 * Returns candidate rules for the preview list — never `normalizeRule`, so an id is
 * only minted when the user actually keeps one.
 */
export function parseRulesResponse(raw) {
    const body = String(raw ?? '');
    const openIndex = body.indexOf(SENTINEL_OPEN);
    let block;

    if (openIndex !== -1) {
        const closeIndex = body.indexOf(SENTINEL_CLOSE, openIndex + SENTINEL_OPEN.length);
        block = body.slice(openIndex + SENTINEL_OPEN.length, closeIndex === -1 ? undefined : closeIndex);
    } else {
        const start = body.indexOf('[');
        const end = body.lastIndexOf(']');
        block = start !== -1 && end > start ? body.slice(start, end + 1) : body;
    }

    block = block.replace(/```(?:json)?/gi, '').trim();
    if (!block) {
        throw new RulebookParseError('The model replied with nothing to read.', body);
    }

    const json = tryJson(block);
    const entries = json ?? fromBullets(block);
    if (!entries) {
        throw new RulebookParseError('The reply was not a rule list — nothing was added.', body);
    }

    const candidates = entries
        .map(coerce)
        .filter(entry => entry && entry.text && entry.text.length >= 4);

    if (!candidates.length) {
        throw new RulebookParseError('The reply contained no usable rules — nothing was added.', body);
    }

    return candidates.map((entry, index) => ({
        ...entry,
        label: entry.label || deriveLabel(entry.text) || `Rule ${index + 1}`,
        tags: Array.isArray(entry.tags) ? entry.tags.map(tag => String(tag)) : [],
    }));
}
