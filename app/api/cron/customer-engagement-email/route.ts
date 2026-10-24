import { createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';

const BATCH_LIMIT = 25;
const MAX_ATTEMPTS = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAuthorized(request: Request) {
  const secret = (process.env.CRON_SECRET || process.env.SELLORA_CRON_SECRET || '').trim();
  return Boolean(secret) && request.headers.get('authorization') === `${['Bear', 'er '].join('')}${secret}`;
}

function getSiteOrigin() {
  const configured = (process.env.APP_URL || process.env.NEXT_PUBLIC_SITE_URL || '').trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function markUnavailable(db: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, jobId: string, invitationId: string | null) {
  const now = new Date().toISOString();
  const { error } = await db.from('restaurant_notification_queue').update({
    status: 'CANCELLED',
    error_code: 'feedback_email_not_eligible',
    next_attempt_at: now,
    updated_at: now,
  }).eq('id', jobId).eq('status', 'SENDING');
  if (error) throw error;
  if (invitationId) {
    const { error: invitationError } = await db.from('restaurant_feedback_invitations')
      .update({ status: 'CANCELLED' })
      .eq('id', invitationId)
      .eq('status', 'QUEUED');
    if (invitationError) throw invitationError;
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Server configuration is unavailable.' }, { status: 503 });

  const resendKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  const origin = getSiteOrigin();
  if (!resendKey || !from || !origin) {
    return NextResponse.json({ error: 'Configure RESEND_API_KEY, RESEND_FROM_EMAIL, and APP_URL (or NEXT_PUBLIC_SITE_URL).' }, { status: 503 });
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const { data: staleJobs, error: staleError } = await db.from('restaurant_notification_queue')
    .select('id,attempts,payload')
    .eq('channel', 'EMAIL')
    .eq('event_key', 'FEEDBACK_REQUEST')
    .eq('status', 'SENDING')
    .lt('updated_at', staleBefore)
    .limit(BATCH_LIMIT);
  if (staleError) {
    console.error('[cron/customer-engagement-email] Could not load stale jobs:', staleError.message);
    return NextResponse.json({ error: 'Could not recover pending email jobs.' }, { status: 500 });
  }
  for (const stale of staleJobs ?? []) {
    const terminal = stale.attempts >= MAX_ATTEMPTS;
    const { error } = await db.from('restaurant_notification_queue')
      .update({ status: 'FAILED', error_code: 'delivery_worker_timeout', next_attempt_at: terminal ? staleBefore : now.toISOString(), updated_at: now.toISOString() })
      .eq('id', stale.id)
      .eq('status', 'SENDING')
      .eq('attempts', stale.attempts);
    if (error) {
      console.error('[cron/customer-engagement-email] Could not recover stale job:', error.message);
      return NextResponse.json({ error: 'Could not recover pending email jobs.' }, { status: 500 });
    }
    if (terminal && typeof stale.payload?.feedbackUrl === 'string') {
      const invitationId = stale.payload.feedbackUrl.split('/').at(-1) ?? '';
      if (UUID_PATTERN.test(invitationId)) {
        const { error: invitationError } = await db.from('restaurant_feedback_invitations')
          .update({ status: 'FAILED' }).eq('id', invitationId).eq('status', 'QUEUED');
        if (invitationError) {
          console.error('[cron/customer-engagement-email] Could not fail stale invitation:', invitationError.message);
          return NextResponse.json({ error: 'Could not recover pending email invitations.' }, { status: 500 });
        }
      }
    }
  }

  const { data: jobs, error: jobsError } = await db.from('restaurant_notification_queue')
    .select('id,organization_id,branch_id,order_id,status,attempts,payload')
    .eq('channel', 'EMAIL')
    .eq('event_key', 'FEEDBACK_REQUEST')
    .in('status', ['QUEUED', 'FAILED'])
    .lt('attempts', MAX_ATTEMPTS)
    .lte('next_attempt_at', now.toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH_LIMIT);
  if (jobsError) {
    console.error('[cron/customer-engagement-email] Could not load jobs:', jobsError.message);
    return NextResponse.json({ error: 'Could not load pending email jobs.' }, { status: 500 });
  }

  let sent = 0;
  let failed = 0;
  let cancelled = 0;
  for (const job of jobs ?? []) {
    const nextAttempt = job.attempts + 1;
    const { data: claimed, error: claimError } = await db.from('restaurant_notification_queue')
      .update({ status: 'SENDING', attempts: nextAttempt, updated_at: new Date().toISOString(), error_code: null })
      .eq('id', job.id)
      .eq('status', job.status)
      .eq('attempts', job.attempts)
      .select('id')
      .maybeSingle();
    if (claimError) {
      console.error('[cron/customer-engagement-email] Could not claim a job:', claimError.message);
      failed += 1;
      continue;
    }
    if (!claimed) continue;

    const feedbackUrl = typeof job.payload?.feedbackUrl === 'string' ? job.payload.feedbackUrl : '';
    const invitationId = feedbackUrl.split('/').at(-1) ?? '';
    const orderId = job.order_id;
    if (!UUID_PATTERN.test(invitationId) || !orderId) {
      const { error } = await db.from('restaurant_notification_queue').update({
        status: 'FAILED',
        error_code: 'invalid_feedback_invitation',
        next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', job.id).eq('status', 'SENDING');
      if (error) console.error('[cron/customer-engagement-email] Could not fail invalid job:', error.message);
      failed += 1;
      continue;
    }

    const [{ data: order, error: orderError }, { data: settings, error: settingsError }, { data: invitation, error: invitationError }] = await Promise.all([
      db.from('orders').select('id,customer_profile_id,customer_phone,status,payment_status').eq('id', orderId).eq('branch_id', job.branch_id).maybeSingle(),
      db.from('restaurant_feedback_settings').select('enabled,channel').eq('organization_id', job.organization_id).maybeSingle(),
      db.from('restaurant_feedback_invitations').select('id,status,order_id,branch_id').eq('id', invitationId).eq('order_id', orderId).eq('organization_id', job.organization_id).eq('branch_id', job.branch_id).maybeSingle(),
    ]);
    if (orderError || settingsError || invitationError) {
      console.error('[cron/customer-engagement-email] Could not verify a job:', orderError?.message ?? settingsError?.message ?? invitationError?.message);
      failed += 1;
      continue;
    }

    const phone = order?.customer_phone?.replace(/\D/g, '').slice(-10) ?? null;
    let preferenceQuery = db.from('restaurant_customer_preferences')
      .select('email,feedback_email,feedback_email_consent_at,feedback_email_withdrawn_at,feedback_email_consent_version')
      .eq('organization_id', job.organization_id);
    preferenceQuery = order?.customer_profile_id
      ? preferenceQuery.eq('customer_id', order.customer_profile_id)
      : phone ? preferenceQuery.eq('phone', phone) : preferenceQuery.eq('id', '00000000-0000-0000-0000-000000000000');
    const { data: preference, error: preferenceError } = await preferenceQuery
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (preferenceError) {
      console.error('[cron/customer-engagement-email] Could not verify customer consent:', preferenceError.message);
      failed += 1;
      continue;
    }

    const eligible = order?.status === 'COMPLETED'
      && order.payment_status === 'PAID'
      && settings?.enabled === true
      && settings.channel === 'EMAIL'
      && invitation?.status === 'QUEUED'
      && preference?.feedback_email === true
      && Boolean(preference.feedback_email_consent_at)
      && !preference.feedback_email_withdrawn_at
      && Boolean(preference.feedback_email_consent_version)
      && Boolean(preference.email);
    if (!eligible || !invitation || !preference?.email) {
      try {
        await markUnavailable(db, job.id, invitationId);
      } catch (error) {
        console.error('[cron/customer-engagement-email] Could not cancel an ineligible job:', error);
        return NextResponse.json({ error: 'Could not cancel an ineligible email job.' }, { status: 500 });
      }
      cancelled += 1;
      continue;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `${['Bear', 'er '].join('')}${resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [preference.email],
        subject: 'How was your recent visit?',
        text: `Share your private feedback with the restaurant: ${origin}/feedback/${invitation.id}\n\nYour feedback is private. You can also choose to visit the restaurant's Google review page; the choice is voluntary and shown to every customer.\n\nStop future private feedback email invitations: ${origin}/api/customer-engagement/email-unsubscribe?invitationId=${invitation.id}&token=${createHmac('sha256', (process.env.CRON_SECRET || process.env.SELLORA_CRON_SECRET || '').trim()).update(invitation.id).digest('hex')}`,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      console.error('[cron/customer-engagement-email] Resend request failed:', error instanceof Error ? error.message : 'network error');
      return null;
    });
    if (!response?.ok) {
      const terminal = nextAttempt >= MAX_ATTEMPTS;
      const retryMinutes = Math.min(60, 2 ** nextAttempt);
      const { error } = await db.from('restaurant_notification_queue').update({
        status: 'FAILED',
        error_code: response ? `resend_http_${response.status}` : 'resend_network_error',
        next_attempt_at: terminal ? new Date().toISOString() : new Date(Date.now() + retryMinutes * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', job.id).eq('status', 'SENDING');
      if (error) {
        console.error('[cron/customer-engagement-email] Could not record delivery failure:', error.message);
        return NextResponse.json({ error: 'Could not record email delivery failure.' }, { status: 500 });
      }
      if (terminal) {
        const { error: invitationUpdateError } = await db.from('restaurant_feedback_invitations')
          .update({ status: 'FAILED' }).eq('id', invitation.id).eq('status', 'QUEUED');
        if (invitationUpdateError) console.error('[cron/customer-engagement-email] Could not update invitation status:', invitationUpdateError.message);
      }
      failed += 1;
      continue;
    }

    const providerResult = await response.json().catch(() => null);
    const { error: queueUpdateError } = await db.from('restaurant_notification_queue').update({
      status: 'SENT',
      provider_message_id: typeof providerResult?.id === 'string' ? providerResult.id : null,
      error_code: null,
      updated_at: new Date().toISOString(),
    }).eq('id', job.id).eq('status', 'SENDING');
    if (queueUpdateError) {
      console.error('[cron/customer-engagement-email] Email accepted but queue status update failed:', queueUpdateError.message);
      return NextResponse.json({ error: 'Email was accepted but delivery status could not be saved.' }, { status: 503 });
    }
    const { error: invitationUpdateError } = await db.from('restaurant_feedback_invitations')
      .update({ status: 'SENT', sent_at: new Date().toISOString() }).eq('id', invitation.id).eq('status', 'QUEUED');
    if (invitationUpdateError) {
      console.error('[cron/customer-engagement-email] Email accepted but invitation status update failed:', invitationUpdateError.message);
      return NextResponse.json({ error: 'Email was accepted but invitation status could not be saved.' }, { status: 503 });
    }
    sent += 1;
  }

  return NextResponse.json({ ok: true, processed: jobs?.length ?? 0, sent, failed, cancelled });
}
