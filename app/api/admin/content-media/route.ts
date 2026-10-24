import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { assertSameOrigin, requireAdmin, withRateLimit } from '../../../lib/server-security';

export const dynamic = 'force-dynamic';

function fail(message: string, status = 400) { return NextResponse.json({ ok: false, error: message }, { status }); }

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'admin-content-media', 20);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    await requireAdmin(request, 'content.write');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return fail('Image file is required.');
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) return fail('Use a JPG, PNG, WebP or GIF image.');
    if (file.size > 10 * 1024 * 1024) return fail('Image must be 10 MB or smaller.');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(-120) || 'founder-photo';
    const path = `founder/${crypto.randomUUID()}-${safeName}`;
    const db = getAdminSupabase();
    const { error } = await db.storage.from('site-branding').upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
    if (error) throw error;
    const { data } = db.storage.from('site-branding').getPublicUrl(path);
    return NextResponse.json({ ok: true, url: data.publicUrl });
  } catch (error) {
    console.error('[admin content media]', error);
    return fail(error instanceof Error ? error.message : 'Photo upload failed.', 500);
  }
}