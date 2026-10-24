import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function getEncryptionKey(): Buffer {
  const raw = process.env.SELLORA_PAYMENT_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error('Payment credential encryption is not configured. Add SELLORA_PAYMENT_ENCRYPTION_KEY to the server environment.');
  }

  // Accept either a 64-character hex key or a base64-encoded 32-byte key.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;

  throw new Error('SELLORA_PAYMENT_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters or base64.');
}

export function encryptPaymentSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptPaymentSecret(value: string): string {
  const [version, ivHex, tagHex, ciphertextHex] = String(value || '').split(':');
  if (version !== VERSION || !ivHex || !tagHex || !ciphertextHex) {
    throw new Error('Stored payment credential has an invalid encryption format.');
  }
  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
}

export function fingerprintPaymentSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
