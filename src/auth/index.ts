import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import type { NextFunction, Request, Response } from 'express';
import { getPostgresPool } from '../tools/postgres';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

interface TokenPayload {
  sub: string;
  email: string;
  name: string;
  exp: number;
}

export type AuthenticatedRequest = Request & { user?: PublicUser };

export class AuthError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET || '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres`);
  }
  return secret;
}

export function assertAuthConfigured(): void {
  authSecret();
}

export async function initializeAuth(): Promise<void> {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      name text NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(derived, expected);
}

function sign(data: string): string {
  return createHmac('sha256', authSecret()).update(data).digest('base64url');
}

export function issueToken(user: PublicUser, now = Date.now()): string {
  const payload: TokenPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string, now = Date.now()): PublicUser | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.sub !== 'string' || payload.exp * 1000 <= now) return null;
    return { id: payload.sub, email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

export function validateCredentials(input: { email?: unknown; password?: unknown; name?: unknown }, requireName: boolean) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new AuthError('Correo inválido', 400);
  if (password.length < 8 || password.length > 128) throw new AuthError('La contraseña debe tener entre 8 y 128 caracteres', 400);
  if (requireName && (name.length < 2 || name.length > 80)) throw new AuthError('El nombre debe tener entre 2 y 80 caracteres', 400);
  return { email, password, name };
}

export async function registerUser(input: { email?: unknown; password?: unknown; name?: unknown }) {
  const { email, password, name } = validateCredentials(input, true);
  const user: PublicUser = { id: randomUUID(), email, name };
  try {
    await getPostgresPool().query(
      'INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [user.id, email, name, await hashPassword(password)]
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new AuthError('Ese correo ya está registrado', 409);
    throw error;
  }
  return { user, token: issueToken(user) };
}

export async function loginUser(input: { email?: unknown; password?: unknown }) {
  const { email, password } = validateCredentials(input, false);
  const result = await getPostgresPool().query(
    'SELECT id, email, name, password_hash FROM users WHERE email = $1',
    [email]
  );
  const row = result.rows[0] as (PublicUser & { password_hash: string }) | undefined;
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new AuthError('Correo o contraseña incorrectos', 401);
  }
  const user: PublicUser = { id: row.id, email: row.email, name: row.name };
  return { user, token: issueToken(user) };
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar' });
  (req as AuthenticatedRequest).user = user;
  return next();
}

export function userSessionId(userId: string): string {
  return `web:user:${userId}`;
}
