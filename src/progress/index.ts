import { randomUUID } from 'crypto';
import { createChatCompletion } from '../router';
import { getPostgresPool } from '../tools/postgres';
import { getLearningRoute } from '../routes';

const QUESTION_COUNT = 8;
const OPTIONS_PER_QUESTION = 4;
export const PASSING_SCORE = 80;

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  moduleOrder: number;
  moduleTopic: string;
}

export class ProgressError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

const quizInstructions = `
Eres Evaluador. Con la ruta de aprendizaje recibida crea exactamente ${QUESTION_COUNT} preguntas de opción
múltiple, en el idioma de la ruta, que comprueben comprensión real (no memorizar títulos). Reparte las
preguntas entre los módulos. Cada pregunta tiene ${OPTIONS_PER_QUESTION} opciones plausibles y una sola correcta.
Responde solamente JSON válido:
{"questions":[{"question":string,"options":[string,string,string,string],"correctIndex":0-3,
"explanation":string,"moduleOrder":number}]}
`;

export async function initializeProgress(): Promise<void> {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS route_progress (
      route_id uuid NOT NULL REFERENCES learning_routes(id) ON DELETE CASCADE,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_url text NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (route_id, video_url)
    );
    CREATE TABLE IF NOT EXISTS route_quizzes (
      id uuid PRIMARY KEY,
      route_id uuid NOT NULL REFERENCES learning_routes(id) ON DELETE CASCADE,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      questions jsonb NOT NULL,
      best_score integer,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function requireRoute(routeId: string, ownerId: string) {
  const stored = await getLearningRoute(routeId, ownerId);
  if (!stored) throw new ProgressError('Ruta no encontrada', 404);
  return stored;
}

export async function getRouteProgress(routeId: string, ownerId: string) {
  const [videos, quiz] = await Promise.all([
    getPostgresPool().query('SELECT video_url FROM route_progress WHERE route_id = $1 AND owner_id = $2', [routeId, ownerId]),
    getPostgresPool().query('SELECT max(best_score) AS best FROM route_quizzes WHERE route_id = $1 AND owner_id = $2', [routeId, ownerId]),
  ]);
  const best = quiz.rows[0]?.best;
  return {
    completedVideos: videos.rows.map((row) => row.video_url as string),
    bestQuizScore: best === null || best === undefined ? null : Number(best),
    passingScore: PASSING_SCORE,
  };
}

export async function setVideoCompleted(routeId: string, ownerId: string, videoUrl: unknown, completed: boolean) {
  const stored = await requireRoute(routeId, ownerId);
  const url = typeof videoUrl === 'string' ? videoUrl : '';
  const belongsToRoute = stored.route.modules.some((module) => module.resources.some((resource) => resource.url === url));
  if (!belongsToRoute) throw new ProgressError('El video no pertenece a esta ruta', 400);
  if (completed) {
    await getPostgresPool().query(
      'INSERT INTO route_progress (route_id, owner_id, video_url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [routeId, ownerId, url]
    );
  } else {
    await getPostgresPool().query('DELETE FROM route_progress WHERE route_id = $1 AND owner_id = $2 AND video_url = $3',
      [routeId, ownerId, url]);
  }
  return getRouteProgress(routeId, ownerId);
}

/** Resumen de progreso de todas las rutas del usuario, para inicio y "Mis rutas". */
export async function listProgressSummaries(ownerId: string) {
  const result = await getPostgresPool().query(
    `SELECT r.id,
            (SELECT count(*) FROM jsonb_array_elements(r.route->'modules') m, jsonb_array_elements(m->'resources')) AS total_videos,
            (SELECT count(*) FROM route_progress p WHERE p.route_id = r.id) AS completed_videos,
            (SELECT max(best_score) FROM route_quizzes q WHERE q.route_id = r.id) AS best_quiz_score
     FROM learning_routes r WHERE r.owner_id = $1`,
    [ownerId]
  );
  return new Map(result.rows.map((row) => [row.id as string, {
    totalVideos: Number(row.total_videos),
    completedVideos: Number(row.completed_videos),
    bestQuizScore: row.best_quiz_score === null ? null : Number(row.best_quiz_score),
  }]));
}

function parseJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ProgressError('No se pudo generar la evaluación. Intenta de nuevo.', 502);
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

export function validateQuestions(raw: unknown, modules: Array<{ order: number; topic: string }>): QuizQuestion[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { questions?: unknown }).questions)
    ? (raw as { questions: unknown[] }).questions : [];
  const questions = list.flatMap((item) => {
    const q = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const options = Array.isArray(q.options)
      ? q.options.filter((option): option is string => typeof option === 'string' && option.trim() !== '') : [];
    const correctIndex = Number(q.correctIndex);
    if (typeof q.question !== 'string' || !q.question.trim() || options.length !== OPTIONS_PER_QUESTION) return [];
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= OPTIONS_PER_QUESTION) return [];
    const module = modules.find((m) => m.order === Number(q.moduleOrder)) || modules[0];
    return [{
      question: q.question.trim().slice(0, 500),
      options: options.map((option) => option.trim().slice(0, 300)),
      correctIndex,
      explanation: typeof q.explanation === 'string' ? q.explanation.slice(0, 800) : '',
      moduleOrder: module?.order ?? 1,
      moduleTopic: module?.topic ?? '',
    }];
  }).slice(0, QUESTION_COUNT);
  if (questions.length < 3) throw new ProgressError('No se pudo generar la evaluación. Intenta de nuevo.', 502);
  return questions;
}

export function gradeQuiz(questions: QuizQuestion[], answers: unknown) {
  const given = Array.isArray(answers) ? answers : [];
  const results = questions.map((question, index) => {
    const answer = Number.isInteger(given[index]) ? Number(given[index]) : -1;
    return {
      question: question.question,
      options: question.options,
      answer,
      correctIndex: question.correctIndex,
      correct: answer === question.correctIndex,
      explanation: question.explanation,
      moduleTopic: question.moduleTopic,
    };
  });
  const correct = results.filter((result) => result.correct).length;
  const score = Math.round((correct / questions.length) * 100);
  const missedByModule = new Map<string, number>();
  for (const result of results.filter((item) => !item.correct)) {
    missedByModule.set(result.moduleTopic, (missedByModule.get(result.moduleTopic) || 0) + 1);
  }
  const weakest = [...missedByModule.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    score,
    correct,
    total: questions.length,
    passed: score >= PASSING_SCORE,
    passingScore: PASSING_SCORE,
    recommendation: weakest ? { moduleTopic: weakest[0], missed: weakest[1] } : null,
    results,
  };
}

export async function createRouteQuiz(routeId: string, ownerId: string) {
  const stored = await requireRoute(routeId, ownerId);
  const modules = stored.route.modules.map(({ order, topic, objective, resources }) => ({
    order, topic, objective, videos: resources.map((resource) => resource.title),
  }));
  const completion = await createChatCompletion([
    { role: 'system', content: quizInstructions },
    { role: 'user', content: JSON.stringify({ title: stored.route.title, language: stored.profile.language, modules }) },
  ], { temperature: 0.3 });
  const questions = validateQuestions(parseJson(completion.message.content || ''), modules);
  const id = randomUUID();
  await getPostgresPool().query(
    'INSERT INTO route_quizzes (id, route_id, owner_id, questions) VALUES ($1, $2, $3, $4::jsonb)',
    [id, routeId, ownerId, JSON.stringify(questions)]
  );
  return {
    quizId: id,
    routeTitle: stored.route.title,
    passingScore: PASSING_SCORE,
    questions: questions.map(({ question, options, moduleTopic }) => ({ question, options, moduleTopic })),
  };
}

export async function submitQuiz(quizId: string, ownerId: string, answers: unknown) {
  const result = await getPostgresPool().query(
    'SELECT questions FROM route_quizzes WHERE id = $1 AND owner_id = $2',
    [quizId, ownerId]
  );
  const row = result.rows[0] as { questions: QuizQuestion[] } | undefined;
  if (!row) throw new ProgressError('Evaluación no encontrada', 404);
  const graded = gradeQuiz(row.questions, answers);
  await getPostgresPool().query(
    'UPDATE route_quizzes SET best_score = GREATEST(COALESCE(best_score, 0), $2) WHERE id = $1',
    [quizId, graded.score]
  );
  return graded;
}
