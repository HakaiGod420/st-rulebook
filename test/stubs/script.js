// Stub of SillyTavern's script.js exports used by the extension.

import { extension_settings } from './scripts/extensions.js';

export function saveSettingsDebounced() {
    window.__saved = JSON.parse(JSON.stringify(extension_settings));
}

export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const max_context = 12800;

export function setExtensionPrompt(key, value, position, depth, scan = false, role = 0) {
    const injection = { key, value, position, depth, scan, role };
    window.__injection = injection;
    window.__injections = window.__injections ?? [];
    window.__injections.push(injection);
}

const CHAR_NAME = 'Kisa';
const USER_NAME = 'Kai';

/** What SillyTavern's createRawPrompt() does to a raw prompt (script.js:3945). */
export function substituteParamsLikeST(text) {
    return String(text ?? '')
        .replace(/\{\{char\}\}/gi, CHAR_NAME)
        .replace(/\{\{user\}\}/gi, USER_NAME);
}

/** A model that ignores the token instruction: it writes the names it was given. */
function modelish(text) {
    return String(text ?? '')
        .replace(/\[\[\s*char\s*\]\]/gi, CHAR_NAME)
        .replace(/\[\[\s*user\s*\]\]/gi, USER_NAME);
}

const AUTHORED = [
    {
        label: 'Instinct before thought',
        text: '{{char}} reacts to {{user}} before she has decided to, and notices herself doing it.',
        category: 'romance',
        strength: 'hard',
        group: 'romance pace',
        stance: 'instant',
        tags: ['romance', 'fast'],
    },
    {
        label: 'No purple prose',
        text: 'Describe what happened and who moved. No stacked similes, no "a symphony of" anything.',
        category: 'style',
        strength: 'hard',
        group: 'prose density',
        stance: 'plain',
        tags: ['prose'],
    },
    {
        label: 'End on a hook',
        text: 'Close every reply with something that demands an answer: a question, a movement, a held breath.',
        category: 'style',
        strength: 'soft',
        group: '',
        stance: '',
        tags: ['pacing'],
    },
];

function authoredFor(prompt) {
    if (/split a messy prompt/i.test(prompt)) {
        return [
            ...AUTHORED,
            {
                label: 'Never speak for the user',
                text: 'Never write {{user}}\'s dialogue, thoughts or decisions.',
                category: 'meta',
                strength: 'hard',
                group: 'agency',
                stance: 'user-only',
                tags: ['agency'],
            },
        ];
    }
    if (/rewrite one roleplay rule/i.test(prompt)) {
        return AUTHORED.slice(0, 3).map((rule, index) => ({
            ...rule,
            label: `${rule.label} (variant ${index + 1})`,
            text: `${rule.text} Sharper still.`,
        }));
    }
    const wanted = Number((prompt.match(/into (\d+) separate rules/i) ?? [])[1] ?? 3);
    return AUTHORED.slice(0, Math.max(1, Math.min(3, wanted)));
}

export async function generateRaw({ prompt = '', systemPrompt = '', responseLength = null } = {}) {
    window.__lastRawPrompt = prompt;
    // ST resolves macros before the model sees anything — the harness has to do
    // the same or it cannot reproduce the "rules came back with real names" bug.
    window.__promptAsModelSeesIt = substituteParamsLikeST(prompt);
    window.__calls = (window.__calls ?? 0) + 1;
    await new Promise(resolve => setTimeout(resolve, 500));

    if (window.__abortNext) {
        window.__abortNext = false;
        throw new Error('Generation stopped by user');
    }
    if (window.__failNext) {
        window.__failNext = false;
        // Prose instead of JSON: exercises the parser's failure path.
        return 'Sure! Here are some lovely rules about love and trains.';
    }

    const rules = authoredFor(window.__promptAsModelSeesIt).map(rule => ({
        ...rule,
        text: modelish(rule.text),
    }));

    if (window.__cleanReply) {
        // Fenced JSON: the parser has to survive the fence a model adds by itself.
        return ['```json', '<<<RULES>>>', JSON.stringify(rules), '<<<END>>>', '```'].join('\n');
    }

    // The shape that broke it in the wild: names instead of tokens, no closing
    // sentinel, a stray tool tag after the array.
    return `<<<RULES>>>\n${JSON.stringify(rules)}\n</parameter>`;
}

export async function generateQuietPrompt({ quietPrompt = '' } = {}) {
    return generateRaw({ prompt: quietPrompt });
}
