import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(240),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  company_name: z.string().trim().max(180).optional().or(z.literal('')),
  restaurant_count: z.number().int().min(1).max(100000).nullable().optional(),
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(5).max(6000),
});

const recentSubmissions = new Map<string, number>();

function cleanup(now: number) {
  for (const [key, timestamp] of recentSubmissions) {
    if (now - timestamp > 2 * 60 * 1000) recentSubmissions.delete(key);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Please check the form fields and try again.' }, { status: 400 });

    const payload = parsed.data;
    const normalized = {
      ...payload,
      email: payload.email.toLowerCase(),
      phone: payload.phone || null,
      company_name: payload.company_name || null,
      restaurant_count: payload.restaurant_count ?? null,
    };
    const now = Date.now();
    cleanup(now);
    const key = `${normalized.email}|${normalized.subject.toLowerCase()}|${normalized.message.toLowerCase()}`;
    const previous = recentSubmissions.get(key);
    if (previous && now - previous < 30_000) {
      return NextResponse.json({ error: 'Please wait a moment before sending the same message again.' }, { status: 429 });
    }
    recentSubmissions.set(key, now);

    const supabase = await getSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'The contact form is temporarily unavailable. Please email krishsarkar456@gmail.com directly.' }, { status: 503 });

    const { data: contactId, error } = await supabase.rpc('submit_public_contact', {
      p_name: normalized.name,
      p_email: normalized.email,
      p_phone: normalized.phone,
      p_company_name: normalized.company_name,
      p_restaurant_count: normalized.restaurant_count,
      p_subject: normalized.subject,
      p_message: normalized.message,
    });
    if (error || !contactId) {
      recentSubmissions.delete(key);
      return NextResponse.json({ error: error?.message || 'Could not save your message.' }, { status: error?.code === '55000' ? 429 : 400 });
    }

    let emailSent = false;
    const resendKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.RESEND_FROM_EMAIL?.trim();
    if (resendKey && from) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: ['krishsarkar456@gmail.com'],
            reply_to: normalized.email,
            subject: `TABLELY contact: ${normalized.subject}`,
            text: [
              `Name: ${normalized.name}`,
              `Email: ${normalized.email}`,
              `Phone: ${normalized.phone || '—'}`,
              `Company: ${normalized.company_name || '—'}`,
              `Restaurants / branches: ${normalized.restaurant_count ?? '—'}`,
              `Submitted: ${new Date().toISOString()}`,
              '',
              normalized.message,
              '',
              `Contact ID: ${contactId}`,
            ].join('\n'),
          }),
          cache: 'no-store',
        });
        emailSent = response.ok;
      } catch {
        emailSent = false;
      }
    }

    return NextResponse.json({ ok: true, emailSent });
  } catch {
    return NextResponse.json({ error: 'Could not process the contact request.' }, { status: 400 });
  }
}
