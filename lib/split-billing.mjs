/** Convert a decimal currency input to integer paise without float arithmetic. */
export function parseRupeesToPaise(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [rupees, fraction = ''] = text.split('.');
  const paise = Number(rupees) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** Divide integer paise, assigning leftover paise in stable participant order. */
export function equalSplitPaise(totalPaise, count) {
  if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0) throw new Error('Total must be positive integer paise.');
  if (!Number.isSafeInteger(count) || count < 2 || count > 20) throw new Error('Split count must be between 2 and 20.');
  const base = Math.floor(totalPaise / count);
  const remainder = totalPaise % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function allocationsMatchTotal(allocations, totalPaise) {
  return Array.isArray(allocations)
    && allocations.length >= 2
    && allocations.every(amount => Number.isSafeInteger(amount) && amount > 0)
    && allocations.reduce((sum, amount) => sum + amount, 0) === totalPaise;
}
