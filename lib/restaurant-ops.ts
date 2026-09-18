'use client';

import { getSupabaseBrowserClient } from '@/lib/supabase';

export const TABLE_STATES = ['AVAILABLE','OCCUPIED','ORDERING','PREPARING','BILL_REQUESTED','PAYMENT_PENDING','COMPLETED'] as const;
export type TableState = typeof TABLE_STATES[number];
export const ORDER_STATES = ['NEW','ACCEPTED','PREPARING','READY','SERVED','COMPLETED','REJECTED','CANCELLED'] as const;
export type OrderState = typeof ORDER_STATES[number];
export const ITEM_STATES = ['PENDING','PREPARING','READY','SERVED','CANCELLED'] as const;
export type ItemState = typeof ITEM_STATES[number];
export const PRIORITIES = ['NORMAL','HIGH','URGENT'] as const;
export type Priority = typeof PRIORITIES[number];

export const SESSION_ORIGINS = ['STAFF','CUSTOMER_ORDER','CUSTOMER_SCAN','AUTO'] as const;
export type SessionOrigin = typeof SESSION_ORIGINS[number];

/** How a table session came into existence (Build 19.2 semantics). */
export function sessionOriginLabel(origin: string | null | undefined) {
  switch (origin) {
    case 'CUSTOMER_ORDER': return 'Customer order';
    case 'CUSTOMER_SCAN': return 'Legacy QR scan';
    case 'STAFF': return 'Seated by staff';
    case 'AUTO': return 'Auto-created';
    default: return 'Unknown';
  }
}

export function tableStateLabel(state: string | null | undefined) {
  return state === 'BILL_REQUESTED' ? 'BILL REQUESTED' : state === 'PAYMENT_PENDING' ? 'PAYMENT PENDING' : state ?? 'AVAILABLE';
}

export function formatElapsed(iso: string | null | undefined) {
  if (!iso) return '—';
  const elapsed = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2,'0')}m`;
  return `${mins}:${String(secs).padStart(2,'0')}`;
}

export async function rpc<T = unknown>(name: string, args: Record<string, unknown>) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) as T;
}
