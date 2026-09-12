import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatCompletion } from './index';

test('createChatCompletion maps an OpenRouter response', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'test/model',
    choices: [{ message: { role: 'assistant', content: 'hola' } }],
    usage: { total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const result = await createChatCompletion([{ role: 'user', content: 'hola' }]);
    assert.equal(result.model, 'test/model');
    assert.equal(result.message.content, 'hola');
    assert.equal(result.usage?.total_tokens, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});
