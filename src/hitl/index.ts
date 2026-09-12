import { randomUUID } from 'crypto';
import { runCypher } from '../tools/neo4j';

export interface ApprovalRequest {
  id?: string;
  action: string;
  requestedBy: string;
  details: Record<string, unknown>;
}

export async function requestApproval(request: ApprovalRequest) {
  const id = request.id || randomUUID();
  await runCypher(
    `CREATE (a:Approval {
       id: $id, action: $action, requestedBy: $requestedBy,
       details: $details, status: 'pending', createdAt: datetime()
     }) RETURN a.id AS id`,
    { ...request, id, details: JSON.stringify(request.details) }
  );
  return { status: 'pending', approvalId: id };
}

export async function listApprovals(status?: string) {
  return runCypher(
    `MATCH (a:Approval)
     WHERE $status IS NULL OR a.status = $status
     RETURN a.id AS id, a.action AS action, a.requestedBy AS requestedBy,
            a.details AS details, a.status AS status, toString(a.createdAt) AS createdAt,
            toString(a.decidedAt) AS decidedAt
     ORDER BY a.createdAt DESC LIMIT 100`,
    { status: status || null }
  );
}

export async function decideApproval(id: string, decision: 'approved' | 'rejected', decidedBy: string) {
  const rows = await runCypher(
    `MATCH (a:Approval {id: $id, status: 'pending'})
     SET a.status = $decision, a.decidedAt = datetime(), a.decidedBy = $decidedBy
     RETURN a.id AS id, a.status AS status`,
    { id, decision, decidedBy }
  );
  if (!rows.length) throw new Error('Aprobación no encontrada o ya resuelta.');
  return rows[0];
}
