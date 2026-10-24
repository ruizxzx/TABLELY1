import { supabase, slugify } from './supabase';

export const MAX_DIGITAL_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const PRODUCT_FILE_ACCEPT = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.rar',
  'application/epub+zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
];

export const COVER_ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function validateDigitalFile(file: File | null) {
  if (!file) return null;
  if (file.size > MAX_DIGITAL_FILE_BYTES) {
    return `Digital file is too large. Maximum is ${Math.round(MAX_DIGITAL_FILE_BYTES / (1024 * 1024))} MB.`;
  }
  if (file.type && !PRODUCT_FILE_ACCEPT.includes(file.type)) {
    return 'This file type is not supported yet.';
  }
  return null;
}

export function validateCoverFile(file: File | null) {
  if (!file) return null;
  if (file.size > MAX_IMAGE_BYTES) return 'Cover image must be 10 MB or smaller.';
  if (!COVER_ACCEPT.includes(file.type)) return 'Cover image must be JPG, PNG, WEBP, or GIF.';
  return null;
}

export function validateDigitalLink(value: string) {
  const clean = value.trim();
  if (!clean) return 'Delivery link is required.';
  try {
    const url = new URL(clean);
    if (!['http:', 'https:'].includes(url.protocol)) return 'Delivery link must use http:// or https://.';
  } catch {
    return 'Enter a valid delivery URL.';
  }
  if (clean.length > 2048) return 'Delivery link is too long.';
  return null;
}

export async function uniqueSlug(storeId: string, title: string, currentProductId?: string) {
  if (!supabase) return slugify(title) || crypto.randomUUID().slice(0, 8);
  const base = slugify(title) || `product-${crypto.randomUUID().slice(0, 8)}`;
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    let query = supabase.from('products').select('id').eq('store_id', storeId).eq('slug', candidate).limit(1);
    if (currentProductId) query = query.neq('id', currentProductId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return candidate;
  }
  throw new Error('Could not generate a unique product URL.');
}
