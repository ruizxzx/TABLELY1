import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key() {
  const source = process.env.TABLELY_PARTNER_ENCRYPTION_KEY ?? process.env.TABLELY_ENCRYPTION_KEY;
  if (!source || source.length < 24) throw new Error('Set TABLELY_PARTNER_ENCRYPTION_KEY to encrypt partner payout details.');
  return createHash('sha256').update(source).digest();
}

export function encryptPartnerPayoutDetails(value: Record<string, string>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptPartnerPayoutDetails(value: string) {
  const [version, ivPart, tagPart, ciphertextPart] = value.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart) throw new Error('Unsupported payout detail encryption format.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64url')), decipher.final()]).toString('utf8');
  return JSON.parse(clear) as Record<string, string>;
}
