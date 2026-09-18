export type OrderStatus = 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED' | 'CANCELLED';

export function StatusBadge({ status }: { status: OrderStatus | string }) {
  const normalized = String(status).toUpperCase();
  const tone = normalized === 'AWAITING_PAYMENT' ? 'prep' : normalized === 'NEW' ? 'new' : normalized === 'READY' ? 'ready' : ['SERVED', 'COMPLETED'].includes(normalized) ? 'done' : normalized === 'CANCELLED' ? 'cancelled' : 'prep';
  return <span className={`badge badge-${tone}`}>{normalized}</span>;
}
