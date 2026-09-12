import nacl from 'tweetnacl';

const DISCORD_PING_TYPE = 1;

export interface DiscordVerifyInput {
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  publicKey: string;
}

export function verifyDiscordSignature({
  rawBody,
  signature,
  timestamp,
  publicKey,
}: DiscordVerifyInput): boolean {
  if (!signature || !timestamp || !publicKey) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch {
    return false;
  }
}

export function isDiscordPing(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).type === DISCORD_PING_TYPE;
}

export const DISCORD_PONG_RESPONSE = { type: DISCORD_PING_TYPE };
