import CustomerCartClient from '@/components/customer/CustomerCartClient';

export default async function Page({ params }: { params: Promise<{ restaurant: string; tableCode: string }> }) {
  const { restaurant, tableCode } = await params;
  return <CustomerCartClient restaurantSlug={restaurant} tableCode={tableCode} />;
}
