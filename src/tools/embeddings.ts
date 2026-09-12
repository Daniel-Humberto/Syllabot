/**
 * Inferencia de Embeddings en la Nube mediante OpenRouter
 *
 * Utiliza el modelo text-embedding-3-small (1536 dimensiones) por defecto.
 */

export interface EmbeddingOptions {
  model?: string;
}

export async function getEmbedding(
  text: string,
  options?: EmbeddingOptions
): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY no está configurada en las variables de entorno.');
  }

  const model = options?.model || 'text-embedding-3-small';

  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error en OpenRouter embeddings (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  if (!data.data || !data.data[0] || !data.data[0].embedding) {
    throw new Error('Formato de respuesta inesperado de OpenRouter embeddings');
  }

  return data.data[0].embedding;
}
