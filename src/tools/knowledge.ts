import { createHash } from 'crypto';
import { createChatCompletion } from '../router';
import { createGraphNode, createGraphRelation } from './neo4j';
import { upsertDocument } from './qdrant';

interface ExtractedEntity {
  name: string;
  kind?: string;
  description?: string;
}

interface ExtractedRelation {
  from: string;
  to: string;
  type?: string;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 20)}`;
}

function chunks(text: string, size = 3500, overlap = 300): string[] {
  if (text.length <= size) return [text];
  const result: string[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    result.push(text.slice(start, start + size));
  }
  return result;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned) as Record<string, unknown>;
}

function relationIdentifier(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^([^A-Z])/, 'R_$1').slice(0, 64);
  return normalized || 'RELATED_TO';
}

export async function ingestKnowledge(input: {
  id?: string;
  title?: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
  ownerId?: string;
}) {
  const ownerScope = input.ownerId ? `${input.ownerId}:` : '';
  const ownership = input.ownerId ? { ownerId: input.ownerId } : {};
  const id = input.id || stableId('doc', `${ownerScope}${input.source || ''}:${input.title || ''}:${input.text}`);
  const documentChunks = chunks(input.text.trim());
  if (!documentChunks[0]) throw new Error('El texto de conocimiento está vacío.');

  const vectorResults = [];
  for (let index = 0; index < documentChunks.length; index += 1) {
    vectorResults.push(await upsertDocument(`${id}:chunk:${index}`, documentChunks[index], {
      documentId: id,
      title: input.title || id,
      source: input.source || 'manual',
      chunk: index,
      totalChunks: documentChunks.length,
      ...input.metadata,
      ...ownership,
    }));
  }

  await createGraphNode('Document', id, {
    name: input.title || id,
    kind: 'Document',
    description: input.text.slice(0, 1000),
    source: input.source || 'manual',
    ...input.metadata,
    ...ownership,
  });

  let entities: ExtractedEntity[] = [];
  let relations: ExtractedRelation[] = [];
  try {
    const extraction = await createChatCompletion([
      {
        role: 'system',
        content: 'Extrae un grafo de conocimiento. Responde exclusivamente JSON válido con {"entities":[{"name":"...","kind":"Person|Organization|Place|Concept|Product|Event","description":"..."}],"relations":[{"from":"nombre exacto","to":"nombre exacto","type":"RELACION"}]}. Máximo 15 entidades y 20 relaciones.',
      },
      { role: 'user', content: input.text.slice(0, 12000) },
    ], { temperature: 0 });
    const parsed = parseJsonObject(extraction.message.content || '{}');
    entities = Array.isArray(parsed.entities) ? parsed.entities.slice(0, 15) as ExtractedEntity[] : [];
    relations = Array.isArray(parsed.relations) ? parsed.relations.slice(0, 20) as ExtractedRelation[] : [];
  } catch (error) {
    console.warn('[Knowledge] La extracción de entidades falló; el documento vectorial sí fue guardado:', error);
  }

  const idsByName = new Map<string, string>();
  for (const entity of entities) {
    if (!entity?.name || typeof entity.name !== 'string') continue;
    const entityId = stableId('entity', `${ownerScope}${entity.name}`);
    idsByName.set(entity.name.toLowerCase(), entityId);
    await createGraphNode('KnowledgeItem', entityId, {
      name: entity.name,
      kind: entity.kind || 'Concept',
      description: entity.description || '',
      ...ownership,
    });
    await createGraphRelation(id, 'MENTIONS', entityId);
  }

  for (const relation of relations) {
    const fromId = idsByName.get(String(relation.from).toLowerCase());
    const toId = idsByName.get(String(relation.to).toLowerCase());
    if (fromId && toId) {
      await createGraphRelation(fromId, relationIdentifier(relation.type || 'RELATED_TO'), toId);
    }
  }

  return {
    id,
    chunks: vectorResults.length,
    entities: idsByName.size,
    relations: relations.length,
  };
}
