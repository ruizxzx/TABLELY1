import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const requestSchema = z.object({
  orderId: z.string().uuid(),
  trackingToken: z.string().min(20).max(128),
  email: z.string().trim().toLowerCase().email().max(320),
});

export async function POST(request: Request) {
  try {
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Please provide a valid email address.' },
        { status: 400 },
      );
    }

    const admin = getSupabaseAdminClient();
    if (!admin) {
      return NextResponse.json(
        { error: 'Email updates are not configured.' },
        { status: 503 },
      );
    }

    const { orderId, trackingToken, email } = parsed.data;

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select('id, tracking_token')
      .eq('id', orderId)
      .eq('tracking_token', trackingToken)
      .maybeSingle();

    if (orderError) {
      console.error('customer/order-email-notifications: order lookup failed', orderError);
      return NextResponse.json(
        { error: 'Could not verify this order.' },
        { status: 500 },
      );
    }

    if (!order) {
      return NextResponse.json(
        { error: 'Order not found.' },
        { status: 404 },
      );
    }

    const { data: subscription, error: subscriptionError } = await admin
      .from('order_email_notification_subscriptions')
      .upsert(
        {
          order_id: order.id,
          email,
          enabled: true,
          consented_at: new Date().toISOString(),
        },
        { onConflict: 'order_id' },
      )
      .select('id,email')
      .single();

    if (subscriptionError) {
      console.error(
        'customer/order-email-notifications: subscription save failed',
        subscriptionError,
      );
      return NextResponse.json(
        { error: 'Could not save email updates.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      subscriptionId: subscription.id,
      email: subscription.email,
    });
  } catch (error) {
    console.error('customer/order-email-notifications: unexpected error', error);
    return NextResponse.json(
      { error: 'Could not save email updates.' },
      { status: 500 },
    );
  }
}
