import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError, hashPassword, issueToken, validateCredentials, verifyPassword, verifyToken } from './index';

process.env.AUTH_SECRET = 'test-secret-with-at-least-thirty-two-chars';
const user = { id: 'u-1', email: 'ana@example.com', name: 'Ana' };

test('hashPassword produces a verifiable, salted hash', async () => {
  const first = await hashPassword('correct horse');
  const second = await hashPassword('correct horse');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
});

test('verifyToken accepts a valid token and returns the user', () => {
  assert.deepEqual(verifyToken(issueToken(user)), user);
});

test('verifyToken rejects a tampered payload', () => {
  const [, signature] = issueToken(user).split('.');
  const forged = Buffer.from(JSON.stringify({ ...user, sub: 'u-2', exp: 9_999_999_999 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${signature}`), null);
});

test('verifyToken rejects an expired token', () => {
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  assert.equal(verifyToken(issueToken(user, eightDaysAgo)), null);
});

test('validateCredentials rejects short passwords and bad emails', () => {
  assert.throws(() => validateCredentials({ email: 'ana@example.com', password: 'short' }, false), AuthError);
  assert.throws(() => validateCredentials({ email: 'not-an-email', password: 'long enough' }, false), AuthError);
  assert.deepEqual(
    validateCredentials({ email: ' Ana@Example.com ', password: 'long enough', name: ' Ana ' }, true),
    { email: 'ana@example.com', password: 'long enough', name: 'Ana' }
  );
});
