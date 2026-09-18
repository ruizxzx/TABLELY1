'use client';

import { X } from 'lucide-react';
import type { OrderNotification } from '@/lib/realtime-notifications';

interface Props {
  notifications: OrderNotification[];
  onDismiss: (id: string) => void;
}

export function RealtimeNotificationStack({ notifications, onDismiss }: Props) {
  if (!notifications.length) return null;
  return (
    <div className="realtime-notification-stack" aria-live="polite" aria-atomic="false">
      {notifications.map((notification) => (
        <div className="realtime-notification" key={notification.id} role="status">
          <div className="realtime-notification-icon">●</div>
          <div className="realtime-notification-copy">
            <strong>{notification.title}</strong>
            <span>{notification.message}</span>
          </div>
          <button className="realtime-notification-close" aria-label="Dismiss notification" onClick={() => onDismiss(notification.id)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
