export type OrderDatePreset = 'today' | '7days' | '30days';

export type OrderDateRange =
  | { preset: OrderDatePreset }
  | { preset: 'custom'; from: string; to: string };

export interface OrderDateBounds {
  from: string;
  toExclusive: string;
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function dateToLocalMidnightIso(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

export function getOrderDateBounds(range: OrderDateRange, now = new Date()): OrderDateBounds | null {
  let start: Date;
  let end: Date;

  if (range.preset === 'custom') {
    const parsedStart = parseLocalDate(range.from);
    const parsedEnd = parseLocalDate(range.to);
    if (!parsedStart || !parsedEnd || parsedStart > parsedEnd) return null;
    start = parsedStart;
    end = parsedEnd;
  } else {
    const days = range.preset === 'today' ? 1 : range.preset === '7days' ? 7 : 30;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1);
    end = today;
  }

  const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  return {
    from: dateToLocalMidnightIso(start),
    toExclusive: endExclusive.toISOString(),
  };
}

export function getLocalDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
