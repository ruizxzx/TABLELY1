import { supabase } from './supabase';

const PRODUCT_BUCKET = 'product-files';
const MEDIA_BUCKET = 'store-media';

function safeFileName(name: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return cleaned.slice(-120) || 'file';
}

export function buildOwnedPath(userId: string, productId: string, fileName: string) {
  return `${userId}/${productId}/${crypto.randomUUID()}-${safeFileName(fileName)}`;
}

export function buildMediaPath(userId: string, productId: string, fileName: string) {
  return `${userId}/${productId}-cover-${crypto.randomUUID()}-${safeFileName(fileName)}`;
}

export async function uploadProductFile(userId: string, productId: string, file: File) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const path = buildOwnedPath(userId, productId, file.name);
  const { error } = await supabase.storage.from(PRODUCT_BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type || 'application/octet-stream',
    cacheControl: '3600',
  });
  if (error) throw error;
  return path;
}

export async function uploadStoreMedia(userId: string, productId: string, file: File) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const path = buildMediaPath(userId, productId, file.name);
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type || 'application/octet-stream',
    cacheControl: '31536000',
  });
  if (error) throw error;
  return path;
}

export async function removeStorageFiles(bucket: string, paths: string[]) {
  if (!supabase || paths.length === 0) return;
  const valid = paths.filter(Boolean);
  if (!valid.length) return;
  const { error } = await supabase.storage.from(bucket).remove(valid);
  if (error) throw error;
}

export function publicMediaUrl(path: string | null) {
  if (!supabase || !path) return null;
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}
