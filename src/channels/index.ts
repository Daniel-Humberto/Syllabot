import { createHmac, timingSafeEqual } from 'crypto';
import { runAgent } from '../agent';
import { createVoiceNote } from '../audio';
import { userSessionId } from '../auth';
import { LinkedAccount, consumeTelegramLink, extractLinkCode, findLinkedAccount } from '../auth/telegram-link';
import { decideApproval } from '../hitl';
import { recordChannelAudit } from '../tools/postgres';
import { DISCORD_PONG_RESPONSE, isDiscordPing, verifyDiscordSignature } from './discord';
import {
  createChannelPresentation,
  discordPresentation,
  registerPresentationActions,
  resolvePresentationAction,
  telegramPresentation,
} from './presentation';

export interface WebhookResult {
  statusCode: number;
  response: Record<string, unknown>;
}

type Headers = Record<string, string | string[] | undefined>;
type JsonObject = Record<string, unknown>;

export type TelegramResponseMode = 'auto' | 'text' | 'voice' | 'both';

interface TelegramInput {
  text: string;
  kind: 'text' | 'voice' | 'audio' | 'document' | 'media';
}

const telegramResponseModes = new Map<string, TelegramResponseMode>();

function header(headers: Headers, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function secureEqual(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

function verifySlack(headers: Headers, rawBody: Buffer): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const timestamp = header(headers, 'x-slack-request-timestamp');
  const signature = header(headers, 'x-slack-signature');
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody.toString('utf8')}`).digest('hex')}`;
  return secureEqual(signature, expected);
}

async function requestJson(url: string, body: JsonObject, authorization?: string, method = 'POST'): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const responseBody = await response.json().catch(() => undefined) as JsonObject | undefined;
  if (!response.ok) throw new Error(`Entrega al canal falló con HTTP ${response.status}`);
  if (responseBody?.ok === false) {
    throw new Error(`El canal rechazó la entrega: ${String(responseBody.description || responseBody.error || 'error desconocido')}`);
  }
}

async function fetchTelegramJson(url: string): Promise<JsonObject> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => undefined) as JsonObject | undefined;
  if (!response.ok || body?.ok === false) {
    throw new Error(`Telegram respondió HTTP ${response.status}: ${String(body?.description || 'error desconocido')}`);
  }
  return body || {};
}

async function downloadTelegramFile(token: string, fileId: string, maxBytes: number): Promise<{ bytes: Buffer; path: string }> {
  const metadata = await fetchTelegramJson(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const result = metadata.result as JsonObject | undefined;
  const filePath = typeof result?.file_path === 'string' ? result.file_path : '';
  const declaredSize = typeof result?.file_size === 'number' ? result.file_size : 0;
  if (!filePath) throw new Error('Telegram no devolvió la ruta del archivo.');
  if (declaredSize > maxBytes) throw new Error(`El archivo supera el límite de ${Math.floor(maxBytes / 1_000_000)} MB.`);
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`No se pudo descargar el archivo de Telegram (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`El archivo supera el límite de ${Math.floor(maxBytes / 1_000_000)} MB.`);
  return { bytes, path: filePath };
}

async function transcribeTelegramAudio(token: string, fileId: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no está configurada para transcribir audio.');
  const file = await downloadTelegramFile(token, fileId, 20_000_000);
  const form = new FormData();
  form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe');
  form.append('file', new Blob([file.bytes]), file.path.split('/').pop() || 'telegram-audio.ogg');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => undefined) as JsonObject | undefined;
  if (!response.ok) throw new Error(`No se pudo transcribir el audio (${response.status}).`);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) throw new Error('La transcripción de audio llegó vacía.');
  return text;
}

export function parseTelegramResponseCommand(input: string): { mode?: TelegramResponseMode; prompt: string } {
  const match = input.trim().match(/^\/(texto|voz|ambos|auto)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return { prompt: input };
  const modes: Record<string, TelegramResponseMode> = { texto: 'text', voz: 'voice', ambos: 'both', auto: 'auto' };
  return { mode: modes[match[1].toLowerCase()], prompt: (match[2] || '').trim() };
}

/** Detecta preferencias expresadas conversacionalmente, sin obligar al usuario a memorizar comandos. */
export function inferTelegramResponseMode(input: string): TelegramResponseMode | undefined {
  const normalized = input.toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
  const asksHowToReply = /(resp[oó]ndeme|cont[eé]stame|d[ií]melo|expl[ií]camelo|m[aá]ndamelo|env[ií]amelo|prefiero|quiero (?:la )?respuesta|puedes responder)/;
  if (!asksHowToReply.test(normalized)) return undefined;
  if (/(texto y (?:audio|voz)|(?:audio|voz) y texto|ambos formatos|las dos formas)/.test(normalized)) return 'both';
  if (/(autom[aá]tic|como (?:t[uú]|veas|convenga)|mejor formato)/.test(normalized)) return 'auto';
  if (/(nota de voz|por voz|con voz|en audio|como audio|audio)/.test(normalized)) return 'voice';
  if (/(por texto|en texto|escrito|sin audio)/.test(normalized)) return 'text';
  return undefined;
}

async function telegramInput(message: JsonObject, token: string): Promise<TelegramInput | null> {
  if (typeof message.text === 'string' && message.text.trim()) return { text: message.text, kind: 'text' };
  const caption = typeof message.caption === 'string' ? message.caption.trim() : '';
  const voice = message.voice as JsonObject | undefined;
  const audio = message.audio as JsonObject | undefined;
  const audioFileId = typeof voice?.file_id === 'string' ? voice.file_id : typeof audio?.file_id === 'string' ? audio.file_id : '';
  if (audioFileId) {
    const transcription = await transcribeTelegramAudio(token, audioFileId);
    return { text: caption ? `${caption}\n\nTranscripción del audio: ${transcription}` : transcription, kind: voice ? 'voice' : 'audio' };
  }

  const document = message.document as JsonObject | undefined;
  if (document && typeof document.file_id === 'string') {
    const mimeType = typeof document.mime_type === 'string' ? document.mime_type : '';
    const fileName = typeof document.file_name === 'string' ? document.file_name : 'documento';
    const isText = mimeType.startsWith('text/') || ['application/json', 'application/xml'].includes(mimeType);
    if (isText) {
      const file = await downloadTelegramFile(token, document.file_id, 1_000_000);
      const content = file.bytes.toString('utf8').replace(/\0/g, '').slice(0, 20_000);
      return { text: `${caption || `Analiza el archivo ${fileName}.`}\n\nContenido del archivo:\n${content}`, kind: 'document' };
    }
    return caption ? { text: `${caption}\n\n[Archivo adjunto: ${fileName}, tipo ${mimeType || 'desconocido'}]`, kind: 'document' } : null;
  }

  const hasMedia = Boolean(message.photo || message.video || message.animation || message.sticker);
  if (hasMedia && caption) return { text: `${caption}\n\n[El usuario adjuntó contenido multimedia en Telegram.]`, kind: 'media' };
  return null;
}

export async function initializeChannelInterfaces(): Promise<void> {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const discordApplicationId = process.env.DISCORD_APPLICATION_ID;
  const jobs: Promise<void>[] = [];

  if (telegramToken) {
    jobs.push(requestJson(`https://api.telegram.org/bot${telegramToken}/setMyCommands`, {
      commands: [
        { command: 'menu', description: 'Abrir acciones disponibles' },
        { command: 'podcast', description: 'Generar podcast conversacional (NotebookLM)' },
        { command: 'audio', description: 'Generar nota de voz en audio' },
        { command: 'texto', description: 'Responder con texto' },
        { command: 'voz', description: 'Responder con una nota de voz' },
        { command: 'ambos', description: 'Responder con texto y voz' },
        { command: 'auto', description: 'Elegir el formato automáticamente' },
        { command: 'status', description: 'Estado de servicios y herramientas' },
        { command: 'buscar', description: 'Buscar información actual' },
        { command: 'ruta', description: 'Crear una ruta con videos de YouTube' },
        { command: 'memoria', description: 'Consultar memoria y conocimiento' },
        { command: 'aprobaciones', description: 'Revisar acciones pendientes' },
        { command: 'ayuda', description: 'Ver capacidades de Syllabot' },
      ],
    }));
  }

  if (discordToken && discordApplicationId) {
    jobs.push(requestJson(
      `https://discord.com/api/v10/applications/${discordApplicationId}/commands`,
      {
        name: 'syllabot',
        description: 'Habla con Syllabot y recibe respuestas interactivas',
        options: [{
          type: 3,
          name: 'consulta',
          description: 'Pregunta o tarea para el agente',
          required: true,
        }],
      },
      `Bot ${discordToken}`,
      'POST'
    ));
    jobs.push(requestJson(
      `https://discord.com/api/v10/applications/${discordApplicationId}/commands`,
      {
        name: 'podcast',
        description: 'Genera un podcast conversacional de dos voces estilo NotebookLM',
        options: [{ type: 3, name: 'tema', description: 'Tema de estudio a debatir', required: true }],
      },
      `Bot ${discordToken}`,
      'POST'
    ));
    jobs.push(requestJson(
      `https://discord.com/api/v10/applications/${discordApplicationId}/commands`,
      { name: 'menu', description: 'Muestra el menú interactivo de Syllabot' },
      `Bot ${discordToken}`,
      'POST'
    ));
    jobs.push(requestJson(
      `https://discord.com/api/v10/applications/${discordApplicationId}/commands`,
      { name: 'status', description: 'Muestra el estado de Syllabot y sus servicios' },
      `Bot ${discordToken}`,
      'POST'
    ));
    jobs.push(requestJson(
      `https://discord.com/api/v10/applications/${discordApplicationId}/commands`,
      {
        name: 'ruta',
        description: 'Crea una ruta con videos verificados de YouTube',
        options: [{ type: 3, name: 'tema', description: 'Qué quieres aprender', required: true }],
      },
      `Bot ${discordToken}`,
      'POST'
    ));
  }

  const outcomes = await Promise.allSettled(jobs);
  outcomes.forEach((outcome) => {
    if (outcome.status === 'rejected') console.warn('[Channel UI] No se pudo registrar un menú:', outcome.reason);
  });
}

async function presentTelegram(
  token: string,
  chatId: string,
  input: string,
  sessionId: string,
  userId?: string,
  messageId?: string,
  account?: LinkedAccount | null,
  responseMode: TelegramResponseMode = 'text'
): Promise<void> {
  const result = await runAgent(input, {
    channel: 'telegram',
    sessionId,
    userId,
    ownerId: account?.id,
    userName: account?.name,
  });

  // Los podcasts se muestran como pista y las explicaciones breves como nota de voz nativa.
  const audioExec = result.toolExecutions.find(
    (e) => (e.name === 'generate_podcast' || e.name === 'generate_voice_note') && e.ok && e.output
  );
  let deliveredAudio = false;
  if (audioExec && typeof audioExec.output === 'object') {
    const audioData = audioExec.output as { audioUrl?: string; title?: string; summary?: string };
    if (audioData.audioUrl) {
      const isVoiceNote = audioExec.name === 'generate_voice_note';
      await requestJson(`https://api.telegram.org/bot${token}/${isVoiceNote ? 'sendVoice' : 'sendAudio'}`, {
        chat_id: chatId,
        [isVoiceNote ? 'voice' : 'audio']: audioData.audioUrl,
        ...(!isVoiceNote ? { title: audioData.title || 'Syllabot Podcast', performer: 'Syllabot (Alex & Sofía)' } : {}),
        caption: audioData.summary ? `🎙️ ${audioData.summary.slice(0, 200)}` : undefined,
      }).then(() => { deliveredAudio = true; }).catch((err) => console.warn('[Telegram Audio] Error enviando audio:', err));
    }
  }

  const presentation = await createChannelPresentation('telegram', input, result.output, {
    sources: result.sources,
    toolExecutions: result.toolExecutions,
    pendingApproval: result.pendingApproval,
  });
  const registered = await registerPresentationActions(presentation, { channel: 'telegram', sessionId, userId });
  const rendered = telegramPresentation(presentation, registered);

  if ((responseMode === 'voice' || responseMode === 'both') && !deliveredAudio) {
    try {
      const note = await createVoiceNote({
        topic: input.slice(0, 160),
        text: result.output.slice(0, 4000),
        ownerId: account?.id,
      });
      await requestJson(`https://api.telegram.org/bot${token}/sendVoice`, {
        chat_id: chatId,
        voice: note.audioUrl,
        caption: responseMode === 'voice' ? result.output.slice(0, 900) : '🎧 Respuesta de Syllabot',
        ...(responseMode === 'voice' ? { reply_markup: rendered.reply_markup } : {}),
      });
      deliveredAudio = true;
    } catch (error) {
      console.warn('[Telegram Voice] No se pudo sintetizar la respuesta:', error);
    }
  }

  // En modo voz sólo cae a texto si la síntesis falló. En ambos se entregan los dos formatos.
  if (responseMode === 'voice' && deliveredAudio) return;
  const method = messageId ? 'editMessageText' : 'sendMessage';
  await requestJson(`https://api.telegram.org/bot${token}/${method}`, {
    chat_id: chatId,
    ...(messageId ? { message_id: messageId } : {}),
    ...rendered,
  });
}

async function presentDiscord(
  applicationId: string,
  interactionToken: string,
  input: string,
  sessionId: string,
  userId?: string,
  editOriginal = false
): Promise<void> {
  const result = await runAgent(input, { channel: 'discord', sessionId, userId });
  const presentation = await createChannelPresentation('discord', input, result.output, {
    sources: result.sources,
    toolExecutions: result.toolExecutions,
    pendingApproval: result.pendingApproval,
  });
  const registered = await registerPresentationActions(presentation, { channel: 'discord', sessionId, userId });
  const rendered = discordPresentation(presentation, registered);
  const baseUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`;
  await requestJson(editOriginal ? `${baseUrl}/messages/@original` : baseUrl, rendered, undefined, editOriginal ? 'PATCH' : 'POST');
}

function runInBackground(label: string, task: () => Promise<void>): void {
  void task().catch((error) => console.error(`[${label}]`, error));
}

function expandChannelCommand(input: string): string {
  const [rawCommand, ...rest] = input.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/^\//, '').split('@')[0];
  const argument = rest.join(' ');
  const commands: Record<string, string> = {
    start: 'Preséntate y muestra un menú breve de tus capacidades con acciones para comenzar.',
    menu: 'Muestra un menú interactivo de las acciones más útiles disponibles.',
    status: 'Resume el estado del sistema, sus bases, búsqueda, canales y modelo en campos separados.',
    podcast: `Genera un podcast conversacional a dos voces (Alex y Sofía, estilo NotebookLM) debatiendo y explicando: ${argument || 'los conceptos clave para aprender agentes de IA'}`,
    audio: `Genera una nota de voz o resumen en audio sobre: ${argument || 'el tema actual'}`,
    buscar: `Busca información actual sobre: ${argument || 'pregúntame primero qué debo buscar'}`,
    ruta: `Crea una ruta de aprendizaje con videos verificados de YouTube para: ${argument || 'pregúntame primero qué quiero aprender'}`,
    memoria: `Consulta la memoria y el grafo sobre: ${argument || 'los temas disponibles'}`,
    aprobaciones: 'Muestra las aprobaciones pendientes y explica cómo resolverlas.',
    ayuda: 'Muestra una guía interactiva y concisa de todas tus capacidades.',
  };
  return commands[command] || input;
}

export async function handleIncomingWebhook(
  channel: string,
  body: unknown,
  headers: Headers,
  rawBody: Buffer
): Promise<WebhookResult> {
  const payload = body && typeof body === 'object' ? body as JsonObject : {};

  if (channel === 'slack') {
    if (!verifySlack(headers, rawBody)) return { statusCode: 401, response: { error: 'Firma de Slack inválida' } };
    if (payload.type === 'url_verification') {
      return { statusCode: 200, response: { challenge: payload.challenge } };
    }
    const event = payload.event as JsonObject | undefined;
    if (!event || typeof event.text !== 'string' || event.bot_id) return { statusCode: 200, response: { received: true } };
    const sessionId = `slack:${String(event.channel || '')}:${String(event.user || '')}`;
    runInBackground('Slack', async () => {
      const result = await runAgent(event.text as string, { channel: 'slack', sessionId, userId: String(event.user || '') });
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error('SLACK_BOT_TOKEN no está configurado');
      await requestJson('https://slack.com/api/chat.postMessage', { channel: event.channel, text: result.output }, `Bearer ${token}`);
    });
    return { statusCode: 200, response: { received: true } };
  }

  if (channel === 'telegram') {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret && !secureEqual(header(headers, 'x-telegram-bot-api-secret-token'), expectedSecret)) {
      return { statusCode: 401, response: { error: 'Secreto de Telegram inválido' } };
    }
    const callback = payload.callback_query as JsonObject | undefined;
    if (callback) {
      const callbackId = String(callback.id || '');
      const callbackMessage = callback.message as JsonObject | undefined;
      const callbackChat = callbackMessage?.chat as JsonObject | undefined;
      const callbackUser = callback.from as JsonObject | undefined;
      const userId = callbackUser?.id === undefined ? undefined : String(callbackUser.id);
      const actionId = typeof callback.data === 'string' && callback.data.startsWith('sy:') ? callback.data.slice(3) : '';
      const action = await resolvePresentationAction(actionId, 'telegram', userId);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token && callbackId) {
        void recordChannelAudit({ channel: 'telegram', eventType: 'component_action', actorId: userId, sessionId: action?.sessionId,
          metadata: { actionId, found: Boolean(action) } }).catch(() => undefined);
        runInBackground('Telegram callback', async () => {
          await requestJson(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: callbackId,
            text: action ? 'Actualizando…' : 'Esta acción ya venció.',
          });
          if (action && callbackChat?.id !== undefined) {
            if (action.approvalId && action.decision) {
              await decideApproval(action.approvalId, action.decision, `telegram:${userId || 'unknown'}`);
            }
            const account = userId ? await findLinkedAccount(userId) : null;
            const callbackChatId = String(callbackChat.id);
            const callbackCommand = parseTelegramResponseCommand(action.prompt);
            const requestedMode = callbackCommand.mode || inferTelegramResponseMode(action.prompt);
            if (requestedMode) telegramResponseModes.set(callbackChatId, requestedMode);
            const storedMode = telegramResponseModes.get(callbackChatId) || 'auto';
            const callbackMode: TelegramResponseMode = storedMode === 'auto' ? 'text' : storedMode;
            await presentTelegram(token, callbackChatId, expandChannelCommand(callbackCommand.prompt), action.sessionId, userId,
              callbackMessage?.message_id === undefined ? undefined : String(callbackMessage.message_id), account,
              callbackMode);
          }
        });
      }
      return { statusCode: 200, response: { received: true, interactive: true } };
    }

    const message = (payload.message || payload.edited_message) as JsonObject | undefined;
    const chat = message?.chat as JsonObject | undefined;
    if (!message || chat?.id === undefined) {
      return { statusCode: 200, response: { received: true } };
    }
    const chatId = String(chat.id);
    void recordChannelAudit({ channel: 'telegram', eventType: 'message', actorId: String((message.from as JsonObject | undefined)?.id || ''),
      sessionId: `telegram:${chatId}` }).catch(() => undefined);
    runInBackground('Telegram', async () => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN no está configurado');

      let incoming: TelegramInput | null;
      try {
        incoming = await telegramInput(message, token);
      } catch (error) {
        await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: `⚠️ No pude procesar ese archivo o audio: ${error instanceof Error ? error.message : 'error desconocido'}`,
        });
        return;
      }
      if (!incoming) {
        await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: 'Puedo leer texto, transcribir notas de voz y audio, y analizar archivos de texto. Para fotos, videos u otros documentos, añade una descripción o pregunta en el pie del mensaje.',
        });
        return;
      }

      // Indicar estado de escritura mientras procesa
      await requestJson(`https://api.telegram.org/bot${token}/sendChatAction`, {
        chat_id: chatId,
        action: 'typing',
      }).catch(() => undefined);

      const from = message.from as JsonObject | undefined;
      const telegramUserId = from?.id ? String(from.id) : undefined;
      const linkCode = extractLinkCode(incoming.text);

      if (linkCode && telegramUserId) {
        const linked = await consumeTelegramLink(linkCode, telegramUserId,
          typeof from?.username === 'string' ? from.username : undefined);
        void recordChannelAudit({ channel: 'telegram', eventType: linked ? 'account_linked' : 'account_link_failed',
          actorId: telegramUserId }).catch(() => undefined);
        await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: linked
            ? `✅ Listo, ${linked.name}. Tu Telegram quedó vinculado a tu cuenta de Syllabot: aquí continúas la misma conversación y usas tu contenido.`
            : '⚠️ Ese enlace ya venció o ya se usó. Genera uno nuevo desde Syllabot → Telegram.',
        });
        return;
      }

      const account = telegramUserId ? await findLinkedAccount(telegramUserId) : null;
      const sessionId = account ? userSessionId(account.id) : `telegram:${chatId}`;
      const parsed = parseTelegramResponseCommand(incoming.text);
      const requestedMode = parsed.mode || inferTelegramResponseMode(incoming.text);
      if (requestedMode) telegramResponseModes.set(chatId, requestedMode);
      if (parsed.mode && !parsed.prompt) {
        const labels: Record<TelegramResponseMode, string> = {
          auto: 'automático', text: 'texto', voice: 'nota de voz', both: 'texto y voz',
        };
        await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Formato de respuesta cambiado a ${labels[parsed.mode]}. Ahora envíame tu pregunta.`,
        });
        return;
      }
      const storedMode = telegramResponseModes.get(chatId) || 'auto';
      const responseMode: TelegramResponseMode = storedMode === 'auto'
        ? (incoming.kind === 'voice' || incoming.kind === 'audio' ? 'voice' : 'text')
        : storedMode;
      await presentTelegram(token, chatId, expandChannelCommand(parsed.prompt), sessionId,
        telegramUserId, undefined, account, responseMode);
    });
    return { statusCode: 200, response: { received: true } };
  }

  if (channel === 'discord') {
    const valid = verifyDiscordSignature({
      rawBody: rawBody.toString('utf8'),
      signature: header(headers, 'x-signature-ed25519'),
      timestamp: header(headers, 'x-signature-timestamp'),
      publicKey: process.env.DISCORD_PUBLIC_KEY || '',
    });
    if (!valid) return { statusCode: 401, response: { error: 'Firma de Discord inválida' } };
    if (isDiscordPing(payload)) return { statusCode: 200, response: DISCORD_PONG_RESPONSE };
    const data = payload.data as JsonObject | undefined;
    const applicationId = String(payload.application_id || '');
    const interactionToken = String(payload.token || '');
    const user = (payload.member as JsonObject | undefined)?.user as JsonObject | undefined;
    const directUser = payload.user as JsonObject | undefined;
    const userId = String(user?.id || directUser?.id || '');
    const customId = typeof data?.custom_id === 'string' ? data.custom_id : '';
    if (payload.type === 3 && customId.startsWith('sy:')) {
      const selectedValues = Array.isArray(data?.values) ? data.values : [];
      const actionId = customId === 'sy:menu' && typeof selectedValues[0] === 'string'
        ? selectedValues[0]
        : customId.slice(3);
      const action = await resolvePresentationAction(actionId, 'discord', userId || undefined);
      void recordChannelAudit({ channel: 'discord', eventType: 'component_action', actorId: userId || undefined,
        sessionId: action?.sessionId, metadata: { actionId, found: Boolean(action) } }).catch(() => undefined);
      if (!action) {
        return { statusCode: 200, response: { type: 4, data: { content: 'Esta acción ya venció. Ejecuta el comando otra vez.', flags: 64 } } };
      }
      runInBackground('Discord component', async () => {
        if (action.approvalId && action.decision) {
          await decideApproval(action.approvalId, action.decision, `discord:${userId || 'unknown'}`);
        }
        await presentDiscord(applicationId, interactionToken, action.prompt, action.sessionId, userId || undefined, true);
      });
      return { statusCode: 200, response: { type: 6 } };
    }

    const options = Array.isArray(data?.options) ? data.options as JsonObject[] : [];
    const optionValues = (items: JsonObject[]): string[] => items.flatMap((option) => [
      ...(typeof option.value === 'string' ? [option.value] : []),
      ...(Array.isArray(option.options) ? optionValues(option.options as JsonObject[]) : []),
    ]);
    const commandInput = optionValues(options).join(' ') || String(data?.name || 'menu');
    const text = expandChannelCommand(commandInput);
    const sessionId = `discord:${userId || interactionToken}`;
    void recordChannelAudit({ channel: 'discord', eventType: 'command', actorId: userId || undefined, sessionId,
      metadata: { command: String(data?.name || '') } }).catch(() => undefined);
    runInBackground('Discord', async () => {
      await presentDiscord(applicationId, interactionToken, text, sessionId, userId || undefined);
    });
    return { statusCode: 200, response: { type: 5 } };
  }

  if (channel === 'test') {
    const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload);
    const result = await runAgent(text, { channel: 'test', sessionId: String(payload.sessionId || 'webhook-test') });
    return { statusCode: 200, response: { received: true, ...result } };
  }

  return { statusCode: 404, response: { error: 'Canal no soportado' } };
}
