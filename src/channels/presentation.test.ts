import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChannelPresentation,
  discordPresentation,
  registerPresentationActions,
  resolvePresentationAction,
  telegramPresentation,
} from './presentation';

const presentation: ChannelPresentation = {
  kind: 'status',
  title: 'Estado del sistema',
  summary: 'Todos los servicios están disponibles.',
  fields: [{ label: 'Qdrant', value: 'Operativo' }],
  actions: [{ label: 'Actualizar', prompt: 'Actualiza el estado.', style: 'primary' }],
  footer: 'Syllabot',
};

test('registers channel actions bound to their user and session', async () => {
  const [registered] = await registerPresentationActions(presentation, {
    channel: 'telegram',
    sessionId: 'telegram:1',
    userId: 'user-1',
  });
  assert.ok(registered.id);
  assert.equal((await resolvePresentationAction(registered.id, 'telegram', 'user-1'))?.sessionId, 'telegram:1');
  assert.equal(await resolvePresentationAction(registered.id, 'telegram', 'user-2'), undefined);
  assert.equal(await resolvePresentationAction(registered.id, 'discord', 'user-1'), undefined);
});

test('renders Telegram inline keyboards within callback limits', async () => {
  const [registered] = await registerPresentationActions(presentation, { channel: 'telegram', sessionId: 'telegram:1' });
  const rendered = telegramPresentation(presentation, [registered]);
  const keyboard = rendered.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  assert.match(String(rendered.text), /Estado del sistema/);
  assert.ok(Buffer.byteLength(keyboard.inline_keyboard[0][0].callback_data) <= 64);
});

test('renders Discord embeds and interactive components', async () => {
  const [registered] = await registerPresentationActions(presentation, { channel: 'discord', sessionId: 'discord:1' });
  const rendered = discordPresentation(presentation, [registered]);
  const embeds = rendered.embeds as Array<{ title: string }>;
  const rows = rendered.components as Array<{ components: Array<{ custom_id: string }> }>;
  assert.equal(embeds[0].title, 'Estado del sistema');
  assert.match(rows[0].components[0].custom_id, /^sy:/);
});

test('renders menu presentations as a Discord select menu', async () => {
  const menu: ChannelPresentation = {
    ...presentation,
    kind: 'menu',
    actions: [
      { label: 'Buscar', prompt: 'Busca información.', style: 'primary' },
      { label: 'Memoria', prompt: 'Consulta la memoria.', style: 'secondary' },
      { label: 'Estado', prompt: 'Muestra el estado.', style: 'success' },
    ],
  };
  const registered = await registerPresentationActions(menu, { channel: 'discord', sessionId: 'discord:menu' });
  const rendered = discordPresentation(menu, registered);
  const rows = rendered.components as Array<{ components: Array<{ type: number; options: unknown[] }> }>;
  assert.equal(rows[0].components[0].type, 3);
  assert.equal(rows[0].components[0].options.length, 3);
});
