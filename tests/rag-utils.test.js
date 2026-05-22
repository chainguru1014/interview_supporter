const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRagPayload, mergeRagState } = require('../services/rag-utils');

test('normalizeRagPayload coerces strings and arrays', () => {
    const raw = {
        requirements: 'Implement auth\nAdd metrics',
        outline: ['Set up Redux', 'Wire API'],
        tests: { happy: 'should login', sad: 'should reject bad creds' },
        insights: null,
    };

    const normalized = normalizeRagPayload(raw);
    assert.deepEqual(normalized.requirements, ['Implement auth', 'Add metrics']);
    assert.deepEqual(normalized.outline, ['Set up Redux', 'Wire API']);
    assert.deepEqual(normalized.tests.sort(), ['should login', 'should reject bad creds'].sort());
    assert.deepEqual(normalized.insights, []);
});

test('mergeRagState deduplicates and merges buckets', () => {
    const current = {
        requirements: ['Implement auth'],
        outline: ['Set up Redux'],
        tests: ['should login'],
        insights: [],
    };

    const update = {
        requirements: ['Implement auth', 'Add metrics'],
        outline: 'Add sagas',
        tests: 'should reject bad creds',
        insights: ['Consider rate limiting'],
    };

    const merged = mergeRagState(current, update);
    assert.deepEqual(merged.requirements.sort(), ['Implement auth', 'Add metrics'].sort());
    assert.deepEqual(merged.outline.sort(), ['Set up Redux', 'Add sagas'].sort());
    assert.deepEqual(merged.tests.sort(), ['should login', 'should reject bad creds'].sort());
    assert.deepEqual(merged.insights, ['Consider rate limiting']);
});
