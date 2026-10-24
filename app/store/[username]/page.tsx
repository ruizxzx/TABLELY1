import { generateStoreMetadata } from '../../[username]/page';

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }) {
  return generateStoreMetadata({ params }, true);
}
import { renderStorePage } from '../../[username]/page';
import { redirect } from 'next/navigation';
import { withPreservedQuery, type PublicSearchParams } from '../../lib/public-paths';

export const dynamic = 'force-dynamic';

export default async function ExplicitStorePage({ params, searchParams }: { params: Promise<{ username: string }>; searchParams?: Promise<PublicSearchParams> }) {
  const value = await params;
  const query = searchParams ? await searchParams : undefined;
  const username = decodeURIComponent(value.username);
  if (username.startsWith('@')) redirect(withPreservedQuery(`/store/${username.replace(/^@/, '')}`, query));
  return renderStorePage({ params: Promise.resolve(value), searchParams: query ? Promise.resolve(query) : undefined }, true);
}
