export type ProductStatus = 'draft' | 'live' | 'archived';
export type ProductVisibility = 'public' | 'private';

export type Product = {
  id: string;
  store_id: string;
  title: string;
  slug: string;
  short_description: string | null;
  description: string | null;
  price: number;
  compare_at_price: number | null;
  currency: string;
  category: string | null;
  cover_image_path: string | null;
  gallery: string[];
  file_path: string | null;
  preview_file_path: string | null;
  product_type: string | null;
  license: string | null;
  refund_policy: string | null;
  status: ProductStatus;
  visibility: ProductVisibility;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  scheduled_publish_at?: string | null;
  max_purchases?: number | null;
  max_downloads?: number | null;
  download_expiry_days?: number;
  requires_license_key?: boolean;
  license_terms?: string | null;
};

export type Store = {
  id: string;
  owner_id: string;
  username: string;
  name: string;
  bio: string | null;
  avatar_url: string | null;
  status: 'active' | 'draft' | 'suspended';
  featured_product_id: string | null;
  created_at: string;
  updated_at: string;
};
