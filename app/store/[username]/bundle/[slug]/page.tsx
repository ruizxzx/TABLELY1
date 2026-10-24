export { generateMetadata } from '../../../../[username]/bundle/[slug]/page';
import { renderBundlePage } from '../../../../[username]/bundle/[slug]/page';

export const dynamic = 'force-dynamic';

export default function StoreBundlePage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string; slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderBundlePage({ params, searchParams }, true);
}
