export * from './embeddings';
export * from './qdrant';
export * from './neo4j';
export * from './knowledge';
export * from './exa';
export * from './postgres';
export * from './searxng';
export * from '../routes';
export * from '../audio';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const registeredTools: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Busca información actual en la web mediante Exa. Úsala para hechos recientes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        numResults: { type: 'number', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'searxng_search',
    description: 'Busca información en internet en tiempo real usando el motor de metabúsqueda local SearXNG (DuckDuckGo, Google, Wikipedia, Bing).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Términos de búsqueda' },
        limit: { type: 'number', minimum: 1, maximum: 10, description: 'Cantidad de resultados' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'vector_search',
    description: 'Busca información relevante por similitud semántica en Qdrant.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Pregunta de búsqueda semántica' },
        limit: { type: 'number', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'graph_query',
    description: 'Busca entidades y relaciones relevantes en Neo4j.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Entidad o concepto que se desea buscar' },
        entityId: { type: 'string', description: 'ID exacto de una entidad, si ya se conoce' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_learning_route',
    description: 'Crea una ruta personalizada con videos reales de YouTube cuyos subtítulos fueron verificados. Úsala cuando el usuario pida aprender un tema, un curso o una ruta de estudio.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Meta concreta de aprendizaje' },
        level: { type: 'string', description: 'Nivel actual del estudiante' },
        hoursPerWeek: { type: 'number', minimum: 1, maximum: 40 },
        durationWeeks: { type: 'number', minimum: 1, maximum: 24 },
        language: { type: 'string', description: 'Código de idioma, por ejemplo es o en' },
        preferences: { type: 'array', items: { type: 'string' } },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_podcast',
    description: 'Genera un episodio de audio podcast conversacional estilo NotebookLM (a dos voces: Alex y Sofía) en formato MP3 sobre cualquier tema de estudio. Devuelve el título, resumen pedagógico, URL de audio y transcripción completa de los turnos.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Tema o concepto sobre el que se generará el podcast' },
        focus: { type: 'string', description: 'Enfoque específico o dudas que deben abordar los locutores' },
        language: { type: 'string', description: 'Código de idioma (por defecto es)' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_voice_note',
    description: 'Genera una nota de voz directa en formato de audio MP3 explicando un tema o resumen pedagógico en 30-60 segundos.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Tema de la nota de voz' },
        text: { type: 'string', description: 'Contenido explicativo a sintetizar' },
      },
      required: ['topic', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_approval',
    description: 'Crea una solicitud HITL antes de una acción externa, irreversible o sensible.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['action', 'reason'],
      additionalProperties: false,
    },
  },
];

export async function executeTool(name: string, args: Record<string, unknown>, scope: { ownerId?: string } = {}) {
  if (name === 'searxng_search' && typeof args.query === 'string') {
    const { searchWebSearxng } = await import('./searxng');
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    return await searchWebSearxng(args.query, limit);
  }

  if (name === 'web_search' && typeof args.query === 'string') {
    try {
      const { searchWeb } = await import('./exa');
      return { results: await searchWeb(args.query, Number(args.numResults) || 5) };
    } catch {
      // Fallback a SearXNG local si Exa no está disponible o falla
      const { searchWebSearxng } = await import('./searxng');
      return await searchWebSearxng(args.query, Number(args.numResults) || 5);
    }
  }

  if (name === 'vector_search' && typeof args.query === 'string') {
    const { searchSimilarDocuments } = await import('./qdrant');
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    return { results: await searchSimilarDocuments(args.query, limit, undefined, scope.ownerId) };
  }

  if (name === 'graph_query') {
    const { getEntityKnowledgeGraph, searchKnowledgeGraph } = await import('./neo4j');
    if (typeof args.entityId === 'string') return { graph: await getEntityKnowledgeGraph(args.entityId, scope.ownerId) };
    if (typeof args.query === 'string') return { graph: await searchKnowledgeGraph(args.query, 10, scope.ownerId) };
    throw new Error('graph_query requiere query o entityId.');
  }

  if (name === 'create_learning_route' && typeof args.goal === 'string') {
    const { generateLearningRoute } = await import('../routes');
    const generated = await generateLearningRoute(args, scope.ownerId);
    // No reenviar decenas de miles de caracteres de transcripts al contexto del
    // agente: la curación ya los utilizó y la ruta final contiene lo accionable.
    return {
      id: generated.id,
      profile: generated.profile,
      route: generated.route,
      verification: {
        relevantCandidates: generated.candidates.candidates.length,
        withoutTranscript: generated.candidates.withoutTranscript,
        rejectedAsIrrelevant: generated.candidates.rejectedAsIrrelevant,
        videos: generated.candidates.candidates.map(({ videoId, title, url, channel, transcriptAvailable }) => ({
          videoId, title, url, channel, transcriptAvailable,
        })),
      },
      persisted: Boolean(scope.ownerId),
      createdAt: generated.createdAt,
    };
  }

  if (name === 'generate_podcast' && typeof args.topic === 'string') {
    const { createPodcastEpisode } = await import('../audio');
    const episode = await createPodcastEpisode({
      topic: args.topic,
      focus: typeof args.focus === 'string' ? args.focus : undefined,
      language: typeof args.language === 'string' ? args.language : 'es',
      ownerId: scope.ownerId,
    });
    return {
      podcastId: episode.id,
      title: episode.title,
      summary: episode.summary,
      audioUrl: episode.audioUrl,
      durationSeconds: episode.durationSeconds,
      turns: episode.turns,
      message: `🎙️ Podcast generado exitosamente: "${episode.title}". Puedes escucharlo en ${episode.audioUrl}`,
    };
  }

  if (name === 'generate_voice_note' && typeof args.topic === 'string' && typeof args.text === 'string') {
    const { createVoiceNote } = await import('../audio');
    const note = await createVoiceNote({
      topic: args.topic,
      text: args.text,
      ownerId: scope.ownerId,
    });
    return {
      voiceNoteId: note.id,
      title: note.title,
      audioUrl: note.audioUrl,
      durationSeconds: note.durationSeconds,
      message: `🎧 Nota de voz generada: ${note.audioUrl}`,
    };
  }

  if (name === 'request_approval' && typeof args.action === 'string' && typeof args.reason === 'string') {
    const { requestApproval } = await import('../hitl');
    return requestApproval({
      action: args.action,
      requestedBy: 'agent',
      details: { reason: args.reason },
    });
  }

  throw new Error(`Herramienta desconocida: ${name}`);
}
