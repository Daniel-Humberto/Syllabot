import { QdrantClient } from '@qdrant/js-client-rest';
import { getEmbedding } from './embeddings';

// Instancia del cliente Qdrant
// En Docker usa http://qdrant:6333; localmente http://localhost:6333
const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
export const qdrantClient = new QdrantClient({
  url: qdrantUrl,
  ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  checkCompatibility: false,
});

export const DEFAULT_COLLECTION = 'sylabot_knowledge';
export const VECTOR_SIZE = 1536; // Coincide con text-embedding-3-small de OpenRouter

/**
 * Asegura que una colección exista en Qdrant con métrica Cosine.
 */
export async function ensureCollection(
  collectionName: string = DEFAULT_COLLECTION,
  size: number = VECTOR_SIZE
) {
  try {
    const { exists } = await qdrantClient.collectionExists(collectionName);

    if (!exists) {
      console.log(`[Qdrant] Creando colección "${collectionName}" (dim: ${size}, distance: Cosine)...`);
      await qdrantClient.createCollection(collectionName, {
        vectors: {
          size,
          distance: 'Cosine',
        },
      });
      console.log(`[Qdrant] Colección "${collectionName}" creada exitosamente.`);
    }
    return true;
  } catch (error) {
    console.error(`[Qdrant Error] Falló al verificar o crear colección:`, error);
    throw error;
  }
}

import { randomUUID, createHash } from 'crypto';

function formatPointId(id: string | number): string | number {
  if (typeof id === 'number') return id;
  // Si ya es un UUID válido
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(id)) return id;
  // Si es un número en string
  if (/^\d+$/.test(id)) return parseInt(id, 10);
  // Convertir string arbitrario en UUID determinista (MD5 hash formateado como UUID)
  const hash = createHash('md5').update(id).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Inserta o actualiza un documento vectorizado en Qdrant.
 */
export async function upsertDocument(
  id: string | number,
  text: string,
  payload: Record<string, unknown> = {},
  collectionName: string = DEFAULT_COLLECTION
) {
  await ensureCollection(collectionName);

  const pointId = formatPointId(id);
  console.log(`[Qdrant] Generando embedding con OpenRouter para id="${id}" (pointId="${pointId}")...`);
  const vector = await getEmbedding(text);

  await qdrantClient.upsert(collectionName, {
    wait: true,
    points: [
      {
        id: pointId,
        vector,
        payload: {
          originalId: id,
          text,
          ...payload,
          updatedAt: new Date().toISOString(),
        },
      },
    ],
  });

  return { success: true, id: pointId, originalId: id, collectionName };
}

/**
 * Busca documentos similares usando búsqueda semántica vectorial.
 */
export async function searchSimilarDocuments(
  queryText: string,
  limit: number = 5,
  collectionName: string = DEFAULT_COLLECTION,
  ownerId?: string
) {
  await ensureCollection(collectionName);

  const queryVector = await getEmbedding(queryText);

  // Cada usuario ve sus documentos privados más el conocimiento compartido (sin ownerId).
  const visibility = ownerId
    ? { should: [{ key: 'ownerId', match: { value: ownerId } }, { is_empty: { key: 'ownerId' } }] }
    : { must: [{ is_empty: { key: 'ownerId' } }] };

  const response = await qdrantClient.query(collectionName, {
    query: queryVector,
    limit,
    with_payload: true,
    filter: visibility,
  });

  return (response.points || []).map((hit) => ({
    id: hit.id,
    score: hit.score,
    payload: hit.payload,
  }));
}
