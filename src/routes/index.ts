import { randomUUID } from 'crypto';
import { createChatCompletion } from '../router';
import { createGraphNode, createGraphRelation, runCypher } from '../tools/neo4j';
import { getPostgresPool } from '../tools/postgres';
import { curatorInstructions, plannerInstructions } from './prompts';
import { RouteGenerationError } from './errors';
export { RouteGenerationError } from './errors';
import {
  CandidateSearchResult,
  findYoutubeCandidates,
  LearningModule,
  LearningProfile,
  VideoSources,
  YoutubeCandidate,
} from './youtube';

interface LearningPlan { assumptions: string[]; modules: LearningModule[] }
interface CuratedResource {
  title: string; url: string; format: 'video'; estimatedMinutes: number; score: number; reason: string;
}
export interface CuratedRoute {
  title: string;
  summary: string;
  totalEstimatedHours: number;
  modules: Array<LearningModule & { resources: CuratedResource[]; exercise: string }>;
  finalProject: string;
}

export interface GeneratedLearningRoute {
  id: string;
  mode: 'openrouter';
  profile: LearningProfile;
  plan: LearningPlan;
  candidates: CandidateSearchResult;
  route: CuratedRoute;
  createdAt: string;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('El modelo no devolvió JSON válido.');
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), min), max) : fallback;
}

export function normalizeLearningProfile(input: Record<string, unknown>): LearningProfile {
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  if (!goal || goal.length > 300) throw new RouteGenerationError('La meta debe tener entre 1 y 300 caracteres.', 400, 'invalid_goal');
  const level = typeof input.level === 'string' && input.level.trim() ? input.level.trim().slice(0, 50) : 'principiante';
  const language = typeof input.language === 'string' && /^[A-Za-z-]{2,12}$/.test(input.language)
    ? input.language.toLowerCase() : 'es';
  const preferences = Array.isArray(input.preferences)
    ? input.preferences.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 8)
    : [];
  return {
    goal,
    level,
    hoursPerWeek: boundedNumber(input.hoursPerWeek, 5, 1, 40),
    durationWeeks: boundedNumber(input.durationWeeks, 4, 1, 24),
    language,
    preferences,
  };
}

async function askJson(instructions: string, input: unknown): Promise<Record<string, unknown>> {
  const completion = await createChatCompletion([
    { role: 'system', content: instructions },
    { role: 'user', content: JSON.stringify(input) },
  ], { temperature: 0.1 });
  return parseJsonObject(completion.message.content || '');
}

function validatePlan(value: Record<string, unknown>): LearningPlan {
  if (!Array.isArray(value.modules) || value.modules.length < 1 || value.modules.length > 6) {
    throw new Error('El Planeador devolvió una cantidad inválida de módulos.');
  }
  const modules = value.modules.map((raw, index) => {
    const module = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const topic = typeof module.topic === 'string' ? module.topic.trim() : '';
    if (!topic) throw new Error('El Planeador devolvió un módulo sin tema.');
    return {
      order: boundedNumber(module.order, index + 1, 1, 99),
      topic: topic.slice(0, 200),
      objective: typeof module.objective === 'string' ? module.objective.slice(0, 500) : topic,
      estimatedHours: boundedNumber(module.estimatedHours, 2, 1, 100),
      prerequisites: Array.isArray(module.prerequisites)
        ? module.prerequisites.filter((item): item is string => typeof item === 'string').slice(0, 10) : [],
    };
  });
  return {
    assumptions: Array.isArray(value.assumptions)
      ? value.assumptions.filter((item): item is string => typeof item === 'string').slice(0, 10) : [],
    modules,
  };
}

function validateRoute(value: Record<string, unknown>, plan: LearningPlan, candidates: YoutubeCandidate[]): CuratedRoute {
  const modulesInput = Array.isArray(value.modules) ? value.modules : [];
  const modules = plan.modules.map((planned) => {
    const moduleCandidates = candidates.filter((candidate) => candidate.moduleOrder === planned.order);
    const allowedUrls = new Set(moduleCandidates.map((candidate) => candidate.url));
    const raw = modulesInput.find((item) => item && typeof item === 'object'
      && Number((item as Record<string, unknown>).order) === planned.order) as Record<string, unknown> | undefined;
    let resources = Array.isArray(raw?.resources) ? raw.resources.flatMap((item) => {
      const resource = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const url = typeof resource.url === 'string' ? resource.url : '';
      if (!allowedUrls.has(url)) return [];
      const source = candidates.find((candidate) => candidate.url === url)!;
      return [{
        title: typeof resource.title === 'string' ? resource.title.slice(0, 300) : source.title,
        url,
        format: 'video' as const,
        estimatedMinutes: boundedNumber(resource.estimatedMinutes, source.estimatedMinutes, 0, 600),
        score: boundedNumber(resource.score, 75, 0, 100),
        reason: typeof resource.reason === 'string' ? resource.reason.slice(0, 1000) : source.summary,
      }];
    }).slice(0, 2) : [];
    // Los candidatos ya pasaron el filtro de tema e idioma: un módulo nunca debe quedar sin video.
    const bestMatch = [...moduleCandidates].sort((a, b) => b.relevance - a.relevance)[0];
    if (!resources.length && bestMatch) {
      resources = [{
        title: bestMatch.title,
        url: bestMatch.url,
        format: 'video',
        estimatedMinutes: bestMatch.estimatedMinutes,
        score: 60,
        reason: `El título del video coincide con "${planned.topic}".`,
      }];
    }
    return {
      ...planned,
      ...(raw && typeof raw.topic === 'string' ? { topic: raw.topic.slice(0, 200) } : {}),
      ...(raw && typeof raw.objective === 'string' ? { objective: raw.objective.slice(0, 500) } : {}),
      resources,
      exercise: raw && typeof raw.exercise === 'string' ? raw.exercise.slice(0, 1000) : `Practica lo aprendido en ${planned.topic}.`,
    };
  });
  return {
    title: typeof value.title === 'string' ? value.title.slice(0, 300) : `Ruta: ${plan.modules[0]?.topic || 'aprendizaje'}`,
    summary: typeof value.summary === 'string' ? value.summary.slice(0, 1500) : 'Ruta personalizada con videos verificados.',
    totalEstimatedHours: boundedNumber(value.totalEstimatedHours,
      modules.reduce((sum, module) => sum + module.estimatedHours, 0), 1, 1000),
    modules,
    finalProject: typeof value.finalProject === 'string' ? value.finalProject.slice(0, 2000) : 'Aplica lo aprendido en un proyecto final.',
  };
}

export async function initializeLearningRoutes(): Promise<void> {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS learning_routes (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal text NOT NULL,
      profile jsonb NOT NULL,
      plan jsonb NOT NULL,
      candidates jsonb NOT NULL,
      route jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS learning_routes_owner_created_idx
      ON learning_routes (owner_id, created_at DESC);
  `);
}

export async function generateLearningRoute(
  input: Record<string, unknown>,
  ownerId?: string,
  sources?: VideoSources
): Promise<GeneratedLearningRoute> {
  const profile = normalizeLearningProfile(input);
  const plan = validatePlan(await askJson(plannerInstructions, profile));
  const candidates = await findYoutubeCandidates(plan.modules, profile, sources);
  const route = validateRoute(await askJson(curatorInstructions, { profile, plan, candidates }), plan, candidates.candidates);
  const generated: GeneratedLearningRoute = {
    id: randomUUID(), mode: 'openrouter', profile, plan, candidates, route, createdAt: new Date().toISOString(),
  };
  if (ownerId) {
    await getPostgresPool().query(
      `INSERT INTO learning_routes (id, owner_id, goal, profile, plan, candidates, route)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [generated.id, ownerId, profile.goal, JSON.stringify(profile), JSON.stringify(plan), JSON.stringify(candidates), JSON.stringify(route)]
    );
    await createGraphNode('LearningRoute', generated.id, {
      name: route.title, description: route.summary, goal: profile.goal, ownerId, createdAt: generated.createdAt,
    });
    for (const resource of route.modules.flatMap((module) => module.resources)) {
      const videoId = new URL(resource.url).searchParams.get('v');
      if (!videoId) continue;
      const graphId = `youtube-${videoId}`;
      await createGraphNode('Video', graphId, { name: resource.title, url: resource.url, kind: 'Video', ownerId });
      await createGraphRelation(generated.id, 'CONTAINS', graphId, { score: resource.score });
    }
  }
  return generated;
}

export async function listLearningRoutes(ownerId: string) {
  const result = await getPostgresPool().query(
    `SELECT id, goal, route->>'title' AS title, route->>'summary' AS summary,
            route->>'totalEstimatedHours' AS "totalEstimatedHours", created_at AS "createdAt"
     FROM learning_routes WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [ownerId]
  );
  return result.rows;
}

export async function getLearningRoute(id: string, ownerId: string): Promise<GeneratedLearningRoute | null> {
  const result = await getPostgresPool().query(
    `SELECT id, profile, plan, candidates, route, created_at AS "createdAt"
     FROM learning_routes WHERE id = $1 AND owner_id = $2`,
    [id, ownerId]
  );
  const row = result.rows[0] as GeneratedLearningRoute | undefined;
  return row ? { ...row, mode: 'openrouter' } : null;
}

function editableText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new RouteGenerationError(`${field} no puede estar vacío.`, 400, 'invalid_route_update');
  }
  return value.trim().slice(0, maxLength);
}

/** Actualiza los datos editoriales sin alterar módulos, videos ni progreso. */
export async function updateLearningRoute(
  id: string,
  ownerId: string,
  input: Record<string, unknown>
): Promise<GeneratedLearningRoute> {
  const updates = {
    title: editableText(input.title, 'El título', 300),
    summary: editableText(input.summary, 'El resumen', 1500),
    finalProject: editableText(input.finalProject, 'El proyecto final', 2000),
  };
  const patch = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
  if (!Object.keys(patch).length) {
    throw new RouteGenerationError('Envía al menos un cambio para la ruta.', 400, 'empty_route_update');
  }
  const result = await getPostgresPool().query(
    `UPDATE learning_routes
     SET route = route || $3::jsonb, updated_at = now()
     WHERE id = $1 AND owner_id = $2
     RETURNING id`,
    [id, ownerId, JSON.stringify(patch)]
  );
  if (!result.rowCount) throw new RouteGenerationError('Ruta no encontrada.', 404, 'route_not_found');
  const updated = await getLearningRoute(id, ownerId);
  if (!updated) throw new RouteGenerationError('Ruta no encontrada.', 404, 'route_not_found');
  await createGraphNode('LearningRoute', id, {
    name: updated.route.title,
    description: updated.route.summary,
    ownerId,
  }).catch((error) => console.warn('[Route Graph] No se pudo sincronizar la edición:', error));
  return updated;
}

/** Elimina una ruta del usuario; las tablas de progreso y evaluaciones usan ON DELETE CASCADE. */
export async function deleteLearningRoute(id: string, ownerId: string): Promise<boolean> {
  const result = await getPostgresPool().query(
    'DELETE FROM learning_routes WHERE id = $1 AND owner_id = $2 RETURNING id',
    [id, ownerId]
  );
  if (!result.rowCount) return false;
  await runCypher(
    'MATCH (r:Entity:LearningRoute {id: $id, ownerId: $ownerId}) DETACH DELETE r',
    { id, ownerId }
  ).catch((error) => console.warn('[Route Graph] No se pudo retirar la ruta del grafo:', error));
  return true;
}
