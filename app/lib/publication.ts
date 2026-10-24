export function isPublishedNow(value: unknown, now = Date.now()) {
  if (!value) return true;
  const timestamp = Date.parse(String(value));
  return !Number.isFinite(timestamp) || timestamp <= now;
}
