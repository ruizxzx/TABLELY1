import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

function secret() {
  const value = process.env.SELLORA_ACCESS_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error('SELLORA_ACCESS_SECRET is not configured.');
  return value;
}

function sign(payload: string) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createOrderAccessToken(orderId: string, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${orderId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyOrderAccessToken(token: string, orderId: string) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== orderId) return false;
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(`${parts[0]}.${parts[1]}`);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function orderAccessUrl(orderId: string, token: string) {
  return `/order/${encodeURIComponent(orderId)}?token=${encodeURIComponent(token)}`;
}
