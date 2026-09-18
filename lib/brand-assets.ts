import type { SupabaseClient } from '@supabase/supabase-js';

export const BRAND_ASSET_BUCKET = 'brand-assets';
export const MAX_LOGO_IMAGE_BYTES = 5 * 1024 * 1024;

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']);

function extensionFor(file: File) {
  switch (file.type) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    default: return 'jpg';
  }
}

export function validateLogoImage(file: File) {
  if (!allowedTypes.has(file.type)) {
    return 'Use a JPG, PNG, WebP, or SVG image.';
  }
  if (file.size > MAX_LOGO_IMAGE_BYTES) {
    return 'Logo must be 5 MB or smaller.';
  }
  return null;
}

export async function uploadBrandLogo(
  supabase: SupabaseClient,
  organizationId: string,
  file: File,
) {
  const validationError = validateLogoImage(file);
  if (validationError) throw new Error(validationError);

  const path = `${organizationId}/logo-${crypto.randomUUID()}.${extensionFor(file)}`;
  const { error } = await supabase.storage.from(BRAND_ASSET_BUCKET).upload(path, file, {
    cacheControl: '31536000',
    contentType: file.type,
    upsert: false,
  });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from(BRAND_ASSET_BUCKET).getPublicUrl(path);
  if (!data.publicUrl) {
    await supabase.storage.from(BRAND_ASSET_BUCKET).remove([path]);
    throw new Error('The logo uploaded, but a public URL could not be generated.');
  }

  return { path, publicUrl: data.publicUrl };
}

export async function removeBrandLogo(supabase: SupabaseClient, path: string | null | undefined) {
  if (!path) return;
  const { error } = await supabase.storage.from(BRAND_ASSET_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}
