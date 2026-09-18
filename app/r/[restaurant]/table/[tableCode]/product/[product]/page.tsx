import CustomerProductClient from '@/components/customer/CustomerProductClient';

export default async function Page({ params }: { params: Promise<{ restaurant: string; tableCode: string; product: string }> }) {
  const { restaurant, tableCode, product } = await params;
  return <CustomerProductClient restaurantSlug={restaurant} tableCode={tableCode} productId={product} />;
}
