import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';
import { parseMenuFile } from '@/lib/menu-import-parser';

export const runtime = 'nodejs';
export const maxDuration = 60;
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set([
  'text/csv', 'application/csv', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
]);

function inferredMime(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function safeNameEndsWith(name: string, extension: string) {
  return name.toLowerCase().endsWith(extension);
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Invalid multipart upload.' }, { status: 400 });
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a menu file to import.' }, { status: 400 });
  if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: 'Menu files must be between 1 byte and 20 MB.' }, { status: 413 });
  const branchId = String(form.get('branchId') ?? '');
  const resolved = await resolveServerRestaurantAccess({ branchId, permission: 'MENU_MANAGEMENT' });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentImports, error: rateLimitError } = await access.admin.from('menu_import_jobs')
    .select('id', { count: 'exact', head: true }).eq('user_id', access.context.userId).gte('created_at', since);
  if (rateLimitError) return NextResponse.json({ error: 'Menu import service is temporarily unavailable. Please retry shortly.' }, { status: 503 });
  if ((recentImports ?? 0) >= 12) return NextResponse.json({ error: 'You have reached the menu import limit of 12 uploads per hour. Please try again later.' }, { status: 429 });
  const mimeType = file.type || inferredMime(file.name);
  const inferred = inferredMime(file.name);
  if (!ALLOWED.has(mimeType) && !ALLOWED.has(inferred)) return NextResponse.json({ error: 'Unsupported file. Upload PDF, XLSX, CSV, JPG, PNG or WebP.' }, { status: 415 });
  if (safeNameEndsWith(file.name, '.xls')) {
    return NextResponse.json({ error: 'Legacy binary .xls workbooks are not supported. Save the file as .xlsx or CSV and upload it again.' }, { status: 415 });
  }
  const acceptedMime = inferred;
  const admin = access.admin;
  const id = randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'menu-upload';
  const path = `${access.context.organization.id}/${access.branchId}/${access.context.userId}/${id}/${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const extension = safeName.toLowerCase();
  const validSignature = extension.endsWith('.pdf') ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : extension.endsWith('.xlsx') ? bytes.subarray(0, 2).toString('ascii') === 'PK'
    : extension.endsWith('.png') ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension.endsWith('.jpg') || extension.endsWith('.jpeg') ? bytes[0] === 0xff && bytes[1] === 0xd8
    : extension.endsWith('.webp') ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    : extension.endsWith('.csv') ? !bytes.includes(0)
    : false;
  if (!validSignature) return NextResponse.json({ error: 'The file content does not match its extension or is invalid. Export it as a valid PDF, XLSX, CSV, JPG, PNG or WebP and retry.' }, { status: 415 });
  if (acceptedMime.startsWith('image/') && bytes.length > 8 * 1024 * 1024) return NextResponse.json({ error: 'Menu images must be 8 MB or smaller.' }, { status: 413 });
  const { data: job, error: jobError } = await admin.from('menu_import_jobs').insert({
    id, branch_id: access.branchId, user_id: access.context.userId,
    source_filename: safeName, source_mime_type: acceptedMime, status: 'PROCESSING',
  }).select('id').single();
  if (jobError || !job) return NextResponse.json({ error: 'Could not create the menu import record.' }, { status: 500 });
  try {
    const { error: uploadError } = await admin.storage.from('menu-imports').upload(path, bytes, {
      contentType: acceptedMime, cacheControl: '3600', upsert: false,
    });
    if (uploadError) throw new Error(`Private menu upload failed: ${uploadError.message}`);
    const { error: pathError } = await admin.from('menu_import_jobs').update({ source_storage_path: path }).eq('id', id);
    if (pathError) throw new Error('Could not record the private source file location.');
    const items = await parseMenuFile(safeName, acceptedMime, bytes);
    const { error: previewError } = await admin.from('menu_import_jobs').update({
      status: 'PREVIEW', preview_data: items, extracted_count: items.length, error_message: null,
    }).eq('id', id);
    if (previewError) throw new Error('Menu extraction succeeded, but the preview could not be saved. Retry the import.');
    return NextResponse.json({ jobId: id, filename: safeName, count: items.length, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Menu import failed.';
    await admin.from('menu_import_jobs').update({ status: 'FAILED', error_message: message.slice(0, 500) }).eq('id', id);
    await admin.storage.from('menu-imports').remove([path]).catch(() => {});
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
