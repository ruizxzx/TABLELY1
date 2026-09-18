import CustomerOrderClient from '@/components/customer/CustomerOrderClient';

export default async function Page({ params }: { params: Promise<{ restaurant: string; tableCode: string; orderId: string }> }) {
  const { restaurant, tableCode, orderId } = await params;
  return <CustomerOrderClient restaurantSlug={restaurant} tableCode={tableCode} orderToken={orderId} />;
}
