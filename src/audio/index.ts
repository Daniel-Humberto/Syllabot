import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createChatCompletion } from '../router';
import { getPostgresPool } from '../tools/postgres';

export interface DialogueTurn {
  speaker: 'Alex' | 'Sofía';
  voice: 'echo' | 'nova' | 'alloy' | 'shimmer';
  text: string;
}

export interface PodcastScript {
  title: string;
  summary: string;
  turns: DialogueTurn[];
}

export interface PodcastEpisode {
  id: string;
  title: string;
  topic: string;
  summary: string;
  audioUrl: string;
  filename: string;
  durationSeconds: number;
  turns: DialogueTurn[];
  createdAt: string;
}

export interface VoiceNoteEpisode {
  id: string;
  title: string;
  topic: string;
  audioUrl: string;
  filename: string;
  durationSeconds: number;
  text: string;
  createdAt: string;
}

export const AUDIO_STORAGE_DIR = path.resolve(process.cwd(), 'storage/audio');

export function ensureAudioDirectory(): void {
  if (!fs.existsSync(AUDIO_STORAGE_DIR)) {
    fs.mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });
  }
}

export async function initializePodcastsTable(): Promise<void> {
  try {
    const pool = getPostgresPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS podcasts (
        id uuid PRIMARY KEY,
        owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
        title text NOT NULL,
        topic text NOT NULL,
        summary text NOT NULL DEFAULT '',
        audio_url text NOT NULL,
        filename text NOT NULL,
        duration_seconds integer NOT NULL DEFAULT 0,
        turns jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS podcasts_owner_idx ON podcasts (owner_id, created_at DESC);
    `);
  } catch (error) {
    console.warn('[Audio DB] No se pudo inicializar la tabla podcasts en Postgres:', error);
  }
}

/**
 * Genera el guion conversacional estilo NotebookLM (2 voces: Alex y Sofía).
 */
export async function generatePodcastScript(
  topic: string,
  options: { focus?: string; language?: string; turnsCount?: number } = {}
): Promise<PodcastScript> {
  const language = options.language === 'en' ? 'en' : 'es';
  const turnsCount = Math.min(Math.max(options.turnsCount || 6, 4), 10);
  const focus = options.focus ? `Enfoque específico solicitado: ${options.focus}` : '';

  const systemPrompt = language === 'es'
    ? `Eres el guionista principal de los Audio Overviews de Syllabot (un formato podcast conversacional de 2 voces inspirado en Google NotebookLM).
Tu misión es redactar un diálogo ameno, dinámico y pedagógico entre dos presentadores:
- Alex (Voz masculina 'echo'): El host curioso y entusiasta. Hace preguntas con las que cualquier estudiante se identifica, plantea dudas comunes, busca analogías de la vida real y conecta los puntos.
- Sofía (Voz femenina 'nova'): La experta en tecnología y pedagogía. Explica los conceptos de manera cristalina, comparte la intuición profunda detrás de la arquitectura y da consejos prácticos.

Reglas del diálogo:
1. Sonar completamente natural: usa pausas naturales, pequeñas interjecciones ("¡Exacto!", "Totalmente", "Fíjate que...", "¿Sabes qué es lo más interesante?").
2. No sonar como si estuvieran leyendo una enciclopedia. Debe sentirse como dos ingenieros apasionados tomando un café y explicando el tema.
3. El diálogo debe tener exactamente ${turnsCount} turnos alternados empezando por Alex.
4. Cada turno debe tener entre 2 y 4 oraciones concisas y fáciles de escuchar.
5. Devuelve EXCLUSIVAMENTE JSON válido con esta estructura:
{
  "title": "Título corto y pegajoso del episodio",
  "summary": "Resumen pedagógico del episodio en 2 líneas",
  "turns": [
    { "speaker": "Alex", "voice": "echo", "text": "..." },
    { "speaker": "Sofía", "voice": "nova", "text": "..." }
  ]
}`
    : `You are the lead podcast scriptwriter for Syllabot Audio Overviews (a 2-voice conversational podcast format inspired by Google NotebookLM).
Create an engaging, dynamic dialogue between two hosts:
- Alex (Voice 'echo'): The curious, enthusiastic co-host who asks relatable questions and uses analogies.
- Sofia (Voice 'nova'): The sharp pedagogical expert who explains nuances clearly and shares practical insights.
Return strictly valid JSON with title, summary, and ${turnsCount} alternating turns.`;

  const userPrompt = `Genera un podcast sobre el siguiente tema educativo:
Tema: "${topic}"
${focus}
Idioma: ${language}`;

  const completion = await createChatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { temperature: 0.6 });

  const raw = completion.message.content || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonMatch) {
    throw new Error('No se pudo obtener un guion válido para el podcast.');
  }

  const parsed = JSON.parse(jsonMatch) as {
    title?: string;
    summary?: string;
    turns?: Array<{ speaker?: string; voice?: string; text?: string }>;
  };

  const title = (parsed.title || `Deep Dive: ${topic}`).trim().slice(0, 100);
  const summary = (parsed.summary || `Episodio podcast sobre ${topic}`).trim().slice(0, 500);

  const turns: DialogueTurn[] = Array.isArray(parsed.turns) && parsed.turns.length >= 2
    ? parsed.turns.map((t, idx): DialogueTurn => {
        const isAlex = idx % 2 === 0;
        return {
          speaker: (isAlex ? 'Alex' : 'Sofía') as 'Alex' | 'Sofía',
          voice: (isAlex ? 'echo' : 'nova') as 'echo' | 'nova',
          text: (t.text || '').trim(),
        };
      }).filter((t) => t.text.length > 0)
    : [
        { speaker: 'Alex', voice: 'echo', text: `¡Hola a todos! Hoy en Syllabot nos adentramos en ${topic}. Sofía, ¿por dónde empezamos?` },
        { speaker: 'Sofía', voice: 'nova', text: `Hola Alex. Lo fascinante de ${topic} es cómo resuelve los cuellos de botella habituales mediante principios muy elegantes.` },
        { speaker: 'Alex', voice: 'echo', text: `Muchos estudiantes se sienten abrumados al inicio. ¿Cuál dirías que es la clave mental para entenderlo rápido?` },
        { speaker: 'Sofía', voice: 'nova', text: `Pensarlo paso a paso y experimentar con pequeños ejemplos prácticos. Con eso, todo encaja a la perfección.` },
      ];

  return { title, summary, turns };
}

/**
 * Sintetiza un texto a buffer MP3 mediante la API TTS de OpenAI.
 */
export async function synthesizeSpeech(text: string, voice: string = 'alloy'): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no está configurada para síntesis de audio.');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice,
      input: text,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS falló con HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Crea un episodio completo de podcast (NotebookLM style): genera guion, sintetiza cada voz,
 * concatena el audio MP3 y lo guarda en almacenamiento persistente.
 */
export async function createPodcastEpisode(params: {
  topic: string;
  focus?: string;
  language?: string;
  ownerId?: string;
  turnsCount?: number;
}): Promise<PodcastEpisode> {
  ensureAudioDirectory();
  const script = await generatePodcastScript(params.topic, {
    focus: params.focus,
    language: params.language,
    turnsCount: params.turnsCount,
  });

  // Sintetizar los turnos de diálogo
  const turnBuffers: Buffer[] = [];
  for (const turn of script.turns) {
    const buffer = await synthesizeSpeech(turn.text, turn.voice);
    turnBuffers.push(buffer);
  }

  const combinedAudio = Buffer.concat(turnBuffers);
  const id = randomUUID();
  const filename = `podcast-${id}.mp3`;
  const filePath = path.join(AUDIO_STORAGE_DIR, filename);

  fs.writeFileSync(filePath, combinedAudio);

  // Estimación aproximada: ~130 palabras por minuto
  const totalWords = script.turns.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);
  const durationSeconds = Math.max(Math.round((totalWords / 130) * 60), 15);

  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://syllabot.humbert.uk';
  const audioUrl = `${baseUrl}/audio/${filename}`;

  const episode: PodcastEpisode = {
    id,
    title: script.title,
    topic: params.topic,
    summary: script.summary,
    audioUrl,
    filename,
    durationSeconds,
    turns: script.turns,
    createdAt: new Date().toISOString(),
  };

  // Guardar en Postgres si está disponible
  try {
    const pool = getPostgresPool();
    await pool.query(
      `INSERT INTO podcasts
        (id, owner_id, title, topic, summary, audio_url, filename, duration_seconds, turns, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        episode.id,
        params.ownerId || null,
        episode.title,
        episode.topic,
        episode.summary,
        episode.audioUrl,
        episode.filename,
        episode.durationSeconds,
        JSON.stringify(episode.turns),
        episode.createdAt,
      ]
    );
  } catch (error) {
    console.warn('[Audio DB] No se pudo persistir el podcast en Postgres:', error);
  }

  return episode;
}

/**
 * Crea una nota de voz directa (un solo locutor) para resúmenes ultrarrápidos.
 */
export async function createVoiceNote(params: {
  topic: string;
  text: string;
  voice?: 'alloy' | 'nova' | 'echo' | 'shimmer';
  ownerId?: string;
}): Promise<VoiceNoteEpisode> {
  ensureAudioDirectory();
  const voice = params.voice || 'nova';
  const buffer = await synthesizeSpeech(params.text, voice);

  const id = randomUUID();
  const filename = `voicenote-${id}.mp3`;
  const filePath = path.join(AUDIO_STORAGE_DIR, filename);

  fs.writeFileSync(filePath, buffer);

  const words = params.text.split(/\s+/).length;
  const durationSeconds = Math.max(Math.round((words / 130) * 60), 5);

  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://syllabot.humbert.uk';
  const audioUrl = `${baseUrl}/audio/${filename}`;

  const result: VoiceNoteEpisode = {
    id,
    title: `Nota de voz: ${params.topic}`,
    topic: params.topic,
    audioUrl,
    filename,
    durationSeconds,
    text: params.text,
    createdAt: new Date().toISOString(),
  };

  return result;
}

/**
 * Lista los podcasts generados para un usuario.
 */
export async function listUserPodcasts(ownerId: string): Promise<PodcastEpisode[]> {
  try {
    const pool = getPostgresPool();
    const result = await pool.query(
      `SELECT id, title, topic, summary, audio_url AS "audioUrl", filename,
              duration_seconds AS "durationSeconds", turns, created_at AS "createdAt"
       FROM podcasts
       WHERE owner_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [ownerId]
    );
    return result.rows as PodcastEpisode[];
  } catch (error) {
    console.warn('[Audio DB] Error al listar podcasts de usuario:', error);
    return [];
  }
}
