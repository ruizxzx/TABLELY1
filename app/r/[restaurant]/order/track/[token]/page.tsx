import StorefrontTrackClient from '@/components/customer/StorefrontTrackClient';
import '@/app/r/storefront.css';

export default async function StorefrontTrackPage({
  params,
}: {
  params: Promise<{ restaurant: string; token: string }>;
}) {
  const { restaurant, token } = await params;
  return <StorefrontTrackClient restaurantSlug={restaurant} trackingToken={token} />;
}
