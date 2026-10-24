import { getAdminSupabase } from './server-admin';

export async function assertProductOwner(productId: string, userId: string) {
  const db = getAdminSupabase();
  const { data: product, error } = await db.from('products').select('id,store_id,cover_image_path,file_path,preview_file_path,status,plan_archived').eq('id', productId).maybeSingle();
  if (error) throw error;
  if (!product) throw new Error('Product not found.');
  const { data: store, error: storeError } = await db.from('stores').select('id,owner_id').eq('id', product.store_id).maybeSingle();
  if (storeError) throw storeError;
  if (!store || store.owner_id !== userId) throw new Error('You do not own this product.');
  return { ...product, store };
}

export function slugifyProduct(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';
}
