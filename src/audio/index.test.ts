import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  AUDIO_STORAGE_DIR,
  ensureAudioDirectory,
  generatePodcastScript,
} from './index';

test('ensureAudioDirectory creates storage/audio folder', () => {
  ensureAudioDirectory();
  assert.equal(fs.existsSync(AUDIO_STORAGE_DIR), true);
});

test('generatePodcastScript parses valid dialogue turns', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: 'Rust Concurrente sin Miedo',
            summary: 'Un repaso a la concurrencia segura en Rust con Alex y Sofía.',
            turns: [
              { speaker: 'Alex', voice: 'echo', text: '¡Bienvenidos a Syllabot! Hoy hablamos de Rust y concurrencia.' },
              { speaker: 'Sofía', voice: 'nova', text: 'Hola Alex. Lo genial de Rust es que el compilador previene data races en tiempo de compilación.' },
              { speaker: 'Alex', voice: 'echo', text: '¿Eso significa que no necesitamos mutexes?' },
              { speaker: 'Sofía', voice: 'nova', text: 'Los usamos con Arc y Mutex, pero sin riesgo de corromper memoria.' },
            ],
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key';
    const script = await generatePodcastScript('Rust y Concurrencia');
    assert.equal(script.title, 'Rust Concurrente sin Miedo');
    assert.equal(script.turns.length, 4);
    assert.equal(script.turns[0].speaker, 'Alex');
    assert.equal(script.turns[1].speaker, 'Sofía');
    assert.equal(script.turns[0].voice, 'echo');
    assert.equal(script.turns[1].voice, 'nova');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
