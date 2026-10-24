/**
 * TABLELY stores product/order display prices in major currency units (e.g. INR rupees).
 * Payment providers such as Razorpay expect the smallest currency unit (e.g. paise).
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'RWF', 'XAF', 'XOF']);

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

export function toMinorUnits(amountMajor: number, currency: string): number {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) throw new Error('Invalid monetary amount.');
  const multiplier = 10 ** currencyExponent(currency);
  const minor = Math.round(amountMajor * multiplier);
  if (!Number.isSafeInteger(minor)) throw new Error('Monetary amount is too large.');
  return minor;
}

export function fromMinorUnits(amountMinor: number, currency: string): number {
  if (!Number.isFinite(amountMinor) || amountMinor < 0) throw new Error('Invalid monetary amount.');
  const divisor = 10 ** currencyExponent(currency);
  return amountMinor / divisor;
}
