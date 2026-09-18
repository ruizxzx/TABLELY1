import CustomerCheckoutClient from '@/components/customer/CustomerCheckoutClient';

export default async function Page({ params }: { params: Promise<{ restaurant: string; tableCode: string }> }) {
  const { restaurant, tableCode } = await params;
  return <CustomerCheckoutClient restaurantSlug={restaurant} tableCode={tableCode} />;
}
