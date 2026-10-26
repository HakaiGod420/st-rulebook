/**
 * Unit tests for the pure modules — no browser, no SillyTavern.
 *
 *   node test/rules.test.mjs
 */

import assert from 'node:assert/strict';
import {
    DEFAULT_TEMPLATE,
    applyBook,
    composeRules,
    createRule,
    exportPack,
    findConflicts,
    importPack,
    normalizeSettings,
    removeRule,
    saveBook,
    setOverride,
    tokenEstimate,
    withEffective,
} from '../src/rules.js';
import { RulebookParseError, parseRulesResponse, buildAuthorPrompt, buildAtomizePrompt } from '../src/generate.js';

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed += 1;
    } catch (error) {
        failures.push({ name, error });
    }
}

/* --------------------------------------------------------------------- rules */

test('normalizeSettings drops rules with no text and repoints duplicate ids', () => {
    const settings = normalizeSettings({
        rules: [
            { id: 'dup', text: 'first rule', label: 'A' },
            { id: 'dup', text: 'second rule', label: 'B' },
            { id: 'blank', text: '   ' },
        ],
    });
    assert.equal(settings.rules.length, 2);
    assert.notEqual(settings.rules[0].id, settings.rules[1].id);
});

test('normalizeSettings clamps unknown category and position', () => {
    const settings = normalizeSettings({
        rules: [{ text: 'x rule', category: 'nonsense' }],
        inject: { position: 'somewhere', depth: 99, role: 7 },
    });
    assert.equal(settings.rules[0].category, 'style');
    assert.equal(settings.inject.position, 'in_prompt');
    assert.equal(settings.inject.depth, 20);
    assert.equal(settings.inject.role, 0);
});

test('createRule derives a label from the text', () => {
    const rule = createRule({ text: 'Never write purple prose in replies at all, ever, for any reason' });
    assert.ok(rule.label.startsWith('Never write purple prose'));
    assert.ok(rule.label.split(' ').length <= 7, 'labels are a handful of words, not the whole rule');
    assert.equal(rule.strength, 'hard');
    assert.equal(rule.enabled, true);
});

test('overrides win over the global switch, and null clears them', () => {
    const rule = createRule({ text: 'a rule', enabled: false });
    let overrides = setOverride({}, rule.id, true);
    assert.equal(withEffective([rule], overrides)[0].effective, true);
    assert.equal(withEffective([rule], overrides)[0].overridden, true);
    overrides = setOverride(overrides, rule.id, null);
    assert.equal(withEffective([rule], overrides)[0].effective, false);
    assert.equal(withEffective([rule], overrides)[0].overridden, false);
});

/* ------------------------------------------------------------------- compose */

test('composeRules orders categories, hard before soft, and substitutes macros', () => {
    const rules = withEffective([
        createRule({ text: 'soft style rule', category: 'style', strength: 'soft' }),
        createRule({ text: '{{char}} kisses {{user}}', category: 'romance', strength: 'hard' }),
        createRule({ text: 'hard style rule', category: 'style', strength: 'hard' }),
    ], {});

    const text = composeRules(rules, { charName: 'Kisa', userName: 'Kai' });
    assert.ok(text.indexOf('ROMANCE') < text.indexOf('STYLE'), 'romance section comes first');
    assert.ok(text.indexOf('hard style rule') < text.indexOf('soft style rule'), 'hard style before soft');
    assert.ok(text.includes('Kisa kisses Kai'), 'macros substituted');
    assert.ok(text.includes('- Prefer: soft style rule'));
    assert.ok(!text.includes('{{char}}'));
});

test('composeRules returns an empty string when nothing is active', () => {
    const rules = withEffective([createRule({ text: 'off rule', enabled: false })], {});
    assert.equal(composeRules(rules, {}), '');
});

test('composeRules falls back to appending {{rules}} if the template has no placeholder', () => {
    const rules = withEffective([createRule({ text: 'only rule' })], {});
    const text = composeRules(rules, { template: 'HEADER ONLY' });
    assert.ok(text.startsWith('HEADER ONLY'));
    assert.ok(text.includes('only rule'));
});

test('the default template carries the placeholder', () => {
    assert.ok(DEFAULT_TEMPLATE.includes('{{rules}}'));
});

/* ----------------------------------------------------------------- conflicts */

test('findConflicts flags the same topic with different stances', () => {
    const rules = withEffective([
        createRule({ text: 'instant love', group: 'romance pace', stance: 'instant' }),
        createRule({ text: 'slow burn', group: 'romance pace', stance: 'slow' }),
        createRule({ text: 'unrelated', group: '', stance: '' }),
    ], {});
    const conflicts = findConflicts(rules);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].group, 'romance pace');
    assert.equal(conflicts[0].rules.length, 2);
});

test('findConflicts stays quiet for equal stances, missing stances, and disabled rules', () => {
    const sameStance = withEffective([
        createRule({ text: 'a', group: 'g', stance: 's' }),
        createRule({ text: 'b', group: 'g', stance: 's' }),
    ], {});
    assert.equal(findConflicts(sameStance).length, 0);

    const noStance = withEffective([
        createRule({ text: 'a', group: 'g' }),
        createRule({ text: 'b', group: 'g' }),
    ], {});
    assert.equal(findConflicts(noStance).length, 0);

    const disabled = withEffective([
        createRule({ text: 'a', group: 'g', stance: 'x', enabled: false }),
        createRule({ text: 'b', group: 'g', stance: 'y' }),
    ], {});
    assert.equal(findConflicts(disabled).length, 0);
});

/* --------------------------------------------------------------------- sets */

test('applyBook replace turns members on and everything else off', () => {
    const a = createRule({ text: 'a', enabled: false });
    const b = createRule({ text: 'b', enabled: true });
    const settings = normalizeSettings({ rules: [a, b] });
    const book = saveBook(settings, 'Only A');

    // saveBook captures the current selection, so build the book explicitly.
    book.ruleIds = [settings.rules[0].id];
    const result = applyBook(settings, book.id, 'replace');
    assert.equal(settings.rules[0].enabled, true);
    assert.equal(settings.rules[1].enabled, false);
    assert.equal(result.on, 1);
    assert.equal(result.off, 1);
});

test('applyBook add leaves non-members alone', () => {
    const settings = normalizeSettings({
        rules: [
            { text: 'a', enabled: false },
            { text: 'b', enabled: true },
        ],
    });
    const book = saveBook(settings, 'Add A');
    book.ruleIds = [settings.rules[0].id];
    applyBook(settings, book.id, 'add');
    assert.equal(settings.rules[0].enabled, true);
    assert.equal(settings.rules[1].enabled, true);
});

test('saveBook reuses an existing name instead of duplicating it', () => {
    const settings = normalizeSettings({ rules: [{ text: 'a' }] });
    saveBook(settings, 'Mood');
    saveBook(settings, 'mood');
    assert.equal(settings.books.length, 1);
});

test('removeRule prunes the rule out of every set', () => {
    const settings = normalizeSettings({ rules: [{ text: 'a' }, { text: 'b' }] });
    const book = saveBook(settings, 'Both');
    assert.equal(book.ruleIds.length, 2);
    removeRule(settings, settings.rules[0].id);
    assert.equal(settings.rules.length, 1);
    assert.equal(settings.books[0].ruleIds.length, 1);
});

/* ------------------------------------------------------------ import/export */

test('a pack survives export and import, and re-importing it adds nothing twice', () => {
    const source = normalizeSettings({
        rules: [
            { text: 'instant love', category: 'romance', group: 'pace', stance: 'instant' },
            { text: 'no purple prose', category: 'style', strength: 'soft' },
        ],
    });
    source.books.push({ id: 'b1', name: 'Mine', note: '', ruleIds: [source.rules[0].id], updatedAt: Date.now() });

    const pack = JSON.parse(JSON.stringify(exportPack(source)));
    const target = normalizeSettings({});

    const first = importPack(pack, target);
    assert.equal(first.added, 2);
    assert.equal(first.books, 1);
    assert.equal(target.rules.length, 2);
    assert.equal(target.books[0].ruleIds.length, 1, 'book membership remapped onto the new id');

    const second = importPack(pack, target);
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 2);
    assert.equal(target.rules.length, 2);
});

test('importPack remaps book memberships onto the id an existing rule already has', () => {
    const target = normalizeSettings({ rules: [{ text: 'instant love' }] });
    const existingId = target.rules[0].id;

    const pack = {
        format: 'st-rulebook',
        version: 1,
        rules: [
            { id: 'r-instant', label: 'Instant', text: 'instant love' },
            { id: 'r-other', label: 'Other', text: 'other rule' },
        ],
        books: [{ name: 'Shared', ruleIds: ['r-instant', 'r-other'] }],
    };
    // Simulate the exporter's ids by importing once and reading what the book holds.
    importPack(pack, target);
    assert.equal(target.rules.length, 2);
    const book = target.books.find(entry => entry.name === 'Shared');
    assert.equal(book.ruleIds.length, 2);
    assert.ok(book.ruleIds.includes(existingId), 'the skipped rule keeps its existing id');
});

test('importPack rejects foreign files with a readable error', () => {
    assert.throws(() => importPack({ format: 'something-else', rules: [{ text: 'x' }] }, normalizeSettings({})), /another extension/);
    assert.throws(() => importPack({ rules: [] }, normalizeSettings({})), /no rules/);
    assert.throws(() => importPack('not json', normalizeSettings({})), SyntaxError);
});

/* ------------------------------------------------------------------ tokens */

test('tokenEstimate scales roughly four characters per token', () => {
    assert.equal(tokenEstimate(''), 0);
    assert.equal(tokenEstimate('abcd'), 1);
    assert.equal(tokenEstimate('a'.repeat(400)), 100);
    assert.ok(tokenEstimate('日本語のテキスト') >= 8, 'CJK counts denser');
});

/* ----------------------------------------------------------------- parsing */

test('parseRulesResponse reads a sentinel block wrapped in a code fence', () => {
    const raw = ['```json', '<<<RULES>>>', '[{"label":"A","text":"do the thing","category":"style","strength":"soft"}]', '<<<END>>>', '```'].join('\n');
    const rules = parseRulesResponse(raw);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].label, 'A');
    assert.equal(rules[0].strength, 'soft');
    assert.equal(rules[0].enabled, false, 'candidates are not enabled until added');
});

test('parseRulesResponse tolerates a bare array, a wrapper object, and bullets', () => {
    assert.equal(parseRulesResponse('[{"text":"bare array rule"}]').length, 1);
    assert.equal(parseRulesResponse('{"rules":[{"text":"wrapped rule"}]}').length, 1);
    const bullets = parseRulesResponse('- {{char}} never lies\n- Keep replies short\n');
    assert.equal(bullets.length, 2);
    assert.equal(bullets[1].text, 'Keep replies short');
});

test('parseRulesResponse throws a readable error on prose', () => {
    assert.throws(() => parseRulesResponse('Sure! Here are some lovely rules about love.'), RulebookParseError);
    assert.throws(() => parseRulesResponse(''), RulebookParseError);
});

test('parseRulesResponse mints a label when the model omits one', () => {
    const rules = parseRulesResponse('[{"text":"Never write the user\\u0027s dialogue for them"}]');
    assert.ok(rules[0].label.length > 0);
    assert.notEqual(rules[0].label, '');
});

/* ---------------------------------------------------------------- prompts */

test('author and atomize prompts ask for the sentinel and the macro tokens', () => {
    const author = buildAuthorPrompt({ description: 'instant love', count: 3, category: 'romance' });
    assert.ok(author.includes('<<<RULES>>>'));
    assert.ok(author.includes('into 3 separate rules'));
    assert.ok(author.includes('"category" is one of'));
    assert.ok(author.includes('Every rule must use the category "romance"'));

    const atomize = buildAtomizePrompt({ blob: 'some text', count: 5 });
    assert.ok(atomize.includes('at most 5 rules'));
    assert.ok(atomize.includes('{{char}}'));
});

/* -------------------------------------------------------------------- report */

if (failures.length) {
    console.error(`\n${failures.length} failing, ${passed} passing\n`);
    for (const failure of failures) {
        console.error(`✗ ${failure.name}`);
        console.error(`  ${failure.error.message}\n`);
    }
    process.exit(1);
}

console.log(`${passed} passing`);
