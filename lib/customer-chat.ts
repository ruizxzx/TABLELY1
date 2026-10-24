import { createHash } from 'node:crypto';

export function hashCustomerVisitToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isCustomerVisitToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 128;
}
