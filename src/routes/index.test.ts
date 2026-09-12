import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLearningRoute, normalizeLearningProfile } from './index';
import { extractYoutubeVideoId, findYoutubeCandidates, parseViewCount, scoreRelevance, VideoSearchResult, VideoSources } from './youtube';

test('normaliza y limita el perfil de aprendizaje', () => {
  const profile = normalizeLearningProfile({
    goal: ' Aprender SQL ', hoursPerWeek: 500, durationWeeks: 0, language: 'ES',
    preferences: ['videos', 1, 'práctica'],
  });
  assert.equal(profile.goal, 'Aprender SQL');
  assert.equal(profile.hoursPerWeek, 40);
  assert.equal(profile.durationWeeks, 1);
  assert.equal(profile.language, 'es');
  assert.deepEqual(profile.preferences, ['videos', 'práctica']);
});

test('extrae IDs únicamente de URLs válidas de YouTube', () => {
  assert.equal(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});

const sqlModule = { order: 1, topic: 'Consultas SELECT', objective: 'Consultar datos', estimatedHours: 4, prerequisites: [] };
const sqlProfile = { goal: 'Aprender SQL desde cero', level: 'principiante', hoursPerWeek: 5, durationWeeks: 4, language: 'es', preferences: [] };

function fakeSources(results: VideoSearchResult[], transcript: string | null = 'SELECT permite consultar datos.'): VideoSources & { searches: string[] } {
  const searches: string[] = [];
  return {
    searches,
    async searchVideos(query) { searches.push(query); return results; },
    async fetchTranscript() { return transcript ? { language: 'es', isGenerated: false, text: transcript } : null; },
  };
}

const video = (videoId: string, title: string, description = '', viewCount = 50_000): VideoSearchResult => ({
  videoId, title, description, channel: 'Canal', durationSeconds: 900, viewCount, verifiedChannel: false,
});

test('prefiere videos populares y descarta los de nicho con muy pocas vistas', async () => {
  const result = await findYoutubeCandidates([sqlModule], sqlProfile, fakeSources([
    video('aaaaaaaaaaa', 'Consultas SELECT en SQL', '', 2),
    video('bbbbbbbbbbb', 'SQL SELECT: consultas básicas', '', 350_000),
    video('ccccccccccc', 'Consultas SQL SELECT paso a paso', '', 12_000),
  ]));
  assert.deepEqual(result.candidates.map((candidate) => candidate.videoId), ['bbbbbbbbbbb', 'ccccccccccc']);
});

test('usa videos con pocas vistas solo si no hay alternativa relevante', async () => {
  const result = await findYoutubeCandidates([sqlModule], sqlProfile,
    fakeSources([video('aaaaaaaaaaa', 'Consultas SELECT en SQL', '', 3)]));
  assert.deepEqual(result.candidates.map((candidate) => candidate.videoId), ['aaaaaaaaaaa']);
});

test('en módulos genéricos no acepta videos que solo mencionan el tema en la descripción', async () => {
  const finalModule = { ...sqlModule, topic: 'Práctica y Proyecto Final', objective: 'Aplicar lo aprendido' };
  const sources: VideoSources = {
    async searchVideos(query) {
      return query.includes('proyecto práctico')
        ? [video('aaaaaaaaaaa', 'Elige la mejor herramienta de gestión de proyectos', 'también sirve para sql'),
          video('bbbbbbbbbbb', 'Proyecto práctico con SQL')]
        : [];
    },
    async fetchTranscript() { return null; },
  };
  const result = await findYoutubeCandidates([finalModule], sqlProfile, sources);
  assert.deepEqual(result.candidates.map((candidate) => candidate.videoId), ['bbbbbbbbbbb']);
});

test('parseViewCount entiende formatos de YouTube', () => {
  assert.equal(parseViewCount('11.248 visualizaciones'), 11248);
  assert.equal(parseViewCount('1,234,567 views'), 1234567);
  assert.equal(parseViewCount('Sin visualizaciones'), 0);
  assert.equal(parseViewCount(undefined), -1);
});

test('descarta videos que no tratan del tema aunque aparezcan en la búsqueda', async () => {
  const sources = fakeSources([
    video('aaaaaaaaaaa', 'Receta de tacos al pastor'),
    video('bbbbbbbbbbb', 'Curso de SQL: SELECT, WHERE y JOIN'),
    video('ccccccccccc', 'Top 10 goles del mundial'),
  ]);
  const result = await findYoutubeCandidates([sqlModule], sqlProfile, sources);
  assert.deepEqual(result.candidates.map((candidate) => candidate.videoId), ['bbbbbbbbbbb']);
  assert.equal(result.rejectedAsIrrelevant, 2);
  assert.equal(sources.searches[0], 'sql Consultas SELECT');
});

test('falla con mensaje claro si ningún video es relevante', async () => {
  await assert.rejects(
    findYoutubeCandidates([sqlModule], sqlProfile, fakeSources([video('aaaaaaaaaaa', 'Receta de tacos')])),
    /No encontré videos relacionados/
  );
});

test('mantiene videos relevantes aunque YouTube bloquee los subtítulos', async () => {
  const result = await findYoutubeCandidates([sqlModule], sqlProfile,
    fakeSources([video('bbbbbbbbbbb', 'SQL para principiantes')], null));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.transcriptAvailable, false);
  assert.equal(result.withoutTranscript, 1);
});

test('scoreRelevance ignora acentos y palabras de relleno del objetivo', () => {
  const module = { ...sqlModule, topic: 'Programación orientada a objetos' };
  assert.equal(scoreRelevance({ title: 'Python: programacion orientada a objetos', description: '' }, module, 'Aprender Python').relevant, true);
  assert.equal(scoreRelevance({ title: 'Curso completo para principiantes', description: '' }, module, 'Aprender Python').relevant, false);
});

test('no repite el mismo video en dos módulos de la ruta', async () => {
  const joinModule = { ...sqlModule, order: 2, topic: 'Uniones JOIN', objective: 'Combinar tablas' };
  const result = await findYoutubeCandidates([sqlModule, joinModule], sqlProfile, fakeSources([
    video('aaaaaaaaaaa', 'SQL: SELECT y JOIN explicado'),
    video('bbbbbbbbbbb', 'SQL JOIN entre tablas'),
    video('ccccccccccc', 'SQL SELECT paso a paso en español'),
  ]));
  const ids = result.candidates.map((candidate) => candidate.videoId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(result.candidates.filter((c) => c.moduleOrder === 2).map((c) => c.videoId), ['bbbbbbbbbbb']);
});

test('prefiere videos del tema del módulo sobre los que solo mencionan el objetivo', async () => {
  const lightingModule = { ...sqlModule, topic: 'Iluminación natural', objective: 'Aprovechar la luz' };
  const profile = { ...sqlProfile, goal: 'fotografía con celular' };
  const result = await findYoutubeCandidates([lightingModule], profile, fakeSources([
    video('aaaaaaaaaaa', 'Fotografía con celular de miniaturas Warhammer'),
    video('bbbbbbbbbbb', 'Iluminación natural para fotografía con celular'),
  ]));
  assert.deepEqual(result.candidates.map((candidate) => candidate.videoId), ['bbbbbbbbbbb']);
});

test('descarta videos en portugués o inglés cuando la ruta es en español', async () => {
  const result = await findYoutubeCandidates([sqlModule], sqlProfile, fakeSources([
    video('aaaaaaaaaaa', 'Aprenda SQL SELECT passo a passo'),
    video('bbbbbbbbbbb', 'How SQL SELECT actually works'),
    video('ccccccccccc', 'Consultas SELECT en SQL'),
  ]));
  assert.deepEqual(result.candidates.map((candidate) => candidate.videoId), ['ccccccccccc']);
});

test('conecta Planeador, búsqueda de YouTube, subtítulos y Curador', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  let modelCall = 0;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const sources = fakeSources([video('dQw4w9WgXcQ', 'Curso SQL', 'Curso práctico')]);
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    modelCall += 1;
    const content = modelCall === 1
      ? { assumptions: [], modules: [{ order: 1, topic: 'SQL', objective: 'Consultar datos', estimatedHours: 4, prerequisites: [] }] }
      : { title: 'Ruta SQL', summary: 'Aprende SQL', totalEstimatedHours: 4, modules: [{
        order: 1, topic: 'SQL', objective: 'Consultar datos', estimatedHours: 4,
        resources: [{ title: 'Curso SQL', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'video', estimatedMinutes: 30, score: 90, reason: 'Explica SELECT.' }],
        exercise: 'Escribe una consulta.',
      }], finalProject: 'Analiza una tabla.' };
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] }), { status: 200 });
  };
  try {
    const result = await generateLearningRoute({ goal: 'Aprender SQL' }, undefined, sources);
    assert.equal(result.route.modules[0]?.resources.length, 1);
    assert.equal(requests.filter((url) => url.includes('openrouter.ai')).length, 2);
    assert.equal(sources.searches.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
  }
});
