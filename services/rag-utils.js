function coerceToArray(input) {
    if (!input) return [];

    if (Array.isArray(input)) {
        return input
            .map(item => (typeof item === 'string' ? item.trim() : String(item)))
            .filter(item => item.length > 0);
    }

    if (typeof input === 'string') {
        return input
            .split(/\r?\n|[•\-–]\s+|;/)
            .map(item => item.trim())
            .filter(item => item.length > 0);
    }

    if (typeof input === 'object') {
        return Object.values(input)
            .flatMap(value => coerceToArray(value));
    }

    return [String(input).trim()].filter(Boolean);
}

function normalizeRagPayload(payload = {}) {
    return {
        requirements: coerceToArray(
            payload.requirements ||
            payload.reqs ||
            payload.requirementNotes
        ),
        outline: coerceToArray(
            payload.outline ||
            payload.plan ||
            payload.solution ||
            payload.implementation
        ),
        tests: coerceToArray(
            payload.tests ||
            payload.testIdeas ||
            payload.qa
        ),
        insights: coerceToArray(
            payload.insights ||
            payload.notes ||
            payload.callouts
        ),
    };
}

function mergeRagState(current = {}, update = {}) {
    const base = {
        requirements: new Set(current.requirements || []),
        outline: new Set(current.outline || []),
        tests: new Set(current.tests || []),
        insights: new Set(current.insights || []),
    };

    const normalized = normalizeRagPayload(update);

    normalized.requirements.forEach(item => base.requirements.add(item));
    normalized.outline.forEach(item => base.outline.add(item));
    normalized.tests.forEach(item => base.tests.add(item));
    normalized.insights.forEach(item => base.insights.add(item));

    return {
        requirements: Array.from(base.requirements),
        outline: Array.from(base.outline),
        tests: Array.from(base.tests),
        insights: Array.from(base.insights),
    };
}

module.exports = {
    normalizeRagPayload,
    mergeRagState,
};
