export type PrimaryPublicPage = 'store' | 'linkhub';
export type LinkHubPublicTemplate = 'default' | 'bento';

export function getLinkHubPublicTemplate(value: unknown): LinkHubPublicTemplate {
  return value === 'bento' ? 'bento' : 'default';
}

export function getPrimaryPublicPage(value: unknown): PrimaryPublicPage {
  return value === 'linkhub' ? 'linkhub' : 'store';
}

export function getStorePath(username: string, primaryPage: PrimaryPublicPage = 'store') {
  return primaryPage === 'store' ? `/${username}` : `/store/${username}`;
}

export function getLinkHubPath(username: string, primaryPage: PrimaryPublicPage = 'store') {
  return primaryPage === 'linkhub' ? `/${username}` : `/links/${username}`;
}

export function getProductPath(username: string, slug: string, _primaryPage?: PrimaryPublicPage) {
  return `/store/${username}/product/${slug}`;
}

export function getBundlePath(username: string, slug: string, _primaryPage?: PrimaryPublicPage) {
  return `/store/${username}/bundle/${slug}`;
}

export function getCheckoutPath(username: string, id: string, _primaryPage?: PrimaryPublicPage) {
  return `/store/${username}/checkout/${id}`;
}

export function getBundleCheckoutPath(username: string, id: string) {
  return `/store/${username}/checkout/bundle/${id}`;
}

export type PublicSearchParams = Record<string, string | string[] | undefined>;

export function withPreservedQuery(path: string, searchParams?: PublicSearchParams) {
  if (!searchParams) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (typeof value === 'string') query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}
