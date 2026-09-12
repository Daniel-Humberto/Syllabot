import { Pool } from 'pg';

export interface DurableChannelAction {
  id: string;
  channel: 'telegram' | 'discord';
  sessionId: string;
  userId?: string;
  label: string;
  prompt: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  approvalId?: string;
  decision?: 'approved' | 'rejected';
  expiresAt: number;
}

let pool: Pool | undefined;

export function getPostgresPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ||
        (process.env.POSTGRES_PASSWORD
          ? `postgresql://${process.env.POSTGRES_USER || 'syllabot'}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || 'syllabot'}`
          : 'postgresql://syllabot@localhost:5432/syllabot'),
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (error) => console.error('[Postgres Pool]', error));
  }
  return pool;
}

export async function initializePostgres(): Promise<void> {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS channel_actions (
      id text PRIMARY KEY,
      channel text NOT NULL CHECK (channel IN ('telegram', 'discord')),
      session_id text NOT NULL,
      user_id text,
      label text NOT NULL,
      prompt text NOT NULL,
      style text NOT NULL,
      approval_id text,
      decision text CHECK (decision IS NULL OR decision IN ('approved', 'rejected')),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS channel_actions_expiry_idx
      ON channel_actions (expires_at) WHERE consumed_at IS NULL;
    CREATE TABLE IF NOT EXISTS channel_audit_events (
      id bigserial PRIMARY KEY,
      channel text NOT NULL,
      event_type text NOT NULL,
      actor_id text,
      session_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS channel_audit_created_idx ON channel_audit_events (created_at DESC);
  `);
}

export async function saveChannelActions(items: DurableChannelAction[]): Promise<void> {
  if (!items.length) return;
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(
        `INSERT INTO channel_actions
          (id, channel, session_id, user_id, label, prompt, style, approval_id, decision, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0))
         ON CONFLICT (id) DO NOTHING`,
        [item.id, item.channel, item.sessionId, item.userId || null, item.label, item.prompt,
          item.style, item.approvalId || null, item.decision || null, item.expiresAt]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeChannelAction(
  id: string,
  channel: 'telegram' | 'discord',
  userId?: string
): Promise<DurableChannelAction | undefined> {
  const result = await getPostgresPool().query(
    `UPDATE channel_actions
     SET consumed_at = now()
     WHERE id = $1 AND channel = $2 AND consumed_at IS NULL AND expires_at > now()
       AND (user_id IS NULL OR user_id = $3)
     RETURNING id, channel, session_id AS "sessionId", user_id AS "userId", label, prompt,
       style, approval_id AS "approvalId", decision, extract(epoch FROM expires_at) * 1000 AS "expiresAt"`,
    [id, channel, userId || null]
  );
  return result.rows[0] as DurableChannelAction | undefined;
}

export async function recordChannelAudit(event: {
  channel: string;
  eventType: string;
  actorId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getPostgresPool().query(
    `INSERT INTO channel_audit_events (channel, event_type, actor_id, session_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [event.channel, event.eventType, event.actorId || null, event.sessionId || null, JSON.stringify(event.metadata || {})]
  );
}

export async function closePostgres(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}
