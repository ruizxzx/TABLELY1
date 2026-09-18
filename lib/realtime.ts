'use client';

import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { ConnectionState } from './live-ops';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export function toLiveStatus(state: ConnectionState | string): LiveStatus {
  if (state === 'SUBSCRIBED') return 'live';
  if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') return 'offline';
  return 'reconnecting';
}

export function cleanupChannel(supabase: SupabaseClient | null, channel: RealtimeChannel | null) {
  if (supabase && channel) void supabase.removeChannel(channel);
}
