import { createHash, randomBytes } from 'crypto';
import { getPostgresPool } from '../tools/postgres';

const LINK_TTL_MINUTES = 10;
const START_COMMAND = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;

export interface LinkedAccount {
  id: string;
  name: string;
}

let cachedBotUsername: string | undefined;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function initializeTelegramLinks(): Promise<void> {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS telegram_link_codes (
      code_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS telegram_accounts (
      telegram_user_id text PRIMARY KEY,
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      username text,
      linked_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function botUsername(): Promise<string> {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME;
  if (cachedBotUsername) return cachedBotUsername;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN no está configurado');
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string } };
  if (!data.ok || !data.result?.username) throw new Error('No se pudo obtener el usuario del bot de Telegram');
  cachedBotUsername = data.result.username;
  return cachedBotUsername;
}

export async function createTelegramLink(userId: string) {
  const code = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_TTL_MINUTES * 60_000);
  const pool = getPostgresPool();
  await pool.query('DELETE FROM telegram_link_codes WHERE user_id = $1 AND consumed_at IS NULL', [userId]);
  await pool.query(
    'INSERT INTO telegram_link_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashCode(code), userId, expiresAt]
  );
  const username = await botUsername();
  return { url: `https://t.me/${username}?start=${code}`, botUsername: username, expiresAt: expiresAt.toISOString() };
}

export function extractLinkCode(text: string): string | null {
  return START_COMMAND.exec(text.trim())?.[1] ?? null;
}

export async function consumeTelegramLink(code: string, telegramUserId: string, username?: string): Promise<LinkedAccount | null> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `UPDATE telegram_link_codes SET consumed_at = now()
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashCode(code)]
    );
    const userId = claimed.rows[0]?.user_id as string | undefined;
    if (!userId) {
      await client.query('ROLLBACK');
      return null;
    }
    // Un Telegram ↔ una cuenta: se reemplazan vínculos previos de cualquiera de los dos lados.
    await client.query('DELETE FROM telegram_accounts WHERE user_id = $1 OR telegram_user_id = $2', [userId, telegramUserId]);
    await client.query(
      'INSERT INTO telegram_accounts (telegram_user_id, user_id, username) VALUES ($1, $2, $3)',
      [telegramUserId, userId, username || null]
    );
    const user = await client.query('SELECT id, name FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    return user.rows[0] as LinkedAccount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findLinkedAccount(telegramUserId: string): Promise<LinkedAccount | null> {
  const result = await getPostgresPool().query(
    `SELECT u.id, u.name FROM telegram_accounts t JOIN users u ON u.id = t.user_id
     WHERE t.telegram_user_id = $1`,
    [telegramUserId]
  );
  return (result.rows[0] as LinkedAccount | undefined) ?? null;
}

export async function getTelegramStatus(userId: string) {
  const result = await getPostgresPool().query(
    'SELECT username, linked_at AS "linkedAt" FROM telegram_accounts WHERE user_id = $1',
    [userId]
  );
  const row = result.rows[0] as { username: string | null; linkedAt: Date } | undefined;
  return row ? { linked: true, username: row.username, linkedAt: row.linkedAt } : { linked: false };
}

export async function unlinkTelegram(userId: string): Promise<void> {
  await getPostgresPool().query('DELETE FROM telegram_accounts WHERE user_id = $1', [userId]);
}
