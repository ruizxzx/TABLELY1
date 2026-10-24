import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { assertSameOrigin, getBearerUser, withRateLimit } from '../../../../lib/server-security';

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

async function ownedStore(userId: string) {
  const db = getAdminSupabase();
  const { data, error } = await db.from('stores').select('id').eq('owner_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'studio-customers-manage-read', 60);
  if (limited) return limited;
  try {
    const user = await getBearerUser(request);
    if (!user) return fail('Unauthorized', 401);
    const store = await ownedStore(user.id);
    if (!store) return fail('Store not found.', 404);
    const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase();
    if (!email || email.length > 320) return fail('Customer email is required.');
    const db = getAdminSupabase();
    const [{ data: tags, error: tagError }, { data: notes, error: noteError }] = await Promise.all([
      db.from('customer_tags').select('id,tag,created_at').eq('store_id', store.id).eq('customer_email', email).order('tag'),
      db.from('customer_notes').select('id,note,created_at,updated_at').eq('store_id', store.id).eq('customer_email', email).order('created_at', { ascending: false }),
    ]);
    if (tagError) throw tagError;
    if (noteError) throw noteError;
    return NextResponse.json({ ok: true, data: { tags: tags || [], notes: notes || [] } });
  } catch (error) {
    console.error('[studio/customers/manage:get]', error);
    return fail('Could not load customer metadata.', 500);
  }
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'studio-customers-manage-write', 30);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Unauthorized', 401);
    const store = await ownedStore(user.id);
    if (!store) return fail('Store not found.', 404);
    const body = await request.json() as { action?: unknown; email?: unknown; tag?: unknown; note?: unknown; noteId?: unknown };
    const action = String(body.action || '');
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid customer email.');
    const db = getAdminSupabase();
    if (action === 'add_tag') {
      const tag = String(body.tag || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 50);
      if (!tag) return fail('Enter a tag.');
      const { data, error } = await db.from('customer_tags').upsert({ store_id: store.id, customer_email: email, tag }, { onConflict: 'store_id,customer_email,tag' }).select('id,tag,created_at').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }
    if (action === 'remove_tag') {
      const tag = String(body.tag || '').trim().toLowerCase();
      const { error } = await db.from('customer_tags').delete().eq('store_id', store.id).eq('customer_email', email).eq('tag', tag);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (action === 'add_note') {
      const note = String(body.note || '').trim().slice(0, 4000);
      if (!note) return fail('Enter a private note.');
      const { data, error } = await db.from('customer_notes').insert({ store_id: store.id, customer_email: email, note }).select('id,note,created_at,updated_at').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }
    if (action === 'delete_note') {
      const noteId = String(body.noteId || '');
      const { error } = await db.from('customer_notes').delete().eq('id', noteId).eq('store_id', store.id).eq('customer_email', email);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    return fail('Unsupported customer action.');
  } catch (error) {
    console.error('[studio/customers/manage:post]', error);
    return fail('Could not update customer metadata.', 500);
  }
}
