import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLinkCode } from './telegram-link';

const code = 'AbCdEfGhIjKlMnOpQrStUvWxYz_-0123';

test('extractLinkCode reads the code from a deep-link /start command', () => {
  assert.equal(extractLinkCode(`/start ${code}`), code);
  assert.equal(extractLinkCode(`/start@Syllabot_bot ${code}`), code);
});

test('extractLinkCode ignores plain /start and unrelated text', () => {
  assert.equal(extractLinkCode('/start'), null);
  assert.equal(extractLinkCode('hola'), null);
  assert.equal(extractLinkCode(`/menu ${code}`), null);
});

test('extractLinkCode rejects codes with unsafe characters', () => {
  assert.equal(extractLinkCode('/start abc$%^&*()abcdefghijk'), null);
  assert.equal(extractLinkCode('/start short'), null);
});
