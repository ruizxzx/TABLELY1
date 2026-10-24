import { getPublishedContent } from '../lib/public-content';
import PublicNavClient from './PublicNavClient';

export default async function PublicNav() {
	const c = await getPublishedContent('site');
	const x = c?.content || {};
	const nav = x.nav || [{ label: 'Features', href: '/#features' }, { label: 'How it works', href: '/#how' }, { label: 'Pricing', href: '/#pricing' }, { label: 'FAQ', href: '/#faq' }, { label: 'Vision', href: '/vision' }];
	return <header className="public-nav"><PublicNavClient nav={nav} /></header>;
}
