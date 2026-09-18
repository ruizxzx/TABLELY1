export type ConnectionState = 'CONNECTING' | 'SUBSCRIBED' | 'RECONNECTING' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of current) map.set(row.id, row);
  for (const row of incoming) map.set(row.id, row);
  return Array.from(map.values());
}

export function upsertById<T extends { id: string }>(current: T[], row: T): T[] {
  const index = current.findIndex((item) => item.id === row.id);
  if (index === -1) return [row, ...current];
  const next = current.slice();
  next[index] = { ...next[index], ...row };
  return next;
}

export function replaceById<T extends { id: string }>(current: T[], row: T): T[] {
  const index = current.findIndex((item) => item.id === row.id);
  if (index === -1) return [row, ...current];
  const next = current.slice();
  next[index] = row;
  return next;
}

export function removeById<T extends { id: string }>(current: T[], id: string): T[] {
  return current.filter((item) => item.id !== id);
}

export function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of rows) map.set(row.id, row);
  return Array.from(map.values());
}
