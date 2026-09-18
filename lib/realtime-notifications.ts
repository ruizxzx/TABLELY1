export type OrderNotificationKind =
  | 'NEW'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY'
  | 'SERVED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface OrderNotificationInput {
  kind: OrderNotificationKind;
  orderNumber: number | string | null;
  tableNumber: number | string | null;
}

export interface OrderNotification {
  id: string;
  title: string;
  message: string;
  kind: OrderNotificationKind;
  createdAt: number;
}

function orderLabel(orderNumber: number | string | null) {
  return `#${orderNumber ?? 'order'}`;
}

export function buildOrderNotification(input: OrderNotificationInput): Omit<OrderNotification, 'id' | 'createdAt'> {
  const order = orderLabel(input.orderNumber);
  const table = input.tableNumber == null ? 'Table —' : `Table ${input.tableNumber}`;

  switch (input.kind) {
    case 'NEW':
      return { kind: input.kind, title: 'New order', message: `${order} received from ${table}.`, };
    case 'ACCEPTED':
      return { kind: input.kind, title: 'Order accepted', message: `${order} accepted by manager. Start preparing ${table}.`, };
    case 'PREPARING':
      return { kind: input.kind, title: 'Order preparing', message: `${order} is now being prepared for ${table}.`, };
    case 'READY':
      return { kind: input.kind, title: 'Order ready', message: `${order} is ready for ${table}.`, };
    case 'SERVED':
      return { kind: input.kind, title: 'Order served', message: `${order} has been served at ${table}.`, };
    case 'COMPLETED':
      return { kind: input.kind, title: 'Order completed', message: `${order} is completed for ${table}.`, };
    case 'CANCELLED':
      return { kind: input.kind, title: 'Order cancelled', message: `${order} was cancelled for ${table}.`, };
  }
}

export async function requestBrowserNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showBrowserOrderNotification(notification: Pick<OrderNotification, 'title' | 'message'>) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(`Tablely · ${notification.title}`, {
      body: notification.message,
      tag: `tablely-${notification.title}-${notification.message}`,
    });
  } catch {
    // Browser notifications can fail silently depending on platform permissions.
  }
}
