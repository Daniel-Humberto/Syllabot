import assert from 'node:assert/strict';
import test from 'node:test';
import { inferTelegramResponseMode, parseTelegramResponseCommand } from './index';

test('parses Telegram response format commands with prompts', () => {
  assert.deepEqual(parseTelegramResponseCommand('/voz explícame recursión'), {
    mode: 'voice',
    prompt: 'explícame recursión',
  });
  assert.deepEqual(parseTelegramResponseCommand('/ambos@Syllabot_bot hola'), {
    mode: 'both',
    prompt: 'hola',
  });
});

test('leaves ordinary Telegram text unchanged', () => {
  assert.deepEqual(parseTelegramResponseCommand('¿Qué es un agente?'), {
    prompt: '¿Qué es un agente?',
  });
});

test('infers response formats from natural Spanish without confusing the topic', () => {
  assert.equal(inferTelegramResponseMode('Explícamelo en una nota de voz, por favor'), 'voice');
  assert.equal(inferTelegramResponseMode('Prefiero que respondas por texto y audio'), 'both');
  assert.equal(inferTelegramResponseMode('Respóndeme como tú veas que conviene'), 'auto');
  assert.equal(inferTelegramResponseMode('¿Cómo funciona el audio digital?'), undefined);
});
