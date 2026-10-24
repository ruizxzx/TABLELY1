import { Ban, Check, CircleX } from 'lucide-react';

export type OrderStatus = 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED' | 'CANCELLED';

export function StatusBadge({ status }: { status: OrderStatus | string }) {
  const normalized = String(status).toUpperCase();
  const isCancelled = normalized === 'CANCELLED';
  const isCompleted = normalized === 'COMPLETED';
  const isRejected = normalized === 'REJECTED';
  const tone = normalized === 'AWAITING_PAYMENT' ? 'prep' : normalized === 'NEW' ? 'new' : normalized === 'READY' ? 'ready' : ['SERVED', 'COMPLETED'].includes(normalized) ? 'done' : isCancelled ? 'cancelled' : isRejected ? 'rejected' : 'prep';
  const Icon = isCancelled ? CircleX : isCompleted ? Check : isRejected ? Ban : null;
  return (
    <span className={`badge badge-${tone}${isCompleted ? ' badge-completed' : ''}${isRejected ? ' badge-rejected' : ''}${isCancelled ? ' badge-cancelled' : ''}`}>
      {Icon ? <Icon size={12} strokeWidth={2.5} aria-hidden="true" /> : null}
      <span>{normalized}</span>
    </span>
  );
}
