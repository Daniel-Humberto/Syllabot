import neo4j, { Driver, Session } from 'neo4j-driver';

let driverInstance: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (!driverInstance) {
    driverInstance = neo4j.driver(
      process.env.NEO4J_URI || 'bolt://localhost:7687',
      neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || ''),
      { disableLosslessIntegers: true }
    );
  }
  return driverInstance;
}

export async function runCypher<T = Record<string, unknown>>(
  query: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const session: Session = getNeo4jDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records.map((record) => record.toObject() as T);
  } finally {
    await session.close();
  }
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw new Error(`Identificador de grafo inválido: ${value}`);
  }
  return value;
}

export async function initializeGraph(): Promise<void> {
  await getNeo4jDriver().verifyConnectivity();
  await runCypher('CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE');
  await runCypher('CREATE CONSTRAINT session_id IF NOT EXISTS FOR (s:Session) REQUIRE s.id IS UNIQUE');
  await runCypher('CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name)');
}

export async function createGraphNode(
  label: string,
  id: string,
  properties: Record<string, unknown> = {}
) {
  const validLabel = safeIdentifier(label);
  return runCypher(
    `MERGE (n:Entity:${validLabel} {id: $id}) SET n += $properties, n.updatedAt = datetime() RETURN n`,
    { id, properties }
  );
}

export async function createGraphRelation(
  fromId: string,
  relationType: string,
  toId: string,
  properties: Record<string, unknown> = {}
) {
  const validRelation = safeIdentifier(relationType.toUpperCase());
  return runCypher(
    `MATCH (a:Entity {id: $fromId}), (b:Entity {id: $toId})
     MERGE (a)-[r:${validRelation}]->(b)
     SET r += $properties, r.updatedAt = datetime()
     RETURN a.id AS from, type(r) AS relation, b.id AS to`,
    { fromId, toId, properties }
  );
}

export async function getEntityKnowledgeGraph(entityId: string, ownerId?: string) {
  return runCypher(
    `MATCH (e:Entity {id: $entityId})-[r]-(neighbor:Entity)
     WHERE (e.ownerId IS NULL OR e.ownerId = $ownerId)
       AND (neighbor.ownerId IS NULL OR neighbor.ownerId = $ownerId)
     RETURN e.id AS source, type(r) AS relation, neighbor.id AS targetId,
            neighbor.name AS targetName, neighbor.kind AS targetKind, properties(neighbor) AS details
     LIMIT 25`,
    { entityId, ownerId: ownerId ?? null }
  );
}

export async function searchKnowledgeGraph(queryText: string, limit = 10, ownerId?: string) {
  const terms = queryText.toLowerCase().split(/\s+/).filter((term) => term.length > 2).slice(0, 8);
  if (!terms.length) return [];
  return runCypher(
    `MATCH (n:Entity)
     WHERE (n.ownerId IS NULL OR n.ownerId = $ownerId)
       AND any(term IN $terms WHERE toLower(coalesce(n.name, '') + ' ' + coalesce(n.description, '')) CONTAINS term)
     OPTIONAL MATCH (n)-[r]-(neighbor:Entity)
     WHERE neighbor.ownerId IS NULL OR neighbor.ownerId = $ownerId
     RETURN n.id AS id, n.name AS name, n.kind AS kind,
            collect(DISTINCT {relation: type(r), id: neighbor.id, name: neighbor.name})[0..5] AS connections
     LIMIT $limit`,
    { terms, ownerId: ownerId ?? null, limit: neo4j.int(Math.min(Math.max(limit, 1), 25)) }
  );
}

export async function listOwnedDocuments(ownerId: string, limit = 50) {
  return runCypher<{ id: string; title: string; source: string; updatedAt: string }>(
    `MATCH (d:Entity:Document {ownerId: $ownerId})
     RETURN d.id AS id, d.name AS title, d.source AS source, toString(d.updatedAt) AS updatedAt
     ORDER BY d.updatedAt DESC LIMIT $limit`,
    { ownerId, limit: neo4j.int(Math.min(Math.max(limit, 1), 100)) }
  );
}

export async function saveConversationMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  channel: string,
  userId?: string
) {
  return runCypher(
    `MERGE (s:Session {id: $sessionId})
     ON CREATE SET s.createdAt = datetime(), s.channel = $channel, s.userId = $userId
     SET s.updatedAt = datetime()
     CREATE (m:Message {id: randomUUID(), role: $role, content: $content, createdAt: datetime()})
     MERGE (s)-[:HAS_MESSAGE]->(m)
     RETURN m.id AS id`,
    { sessionId, role, content, channel, userId: userId ?? null }
  );
}

export async function clearConversation(sessionId: string) {
  await runCypher(
    `MATCH (:Session {id: $sessionId})-[:HAS_MESSAGE]->(m:Message) DETACH DELETE m`,
    { sessionId }
  );
}

export async function getConversationHistory(sessionId: string, limit = 12) {
  return runCypher<{ role: 'user' | 'assistant'; content: string }>(
    `MATCH (:Session {id: $sessionId})-[:HAS_MESSAGE]->(m:Message)
     WITH m ORDER BY m.createdAt DESC LIMIT $limit
     RETURN m.role AS role, m.content AS content ORDER BY m.createdAt ASC`,
    { sessionId, limit: neo4j.int(Math.min(Math.max(limit, 1), 30)) }
  );
}

export async function closeNeo4j(): Promise<void> {
  if (driverInstance) await driverInstance.close();
  driverInstance = null;
}
