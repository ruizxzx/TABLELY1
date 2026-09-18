import CustomerMenuClient from '@/components/customer/CustomerMenuClient';

export default async function Page({ params }: { params: Promise<{ restaurant: string; tableCode: string }> }) {
  const { restaurant, tableCode } = await params;
  return <CustomerMenuClient restaurantSlug={restaurant} tableCode={tableCode} />;
}
