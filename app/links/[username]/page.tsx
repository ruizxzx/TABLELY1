export { generateMetadata } from '../../lib/link-hub';
import { renderLinkHubPage } from '../../lib/link-hub';
import { redirect } from 'next/navigation';
import { withPreservedQuery, type PublicSearchParams } from '../../lib/public-paths';

export const dynamic = 'force-dynamic';

export default async function ExplicitLinksPage({ params, searchParams }: { params: Promise<{ username: string }>; searchParams?: Promise<PublicSearchParams> }) {
  const value = await params;
  const query = searchParams ? await searchParams : undefined;
  const username = decodeURIComponent(value.username);
  if (username.startsWith('@')) redirect(withPreservedQuery(`/links/${username.replace(/^@/, '')}`, query));
  return renderLinkHubPage({ params: Promise.resolve(value), searchParams: query ? Promise.resolve(query) : undefined }, true);
}
