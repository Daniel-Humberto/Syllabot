import { RouteGenerationError } from './errors';

const SEARCH_RESULTS_PER_MODULE = 10;
const TRANSCRIPTS_TO_TRY_PER_MODULE = 6;
const TARGET_VIDEOS_PER_MODULE = 2;
const MODULE_CONCURRENCY = 2;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const STOP_WORDS = new Set([
  'a', 'al', 'aprender', 'basico', 'basicos', 'curso', 'de', 'desde', 'el', 'en', 'fundamentos',
  'guia', 'la', 'las', 'lo', 'los', 'para', 'principiante', 'principiantes', 'tutorial', 'un', 'una', 'y',
  'cero', 'learn', 'learning', 'beginner', 'beginners', 'basics', 'guide', 'the', 'for', 'from', 'with',
]);

export interface LearningModule {
  order: number;
  topic: string;
  objective: string;
  estimatedHours: number;
  prerequisites: string[];
}

export interface LearningProfile {
  goal: string;
  level: string;
  hoursPerWeek: number;
  durationWeeks: number;
  language: string;
  preferences: string[];
}

export interface VideoSearchResult {
  videoId: string;
  title: string;
  description: string;
  channel: string;
  durationSeconds: number;
  /** Visualizaciones reportadas por YouTube; -1 si la fuente no las informa. */
  viewCount: number;
  verifiedChannel: boolean;
}

const MIN_VIEWS = 1_000;
const VIEWS_FOR_FULL_POPULARITY = 1_000_000;

export function parseViewCount(text: string | undefined): number {
  if (!text) return -1;
  const digits = text.replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

/** Popularidad 0–100 en escala logarítmica: 1K ≈ 50, 1M = 100; canal verificado suma 10. */
export function popularityScore(video: Pick<VideoSearchResult, 'viewCount' | 'verifiedChannel'>): number {
  if (video.viewCount < 0) return 30;
  const scaled = (Math.log10(video.viewCount + 1) / Math.log10(VIEWS_FOR_FULL_POPULARITY)) * 100;
  return Math.min(100, Math.round(scaled + (video.verifiedChannel ? 10 : 0)));
}

export interface TranscriptResult {
  language: string;
  isGenerated: boolean;
  text: string;
  segments?: Array<{ text: string; start?: number; duration?: number }>;
}

export interface VideoSources {
  searchVideos(query: string, language?: string): Promise<VideoSearchResult[]>;
  fetchTranscript(videoId: string, language: string): Promise<TranscriptResult | null>;
}

export interface YoutubeCandidate {
  videoId: string;
  moduleOrder: number;
  title: string;
  url: string;
  source: 'YouTube';
  channel: string;
  format: 'video';
  estimatedMinutes: number;
  language: string;
  summary: string;
  sourceAuthority: 'community';
  transcriptExcerpt: string;
  transcriptAvailable: boolean;
  isGeneratedTranscript: boolean;
  verification: 'transcript' | 'metadata';
  viewCount: number;
  verifiedChannel: boolean;
  relevance: number;
}

export interface CandidateSearchResult {
  candidates: YoutubeCandidate[];
  withoutTranscript: number;
  rejectedWithoutTranscript: number;
  rejectedAsIrrelevant: number;
  verifiedCount: number;
  metadataFallbackCount: number;
}

interface TranscriptResponse extends TranscriptResult { videoId: string }

class TranscriptError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

interface InnertubeClient {
  search(query: string, filters: { type: string }): Promise<{ results: Iterable<unknown> }>;
}

const transcriptCache = new Map<string, TranscriptResponse>();
const innertubeClients = new Map<string, Promise<InnertubeClient>>();
const SEARCH_POOL_SIZE = 20;
const RANKED_PER_MODULE = 8;
const REGION_BY_LANGUAGE: Record<string, string> = { es: 'MX', en: 'US', pt: 'BR' };

function baseUrl(variable: 'SEARXNG_URL' | 'TRANSCRIPT_SERVICE_URL', fallback: string): string {
  return (process.env[variable] || fallback).replace(/\/$/, '');
}

function normalizedTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+#.]+/g, ' ').split(/\s+/)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

export interface RelevanceScore {
  relevant: boolean;
  /** Menciona el objetivo y además el tema propio del módulo. */
  onTopic: boolean;
  /** Menciona todos los términos del objetivo (útil cuando no hay nada más específico). */
  coversGoal: boolean;
  score: number;
}

export function scoreRelevance(
  video: Pick<VideoSearchResult, 'title' | 'description'>,
  module: LearningModule,
  goal: string
): RelevanceScore {
  const haystack = new Set(normalizedTerms(`${video.title} ${video.description}`));
  const goalTerms = normalizedTerms(goal);
  const topicTerms = normalizedTerms(module.topic).filter((term) => !goalTerms.includes(term));
  const moduleTerms = normalizedTerms(`${module.topic} ${module.objective}`);
  const goalMatches = goalTerms.filter((term) => haystack.has(term)).length;
  const topicMatches = topicTerms.filter((term) => haystack.has(term)).length;
  const moduleMatches = moduleTerms.filter((term) => haystack.has(term)).length;
  const goalRatio = goalTerms.length ? goalMatches / goalTerms.length : 0;
  const moduleRatio = moduleTerms.length ? moduleMatches / moduleTerms.length : 0;
  const score = Math.round(Math.min(100, goalRatio * 60 + moduleRatio * 40));
  const enoughModuleContext = moduleMatches >= Math.max(1, Math.ceil(moduleTerms.length * 0.35));
  return {
    relevant: goalMatches > 0 || enoughModuleContext,
    onTopic: goalMatches > 0 && (topicTerms.length === 0 || topicMatches > 0),
    coversGoal: goalTerms.length > 0 && goalMatches === goalTerms.length,
    score,
  };
}

// Palabras exclusivas del portugués y del inglés que delatan un video en otro idioma.
const FOREIGN_MARKERS: Record<string, Set<string>> = {
  es: new Set([
    'voce', 'voces', 'nao', 'suas', 'seus', 'pelo', 'pela', 'aprenda', 'passo', 'edicao', 'tambem', 'muito',
    'iniciantes', 'entao', 'fazer', 'aula', 'aulas', 'isso', 'agora', 'melhor', 'como fazer',
    'how', 'what', 'why', 'your', 'you', 'this', 'that', 'everything', 'need', 'know', 'actually', 'works', 'once',
  ]),
};

export function looksForeign(video: Pick<VideoSearchResult, 'title' | 'description'>, language: string): boolean {
  const markers = FOREIGN_MARKERS[language.split('-')[0]];
  if (!markers) return false;
  const words = video.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/);
  return words.filter((word) => markers.has(word)).length >= 1;
}

export function extractYoutubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    let id: string | null = null;
    if (hostname === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || null;
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      id = url.searchParams.get('v');
      if (!id && /^\/(shorts|embed|live)\//.test(url.pathname)) {
        id = url.pathname.split('/').filter(Boolean)[1] || null;
      }
    }
    return id && VIDEO_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function searchWithSearxng(query: string, language: string): Promise<VideoSearchResult[]> {
  const url = new URL('/search', baseUrl('SEARXNG_URL', 'http://localhost:8080'));
  url.searchParams.set('q', `${query} tutorial site:youtube.com/watch`);
  url.searchParams.set('categories', 'videos');
  url.searchParams.set('language', language);
  url.searchParams.set('format', 'json');
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Syllabot-Route-Curator/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SearXNG respondió HTTP ${response.status}`);
  const data = await response.json() as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results || []).flatMap((result) => {
    const videoId = extractYoutubeVideoId(result.url || '');
    return videoId ? [{
      videoId,
      title: result.title || `Video: ${query}`,
      description: result.content || '',
      channel: 'YouTube',
      durationSeconds: 0,
      viewCount: -1,
      verifiedChannel: false,
    }] : [];
  });
}

async function getInnertube(language: string): Promise<InnertubeClient> {
  const lang = language.split('-')[0] || 'es';
  let client = innertubeClients.get(lang);
  if (!client) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{
      Innertube: { create(options: Record<string, unknown>): Promise<unknown> };
      Log?: { setLevel(level: number): void; Level: { NONE: number } };
    }>;
    client = dynamicImport('youtubei.js')
      .then(({ Innertube, Log }) => {
        Log?.setLevel(Log.Level.NONE);
        return Innertube.create({ lang, location: REGION_BY_LANGUAGE[lang] || 'US', retrieve_player: false });
      })
      .then((created) => created as InnertubeClient)
      .catch((error) => {
        innertubeClients.delete(lang);
        throw error;
      });
    innertubeClients.set(lang, client);
  }
  return client;
}

async function searchWithInnertube(query: string, language: string): Promise<VideoSearchResult[]> {
  const client = await getInnertube(language);
  const search = await client.search(query, { type: 'video' });
  return Array.from(search.results).flatMap((value) => {
    const node = value as {
      video_id?: string;
      title?: { toString(): string };
      description?: string;
      description_snippet?: { toString(): string };
      author?: { name?: string; is_verified?: boolean; is_verified_artist?: boolean };
      duration?: { seconds?: number };
      view_count?: { toString(): string };
    };
    if (!node.video_id || !VIDEO_ID_PATTERN.test(node.video_id)) return [];
    return [{
      videoId: node.video_id,
      title: node.title?.toString() || `Video: ${query}`,
      description: node.description_snippet?.toString() || node.description || '',
      channel: node.author?.name || 'YouTube',
      durationSeconds: Number(node.duration?.seconds || 0),
      viewCount: parseViewCount(node.view_count?.toString()),
      verifiedChannel: Boolean(node.author?.is_verified || node.author?.is_verified_artist),
    }];
  });
}

async function searchVideos(query: string, language = 'es'): Promise<VideoSearchResult[]> {
  const [searx, direct] = await Promise.allSettled([
    searchWithSearxng(query, language),
    searchWithInnertube(query, language),
  ]);
  if (searx.status === 'rejected') {
    console.warn('[Route Curator] SearXNG no disponible:', searx.reason instanceof Error ? searx.reason.message : searx.reason);
  }
  if (direct.status === 'rejected') {
    console.warn('[Route Curator] YouTube directo no disponible:', direct.reason instanceof Error ? direct.reason.message : direct.reason);
  }
  // YouTube directo va primero: SearXNG llega con ruido y antes desplazaba a los buenos resultados.
  const combined = [
    ...(direct.status === 'fulfilled' ? direct.value : []),
    ...(searx.status === 'fulfilled' ? searx.value : []),
  ];
  const unique = new Map<string, VideoSearchResult>();
  for (const result of combined) if (!unique.has(result.videoId)) unique.set(result.videoId, result);
  return [...unique.values()].slice(0, SEARCH_POOL_SIZE);
}

async function fetchTranscript(videoId: string, language: string): Promise<TranscriptResponse | null> {
  const cacheKey = `${videoId}:${language}`;
  const cached = transcriptCache.get(cacheKey);
  if (cached) return cached;
  const url = new URL('/transcript', baseUrl('TRANSCRIPT_SERVICE_URL', 'http://localhost:8000'));
  url.searchParams.set('videoId', videoId);
  url.searchParams.set('languages', `${language},en`);
  let lastError: TranscriptError | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const transcript = await response.json() as TranscriptResponse;
        if (!transcript.text?.trim()) throw new TranscriptError('La transcripción está vacía', 502, 'empty_transcript');
        transcriptCache.set(cacheKey, transcript);
        return transcript;
      }
      const body = await response.json().catch(() => ({})) as {
        detail?: string | { code?: string; message?: string };
      };
      const detail = body.detail;
      const code = typeof detail === 'object' ? detail.code || 'transcript_error' : 'transcript_error';
      const message = typeof detail === 'object' ? detail.message || 'Transcripción no disponible'
        : typeof detail === 'string' ? detail : 'Transcripción no disponible';
      lastError = new TranscriptError(message, response.status, code);
      if (response.status < 500 && response.status !== 429) return null;
    } catch (error) {
      lastError = error instanceof TranscriptError
        ? error : new TranscriptError(error instanceof Error ? error.message : 'Fallo de red', 502, 'network_error');
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  console.warn(`[Route Curator] Servicio de subtítulos temporalmente no disponible (${lastError?.code || 'unknown'})`);
  return null;
}

const defaultSources: VideoSources = { searchVideos, fetchTranscript };

function excerpt(text: string, limit = 3600): string {
  if (text.length <= limit) return text;
  const third = Math.floor(limit / 3);
  const middle = Math.floor(text.length / 2);
  return `${text.slice(0, third)}\n[…]\n${text.slice(middle - Math.floor(third / 2), middle + Math.ceil(third / 2))}\n[…]\n${text.slice(-third)}`;
}

function toCandidate(
  module: LearningModule,
  result: VideoSearchResult,
  relevance: number,
  transcript: TranscriptResult | null
): YoutubeCandidate {
  const lastSegment = transcript?.segments?.at(-1);
  const durationSeconds = lastSegment
    ? Number(lastSegment.start || 0) + Number(lastSegment.duration || 0)
    : result.durationSeconds;
  return {
    videoId: result.videoId,
    moduleOrder: module.order,
    title: result.title,
    url: `https://www.youtube.com/watch?v=${result.videoId}`,
    source: 'YouTube',
    channel: result.channel,
    format: 'video',
    estimatedMinutes: durationSeconds ? Math.max(1, Math.ceil(durationSeconds / 60)) : 0,
    language: transcript?.language || 'unknown',
    summary: result.description || `Video encontrado para ${module.topic}.`,
    sourceAuthority: 'community',
    transcriptExcerpt: transcript ? excerpt(transcript.text) : '',
    transcriptAvailable: Boolean(transcript),
    isGeneratedTranscript: transcript?.isGenerated || false,
    verification: transcript ? 'transcript' : 'metadata',
    viewCount: result.viewCount,
    verifiedChannel: result.verifiedChannel,
    relevance,
  };
}

function focusedQuery(profile: LearningProfile, module: LearningModule): string {
  const goalTerms = normalizedTerms(profile.goal).slice(0, 5).join(' ');
  return `${goalTerms || profile.goal} ${module.topic}`.trim();
}

interface RankedVideo { video: VideoSearchResult; score: number }

async function rankModuleVideos(
  module: LearningModule,
  profile: LearningProfile,
  sources: VideoSources
): Promise<{ ranked: RankedVideo[]; rejectedAsIrrelevant: number }> {
  const rank = (results: VideoSearchResult[]) => {
    const scored = results.map((video) => ({ video, ...scoreRelevance(video, module, profile.goal) }))
      .filter((item) => !looksForeign(item.video, profile.language));
    // Primero los que tratan el tema del módulo; si no hay, los que cubren el objetivo completo.
    const onTopic = scored.filter((item) => item.onTopic);
    const relevant = onTopic.length ? onTopic : scored.filter((item) => item.coversGoal);
    // Descarta videos de nicho (<1K vistas) si hay alternativas populares del mismo tema.
    const popular = relevant.filter((item) => item.video.viewCount < 0 || item.video.viewCount >= MIN_VIEWS);
    return (popular.length ? popular : relevant)
      .map((item) => ({ ...item, score: Math.round(item.score * 0.55 + popularityScore(item.video) * 0.45) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, RANKED_PER_MODULE);
  };
  const results = await sources.searchVideos(focusedQuery(profile, module), profile.language);
  let eligible = rank(results);
  if (!eligible.length) {
    // Módulos genéricos ("Proyecto final") no aparecen por su nombre: se busca por el objetivo.
    const goalTerms = normalizedTerms(profile.goal);
    const fallback = await sources.searchVideos(`${profile.goal} proyecto práctico`, profile.language);
    // Sin un tema propio que confirme la relación, el título debe nombrar el objetivo (no basta la descripción).
    eligible = rank(fallback.filter((video) => normalizedTerms(video.title).some((term) => goalTerms.includes(term))));
  }
  const scored = results;
  return {
    ranked: eligible.map(({ video, score }) => ({ video, score })),
    rejectedAsIrrelevant: scored.length - eligible.length,
  };
}

export async function findYoutubeCandidates(
  modules: LearningModule[],
  profile: LearningProfile,
  sources: VideoSources = defaultSources
): Promise<CandidateSearchResult> {
  const rankings = await mapLimit(modules, MODULE_CONCURRENCY, (module) => rankModuleVideos(module, profile, sources));

  // Asignación global en orden de módulos para que un mismo video no se repita en la ruta.
  const usedVideoIds = new Set<string>();
  const assignments = modules.flatMap((module, index) => {
    const picks = rankings[index].ranked.filter(({ video }) => !usedVideoIds.has(video.videoId))
      .slice(0, TARGET_VIDEOS_PER_MODULE);
    picks.forEach(({ video }) => usedVideoIds.add(video.videoId));
    return picks.map((pick) => ({ module, ...pick }));
  });

  const candidates = await mapLimit(assignments, TRANSCRIPTS_TO_TRY_PER_MODULE, async ({ module, video, score }) => {
    const transcript = await sources.fetchTranscript(video.videoId, profile.language).catch(() => null);
    return toCandidate(module, video, score, transcript);
  });
  if (!candidates.length) {
    throw new RouteGenerationError(
      'No encontré videos relacionados con el tema. Intenta describir la meta con palabras más específicas.',
      422,
      'no_relevant_videos'
    );
  }
  const withoutTranscript = candidates.filter((candidate) => !candidate.transcriptAvailable).length;
  return {
    candidates,
    withoutTranscript,
    rejectedWithoutTranscript: withoutTranscript,
    rejectedAsIrrelevant: rankings.reduce((sum, ranking) => sum + ranking.rejectedAsIrrelevant, 0),
    verifiedCount: candidates.length - withoutTranscript,
    metadataFallbackCount: withoutTranscript,
  };
}
