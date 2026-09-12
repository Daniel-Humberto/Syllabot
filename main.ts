import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { runAgent } from './src/agent';
import {
  AuthError,
  AuthenticatedRequest,
  assertAuthConfigured,
  initializeAuth,
  loginUser,
  registerUser,
  requireUser,
  userSessionId,
} from './src/auth';
import { createTelegramLink, getTelegramStatus, initializeTelegramLinks, unlinkTelegram } from './src/auth/telegram-link';
import { handleIncomingWebhook, initializeChannelInterfaces } from './src/channels';
import { decideApproval, listApprovals, requestApproval } from './src/hitl';
import {
  deleteLearningRoute,
  generateLearningRoute,
  getLearningRoute,
  initializeLearningRoutes,
  listLearningRoutes,
  RouteGenerationError,
  updateLearningRoute,
} from './src/routes';
import {
  PASSING_SCORE,
  ProgressError,
  createRouteQuiz,
  getRouteProgress,
  initializeProgress,
  listProgressSummaries,
  setVideoCompleted,
  submitQuiz,
} from './src/progress';
import {
  clearConversation,
  runCypher,
  closeNeo4j,
  closePostgres,
  getConversationHistory,
  listOwnedDocuments,
  getNeo4jDriver,
  getPostgresPool,
  ingestKnowledge,
  initializeGraph,
  initializePostgres,
  qdrantClient,
} from './src/tools';
import fs from 'fs';
import path from 'path';
import {
  AUDIO_STORAGE_DIR,
  createPodcastEpisode,
  createVoiceNote,
  initializePodcastsTable,
  listUserPodcasts,
} from './src/audio';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const allowedOrigins = new Set([
  process.env.PUBLIC_BASE_URL || 'https://syllabot.humbert.uk',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
]);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
}));
app.use(express.json({
  limit: '1mb',
  verify(req, _res, buffer) {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

const requests = new Map<string, { count: number; resetAt: number }>();
function rateLimit(limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const state = requests.get(key);
    const current = !state || state.resetAt <= now ? { count: 0, resetAt: now + windowMs } : state;
    current.count += 1;
    requests.set(key, current);
    if (current.count > limit) return res.status(429).json({ error: 'Demasiadas solicitudes' });
    return next();
  };
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_API_KEY;
  const provided = req.header('x-admin-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected) return res.status(503).json({ error: 'ADMIN_API_KEY no está configurada' });
  if (provided !== expected) return res.status(401).json({ error: 'No autorizado' });
  return next();
}

app.get('/health', async (_req: Request, res: Response) => {
  const dependencies: Record<string, string> = {
    qdrant: 'down',
    neo4j: 'down',
    postgres: 'down',
    searxng: 'down',
    transcripts: 'down',
    openrouter: process.env.OPENROUTER_API_KEY ? 'configured' : 'missing',
  };
  const searxngUrl = process.env.SEARXNG_URL || 'http://localhost:8080';
  const transcriptUrl = process.env.TRANSCRIPT_SERVICE_URL || 'http://localhost:8000';
  await Promise.all([
    qdrantClient.getCollections().then(() => { dependencies.qdrant = 'up'; }).catch(() => undefined),
    getNeo4jDriver().verifyConnectivity().then(() => { dependencies.neo4j = 'up'; }).catch(() => undefined),
    getPostgresPool().query('SELECT 1').then(() => { dependencies.postgres = 'up'; }).catch(() => undefined),
    fetch(`${searxngUrl}/healthz`, { signal: AbortSignal.timeout(3000) })
      .then((r) => { if (r.ok) dependencies.searxng = 'up'; })
      .catch(() => undefined),
    fetch(`${transcriptUrl}/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => { if (r.ok) dependencies.transcripts = 'up'; })
      .catch(() => undefined),
  ]);
  const ok = dependencies.qdrant === 'up' && dependencies.neo4j === 'up'
    && dependencies.postgres === 'up' && dependencies.transcripts === 'up'
    && dependencies.openrouter === 'configured';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    service: 'syllabot',
    dependencies,
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Syllabot API',
    status: 'online',
    endpoints: ['GET /health', 'POST /chat', 'POST /routes/generate', 'GET /me/routes', 'POST /knowledge', 'POST /webhook/:channel'],
  });
});

app.post('/auth/register', rateLimit(10, 60_000), async (req, res, next) => {
  try {
    return res.status(201).json(await registerUser(req.body || {}));
  } catch (error) {
    return next(error);
  }
});

app.post('/auth/login', rateLimit(10, 60_000), async (req, res, next) => {
  try {
    return res.json(await loginUser(req.body || {}));
  } catch (error) {
    return next(error);
  }
});

app.get('/auth/me', requireUser, (req, res) => {
  res.json({ user: (req as AuthenticatedRequest).user });
});

app.delete('/auth/me', requireUser, rateLimit(5, 60_000), async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    await clearConversation(userSessionId(user.id));
    await runCypher('MATCH (n:Entity {ownerId: $ownerId}) DETACH DELETE n', { ownerId: user.id });
    await getPostgresPool().query('DELETE FROM users WHERE id = $1', [user.id]);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.post('/chat', requireUser, rateLimit(30, 60_000), async (req, res, next) => {
  try {
    if (typeof req.body?.message !== 'string') return res.status(400).json({ error: 'message debe ser texto' });
    const user = (req as AuthenticatedRequest).user!;
    const result = await runAgent(req.body.message, {
      channel: 'web',
      sessionId: userSessionId(user.id),
      userId: user.id,
      ownerId: user.id,
      userName: user.name,
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get('/me/history', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    return res.json({ messages: await getConversationHistory(userSessionId(user.id), 30) });
  } catch (error) {
    return next(error);
  }
});

app.delete('/me/history', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    await clearConversation(userSessionId(user.id));
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.post('/routes/generate', requireUser, rateLimit(5, 60_000), async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    return res.status(201).json(await generateLearningRoute(req.body || {}, user.id));
  } catch (error) {
    return next(error);
  }
});

app.get('/me/routes', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const [routes, progress] = await Promise.all([listLearningRoutes(user.id), listProgressSummaries(user.id)]);
    return res.json({
      routes: routes.map((route) => ({
        ...route,
        progress: progress.get(route.id) || { totalVideos: 0, completedVideos: 0, bestQuizScore: null },
      })),
      passingScore: PASSING_SCORE,
    });
  } catch (error) {
    return next(error);
  }
});

const routeIdParam = (req: Request) => (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);

app.get('/me/routes/:id', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const route = await getLearningRoute(routeIdParam(req), user.id);
    if (!route) return res.status(404).json({ error: 'Ruta no encontrada' });
    return res.json({ ...route, progress: await getRouteProgress(route.id, user.id) });
  } catch (error) {
    return next(error);
  }
});

app.patch('/me/routes/:id', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    return res.json(await updateLearningRoute(routeIdParam(req), user.id, req.body || {}));
  } catch (error) {
    return next(error);
  }
});

app.delete('/me/routes/:id', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const deleted = await deleteLearningRoute(routeIdParam(req), user.id);
    return deleted ? res.status(204).end() : res.status(404).json({ error: 'Ruta no encontrada' });
  } catch (error) {
    return next(error);
  }
});

app.put('/me/routes/:id/progress', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    return res.json(await setVideoCompleted(routeIdParam(req), user.id, req.body?.videoUrl, req.body?.completed !== false));
  } catch (error) {
    return next(error);
  }
});

app.post('/me/routes/:id/quiz', requireUser, rateLimit(6, 60_000), async (req, res, next) => {
  try {
    return res.status(201).json(await createRouteQuiz(routeIdParam(req), (req as AuthenticatedRequest).user!.id));
  } catch (error) {
    return next(error);
  }
});

app.post('/me/quizzes/:id/submit', requireUser, async (req, res, next) => {
  try {
    return res.json(await submitQuiz(routeIdParam(req), (req as AuthenticatedRequest).user!.id, req.body?.answers));
  } catch (error) {
    return next(error);
  }
});

app.get('/me/telegram', requireUser, async (req, res, next) => {
  try {
    return res.json(await getTelegramStatus((req as AuthenticatedRequest).user!.id));
  } catch (error) {
    return next(error);
  }
});

app.post('/me/telegram/link', requireUser, rateLimit(10, 60_000), async (req, res, next) => {
  try {
    return res.status(201).json(await createTelegramLink((req as AuthenticatedRequest).user!.id));
  } catch (error) {
    return next(error);
  }
});

app.delete('/me/telegram', requireUser, async (req, res, next) => {
  try {
    await unlinkTelegram((req as AuthenticatedRequest).user!.id);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.get('/me/knowledge', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    return res.json({ documents: await listOwnedDocuments(user.id) });
  } catch (error) {
    return next(error);
  }
});

app.post('/me/knowledge', requireUser, rateLimit(10, 60_000), async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 50_000) return res.status(400).json({ error: 'text debe tener entre 1 y 50,000 caracteres' });
    const user = (req as AuthenticatedRequest).user!;
    const result = await ingestKnowledge({
      title: typeof req.body.title === 'string' ? req.body.title.slice(0, 200) : undefined,
      text,
      source: 'user-upload',
      ownerId: user.id,
    });
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/knowledge', requireAdmin, async (req, res, next) => {
  try {
    if (typeof req.body?.text !== 'string') return res.status(400).json({ error: 'text debe ser texto' });
    const result = await ingestKnowledge({
      id: typeof req.body.id === 'string' ? req.body.id : undefined,
      title: typeof req.body.title === 'string' ? req.body.title : undefined,
      text: req.body.text,
      source: typeof req.body.source === 'string' ? req.body.source : undefined,
      metadata: req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : undefined,
    });
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

app.get('/approvals', requireAdmin, async (req, res, next) => {
  try {
    return res.json({ approvals: await listApprovals(typeof req.query.status === 'string' ? req.query.status : undefined) });
  } catch (error) {
    return next(error);
  }
});

app.post('/approvals', requireAdmin, async (req, res, next) => {
  try {
    if (typeof req.body?.action !== 'string' || typeof req.body?.requestedBy !== 'string') {
      return res.status(400).json({ error: 'action y requestedBy son requeridos' });
    }
    return res.status(201).json(await requestApproval({
      action: req.body.action,
      requestedBy: req.body.requestedBy,
      details: req.body.details && typeof req.body.details === 'object' ? req.body.details : {},
    }));
  } catch (error) {
    return next(error);
  }
});

app.post('/approvals/:id/decision', requireAdmin, async (req, res, next) => {
  try {
    if (req.body?.decision !== 'approved' && req.body?.decision !== 'rejected') {
      return res.status(400).json({ error: 'decision debe ser approved o rejected' });
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    return res.json(await decideApproval(id, req.body.decision, String(req.body.decidedBy || 'admin')));
  } catch (error) {
    return next(error);
  }
});

// --- Endpoints de Audio Podcasting y Voz (NotebookLM Style) ---

app.get('/audio/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(AUDIO_STORAGE_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio no encontrado' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/mpeg',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.post('/audio/podcast', requireUser, rateLimit(5, 60_000), async (req, res, next) => {
  try {
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    if (!topic) return res.status(400).json({ error: 'topic es requerido' });
    const user = (req as AuthenticatedRequest).user!;
    const episode = await createPodcastEpisode({
      topic,
      focus: typeof req.body.focus === 'string' ? req.body.focus : undefined,
      language: typeof req.body.language === 'string' ? req.body.language : 'es',
      ownerId: user.id,
      turnsCount: typeof req.body.turnsCount === 'number' ? req.body.turnsCount : undefined,
    });
    return res.status(201).json(episode);
  } catch (error) {
    return next(error);
  }
});

app.post('/audio/voicenote', requireUser, rateLimit(10, 60_000), async (req, res, next) => {
  try {
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!topic || !text) return res.status(400).json({ error: 'topic y text son requeridos' });
    const user = (req as AuthenticatedRequest).user!;
    const note = await createVoiceNote({
      topic,
      text,
      voice: req.body.voice,
      ownerId: user.id,
    });
    return res.status(201).json(note);
  } catch (error) {
    return next(error);
  }
});

app.get('/me/podcasts', requireUser, async (req, res, next) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    return res.json({ podcasts: await listUserPodcasts(user.id) });
  } catch (error) {
    return next(error);
  }
});

app.post('/webhook/:channel', rateLimit(120, 60_000), async (req, res, next) => {
  try {
    const channel = Array.isArray(req.params.channel) ? req.params.channel[0] : req.params.channel;
    const result = await handleIncomingWebhook(
      channel,
      req.body,
      req.headers,
      (req as Request & { rawBody?: Buffer }).rawBody || Buffer.from('')
    );
    return res.status(result.statusCode).json(result.response);
  } catch (error) {
    return next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof AuthError || error instanceof RouteGenerationError || error instanceof ProgressError) {
    return res.status(error.statusCode).json({ error: error.message, code: error instanceof RouteGenerationError ? error.code : undefined });
  }
  console.error('[API Error]', error);
  const message = error instanceof Error ? error.message : 'Error desconocido';
  const safeMessage = process.env.NODE_ENV === 'production' ? 'No se pudo completar la solicitud' : message;
  res.status(500).json({ error: safeMessage });
});

let server: ReturnType<typeof app.listen>;
async function start() {
  assertAuthConfigured();
  await Promise.all([initializeGraph(), initializePostgres()]);
  await initializeAuth();
  await initializeTelegramLinks();
  await initializeLearningRoutes();
  await initializeProgress();
  await initializePodcastsTable();
  await initializeChannelInterfaces();
  server = app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Syllabot activo en :${PORT}`));
}

async function shutdown(signal: string) {
  console.log(`[Server] ${signal}: cerrando...`);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([closeNeo4j(), closePostgres()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start().catch((error) => {
  console.error('[Startup Error]', error);
  process.exit(1);
});

export default app;
