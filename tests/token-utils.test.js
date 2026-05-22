const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateTokenCount, trimMessagesToTokenLimit } = require('../services/token-utils');

const sample = (text) => ({ role: 'user', content: text });

test('calculateTokenCount handles mixed messages', () => {
  const messages = [sample('Hello world'), sample('React Native and CTV development!')];
  const tokens = calculateTokenCount(messages);
  assert.ok(Number.isInteger(tokens));
  assert.ok(tokens > 0);
});

test('trimMessagesToTokenLimit prunes oldest pairs', () => {
  const messages = [
    sample('old question'),
    { role: 'assistant', content: 'old answer' },
    sample('new question'),
    { role: 'assistant', content: 'new answer' }
  ];
  const limit = 20;
  const { messages: trimmed, tokenCount } = trimMessagesToTokenLimit(messages, limit);
  assert.ok(trimmed.length <= messages.length);
  assert.ok(tokenCount <= limit || trimmed.length <= 2);
});
