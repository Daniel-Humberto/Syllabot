export interface RouterConfig {
  defaultModel?: string;
  temperature?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  model: string;
  message: ChatMessage;
  usage?: Record<string, number>;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function createChatCompletion(
  messages: ChatMessage[],
  options: RouterConfig & { tools?: ChatTool[] } = {}
): Promise<ChatCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no está configurada.');

  const model = options.defaultModel || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://sylabot.humbert.uk',
      'X-Title': 'Sylabot',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OpenRouter respondió ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as {
    model?: string;
    choices?: Array<{ message?: ChatMessage }>;
    usage?: Record<string, number>;
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('OpenRouter no devolvió un mensaje.');
  return { model: data.model || model, message, usage: data.usage };
}

export async function routePrompt(prompt: string, config?: RouterConfig) {
  const result = await createChatCompletion([{ role: 'user', content: prompt }], config);
  return { model: result.model, prompt, response: result.message.content || '', usage: result.usage };
}
