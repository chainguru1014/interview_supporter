const GPT3Encoder = require('gpt-3-encoder');

function calculateTokenCount(messages = []) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((sum, msg) => {
        if (!msg || typeof msg.content !== 'string') return sum;
        return sum + GPT3Encoder.encode(msg.content).length;
    }, 0);
}

function trimMessagesToTokenLimit(messages = [], maxTokens = 12000) {
    if (!Array.isArray(messages)) return { messages: [], tokenCount: 0 };
    let trimmed = [...messages];
    let tokenCount = calculateTokenCount(trimmed);

    while (tokenCount > maxTokens && trimmed.length > 2) {
        trimmed = trimmed.slice(2);
        tokenCount = calculateTokenCount(trimmed);
    }

    return { messages: trimmed, tokenCount };
}

module.exports = {
    calculateTokenCount,
    trimMessagesToTokenLimit,
};
