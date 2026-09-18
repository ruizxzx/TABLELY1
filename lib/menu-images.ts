import type { SupabaseClient } from '@supabase/supabase-js';

export const MENU_IMAGE_BUCKET = 'menu-images';
export const MAX_MENU_IMAGE_BYTES = 5 * 1024 * 1024;

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function extensionFor(file: File) {
  switch (file.type) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    default: return 'jpg';
  }
}

export function validateMenuImage(file: File) {
  if (!allowedTypes.has(file.type)) {
    return 'Use a JPG, PNG, or WebP image.';
  }
  if (file.size > MAX_MENU_IMAGE_BYTES) {
    return 'Image must be 5 MB or smaller.';
  }
  return null;
}

export async function uploadMenuImage(
  supabase: SupabaseClient,
  branchId: string,
  menuItemId: string,
  file: File,
) {
  const validationError = validateMenuImage(file);
  if (validationError) throw new Error(validationError);

  const path = `${branchId}/items/${menuItemId}-${crypto.randomUUID()}.${extensionFor(file)}`;
  const { error } = await supabase.storage.from(MENU_IMAGE_BUCKET).upload(path, file, {
    cacheControl: '31536000',
    contentType: file.type,
    upsert: false,
  });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from(MENU_IMAGE_BUCKET).getPublicUrl(path);
  if (!data.publicUrl) {
    await supabase.storage.from(MENU_IMAGE_BUCKET).remove([path]);
    throw new Error('The image uploaded, but a public URL could not be generated.');
  }

  return { path, publicUrl: data.publicUrl };
}

export async function removeMenuImage(supabase: SupabaseClient, path: string | null | undefined) {
  if (!path) return;
  const { error } = await supabase.storage.from(MENU_IMAGE_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}
