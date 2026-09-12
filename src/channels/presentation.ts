import { randomUUID } from 'crypto';
import { createChatCompletion } from '../router';
import { consumeChannelAction, saveChannelActions } from '../tools/postgres';

export type ActionStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface PresentationAction {
  label: string;
  prompt: string;
  style: ActionStyle;
  approvalId?: string;
  decision?: 'approved' | 'rejected';
}

export interface ChannelPresentation {
  kind: 'answer' | 'menu' | 'status' | 'approval';
  title: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  actions: PresentationAction[];
  footer?: string;
}

interface StoredAction extends PresentationAction {
  channel: 'telegram' | 'discord';
  sessionId: string;
  userId?: string;
  expiresAt: number;
}

const actions = new Map<string, StoredAction>();
const ACTION_TTL_MS = 30 * 60_000;

async function composeWithCopilotKit(prompt: string): Promise<string> {
  const runtimeUrl = process.env.COPILOTKIT_RUNTIME_URL;
  if (!runtimeUrl) throw new Error('COPILOTKIT_RUNTIME_URL no está configurada');
  const id = randomUUID();
  const response = await fetch(runtimeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-admin-key': process.env.ADMIN_API_KEY || '',
    },
    body: JSON.stringify({
      method: 'agent/run',
      params: { agentId: 'default' },
      body: {
        threadId: `channel-ui:${id}`,
        runId: id,
        messages: [
          { id: `${id}:system`, role: 'system', content: 'Eres el compositor de interfaces portables de CopilotKit para canales de mensajería.' },
          { id: `${id}:user`, role: 'user', content: prompt },
        ],
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`CopilotKit respondió HTTP ${response.status}`);
  const stream = await response.text();
  const content = stream.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try { return JSON.parse(line.slice(6)) as { type?: string; delta?: string }; } catch { return {}; }
    })
    .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string')
    .map((event) => event.delta)
    .join('');
  if (!content) throw new Error('CopilotKit no devolvió contenido para la interfaz');
  return content;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parsePresentation(raw: string, fallback: string): ChannelPresentation {
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0];
  let value: Record<string, unknown> = {};
  try { value = candidate ? JSON.parse(candidate) as Record<string, unknown> : {}; } catch { value = {}; }

  const validKinds = new Set(['answer', 'menu', 'status', 'approval']);
  const kind = validKinds.has(String(value.kind)) ? value.kind as ChannelPresentation['kind'] : 'answer';
  const fields = Array.isArray(value.fields) ? value.fields.slice(0, 6).map((item) => {
    const field = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return { label: text(field.label, 60), value: text(field.value, 300) };
  }).filter((field) => field.label && field.value) : [];
  const parsedActions = Array.isArray(value.actions) ? value.actions.slice(0, 5).map((item) => {
    const action = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const style = ['primary', 'secondary', 'success', 'danger'].includes(String(action.style))
      ? action.style as ActionStyle : 'secondary';
    return { label: text(action.label, 40), prompt: text(action.prompt, 500), style };
  }).filter((action) => action.label && action.prompt) : [];

  return {
    kind,
    title: text(value.title, 80) || 'Syllabot',
    summary: text(value.summary, 3000) || fallback.slice(0, 3000),
    fields,
    actions: parsedActions.length ? parsedActions : [
      { label: 'Ver un ejemplo', prompt: 'Enséñame el concepto anterior con un ejemplo claro y conectado con lo que ya hablamos.', style: 'primary' },
      { label: 'Practicar', prompt: 'Guíame con un ejercicio breve sobre el concepto anterior y espera mi respuesta.', style: 'success' },
      { label: 'Profundizar', prompt: 'Profundiza en el siguiente aspecto más útil del tema anterior.', style: 'secondary' },
      { label: 'Escucharlo', prompt: '/voz Explícame de nuevo lo esencial de la respuesta anterior de forma natural y breve.', style: 'secondary' },
    ],
    footer: text(value.footer, 120) || undefined,
  };
}

export async function createChannelPresentation(
  channel: 'telegram' | 'discord',
  userInput: string,
  agentOutput: string,
  metadata: { sources?: unknown[]; toolExecutions?: unknown[]; pendingApproval?: { id: string; action?: string } } = {}
): Promise<ChannelPresentation> {
  const prompt = `Convierte una respuesta de agente en una interfaz nativa dinámica para ${channel}.
Devuelve EXCLUSIVAMENTE JSON válido con esta forma:
{"kind":"answer|menu|status|approval","title":"...","summary":"...","fields":[{"label":"...","value":"..."}],"actions":[{"label":"...","prompt":"mensaje que se enviará al agente al pulsar","style":"primary|secondary|success|danger"}],"footer":"..."}
Reglas: conserva la respuesta y sus hechos; no inventes datos; máximo 6 fields y 5 actions; usa approval sólo si la respuesta pide autorización humana; no incluyas Markdown complejo ni URLs como acciones.
Diseña la interfaz como la continuación natural de una tutoría, no como un menú rígido. Ofrece entre 2 y 4 acciones breves que respondan al momento actual del aprendizaje (por ejemplo: ver un ejemplo, practicar, comprobar comprensión o profundizar), sin repetir siempre las mismas. La primera debe ser el siguiente paso que más conviene. Cuando sea útil, incluye una acción para escuchar o leer la explicación; su prompt debe comenzar con /voz o /texto para que Telegram cambie el formato automáticamente.
Consulta: ${userInput.slice(0, 2000)}
Respuesta: ${agentOutput.slice(0, 6000)}
  Metadatos: ${JSON.stringify(metadata).slice(0, 3000)}`;
  try {
    let composed: string;
    try {
      composed = await composeWithCopilotKit(prompt);
    } catch (copilotError) {
      console.warn('[Channel UI] CopilotKit no disponible, usando router directo:', copilotError instanceof Error ? copilotError.message : copilotError);
      const completion = await createChatCompletion([
        { role: 'system', content: 'Eres el compositor de interfaces portables de CopilotKit para canales de mensajería.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1 });
      composed = completion.message.content || '';
    }
    const presentation = parsePresentation(composed, agentOutput);
    if (metadata.pendingApproval) {
      presentation.kind = 'approval';
      presentation.title = 'Aprobación requerida';
      presentation.actions = [
        {
          label: 'Aprobar',
          prompt: `La acción ${metadata.pendingApproval.action || metadata.pendingApproval.id} fue aprobada por el usuario.`,
          style: 'success',
          approvalId: metadata.pendingApproval.id,
          decision: 'approved',
        },
        {
          label: 'Rechazar',
          prompt: `La acción ${metadata.pendingApproval.action || metadata.pendingApproval.id} fue rechazada por el usuario.`,
          style: 'danger',
          approvalId: metadata.pendingApproval.id,
          decision: 'rejected',
        },
      ];
    }
    return presentation;
  } catch (error) {
    console.warn('[Channel UI] No se pudo generar presentación dinámica:', error instanceof Error ? error.message : error);
    const fallback = parsePresentation('', agentOutput);
    if (metadata.pendingApproval) {
      fallback.kind = 'approval';
      fallback.title = 'Aprobación requerida';
      fallback.actions = [
        { label: 'Aprobar', prompt: 'La acción fue aprobada por el usuario.', style: 'success', approvalId: metadata.pendingApproval.id, decision: 'approved' },
        { label: 'Rechazar', prompt: 'La acción fue rechazada por el usuario.', style: 'danger', approvalId: metadata.pendingApproval.id, decision: 'rejected' },
      ];
    }
    return fallback;
  }
}

export async function registerPresentationActions(
  presentation: ChannelPresentation,
  context: { channel: 'telegram' | 'discord'; sessionId: string; userId?: string }
): Promise<Array<PresentationAction & { id: string }>> {
  const now = Date.now();
  for (const [id, action] of actions) if (action.expiresAt <= now) actions.delete(id);
  const registered = presentation.actions.map((action) => {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    actions.set(id, { ...action, ...context, expiresAt: now + ACTION_TTL_MS });
    return { ...action, id };
  });
  if (process.env.DATABASE_URL) {
    await saveChannelActions(registered.map((action) => ({ ...action, ...context, expiresAt: now + ACTION_TTL_MS })));
  }
  return registered;
}

export async function resolvePresentationAction(
  id: string,
  channel: 'telegram' | 'discord',
  userId?: string
): Promise<StoredAction | undefined> {
  if (process.env.DATABASE_URL) {
    // Con persistencia habilitada, PostgreSQL es la autoridad. Fallar cerrado evita
    // que una acción ya consumida pueda reutilizarse durante una caída temporal.
    const durable = await consumeChannelAction(id, channel, userId);
    actions.delete(id);
    return durable;
  }
  const action = actions.get(id);
  if (!action || action.expiresAt <= Date.now() || action.channel !== channel) {
    actions.delete(id);
    return undefined;
  }
  if (action.userId && action.userId !== userId) return undefined;
  actions.delete(id);
  return action;
}

export function telegramPresentation(
  presentation: ChannelPresentation,
  registered: Array<PresentationAction & { id: string }>
): Record<string, unknown> {
  const icon = presentation.kind === 'approval' ? '🔐' : presentation.kind === 'status' ? '📊' : presentation.kind === 'menu' ? '🧭' : '✨';
  const fields = presentation.fields.map((field) => `\n${field.label}\n${field.value}`).join('\n');
  const footer = presentation.footer ? `\n\n${presentation.footer}` : '';
  return {
    text: `${icon} ${presentation.title}\n\n${presentation.summary}${fields}${footer}`.slice(0, 4000),
    reply_markup: {
      inline_keyboard: registered.map((action) => [{
        text: `${action.style === 'success' ? '✅ ' : action.style === 'danger' ? '✖️ ' : ''}${action.label}`,
        callback_data: `sy:${action.id}`,
      }]),
    },
  };
}

export function discordPresentation(
  presentation: ChannelPresentation,
  registered: Array<PresentationAction & { id: string }>
): Record<string, unknown> {
  const colors = { answer: 0x38bdf8, menu: 0x8b5cf6, status: 0x22c55e, approval: 0xf59e0b };
  const styles = { primary: 1, secondary: 2, success: 3, danger: 4 };
  const interactiveComponents = presentation.kind === 'menu' && registered.length >= 3
    ? [{
        type: 3,
        custom_id: 'sy:menu',
        placeholder: 'Selecciona una acción',
        options: registered.map((action) => ({
          label: action.label,
          value: action.id,
          description: action.prompt.slice(0, 100),
        })),
      }]
    : registered.map((action) => ({
        type: 2,
        style: styles[action.style],
        label: action.label,
        custom_id: `sy:${action.id}`,
      }));
  return {
    embeds: [{
      title: presentation.title,
      description: presentation.summary.slice(0, 4096),
      color: colors[presentation.kind],
      fields: presentation.fields.map((field) => ({ name: field.label, value: field.value, inline: true })),
      ...(presentation.footer ? { footer: { text: presentation.footer } } : {}),
    }],
    components: registered.length ? [{
      type: 1,
      components: interactiveComponents,
    }] : [],
    allowed_mentions: { parse: [] },
  };
}
