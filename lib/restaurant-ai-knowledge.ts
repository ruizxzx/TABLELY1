export const restaurantAiHelp = [
  { keywords: ['menu', 'dish', 'price', 'category', 'modifier', 'variant'], title: 'Menu management', href: '/menu', label: 'Open Menu', note: 'Edit categories, dishes, prices, variants and modifiers in Menu. Text edits invalidate saved Hindi and Bengali translations.' },
  { keywords: ['import', 'photo', 'pdf', 'spreadsheet', 'csv', 'excel'], title: 'Menu import', href: '/menu/import', label: 'Import a menu', note: 'Import a menu file or photo, review extracted names and prices, then save selected items as drafts for staff review.' },
  { keywords: ['order', 'kitchen', 'status', 'preparation'], title: 'Orders and kitchen', href: '/orders', label: 'Open Orders', note: 'Review incoming orders, update valid order statuses and use the kitchen view for preparation.' },
  { keywords: ['qr', 'table', 'code'], title: 'Tables and QR codes', href: '/qr', label: 'Open QR codes', note: 'Manage tables and QR destinations. Existing printed QR codes remain linked to their table destination.' },
  { keywords: ['analytics', 'sales', 'revenue', 'popular', 'trend'], title: 'Analytics', href: '/analytics', label: 'Open Analytics', note: 'View branch-scoped sales, orders and operational metrics for an available date range. Advanced reports depend on plan access.' },
  { keywords: ['staff', 'permission', 'role', 'access'], title: 'Staff access', href: '/staff', label: 'Manage staff', note: 'Invite restaurant staff and assign only the branch permissions required for their role.' },
  { keywords: ['payment', 'razorpay', 'gateway', 'online'], title: 'Payments', href: '/settings/payments', label: 'Payment settings', note: 'Configure this restaurant’s payment provider credentials in settings. Credentials are private and must never be shared in chat.' },
  { keywords: ['refund', 'cancel', 'cancellation'], title: 'Refund and cancellation requests', href: '/refunds', label: 'Review requests', note: 'Review authorized refund and cancellation workflows; do not mark orders paid or settled without verified provider evidence.' },
  { keywords: ['support', 'ticket', 'help'], title: 'TABLELY support', href: '/support', label: 'Contact support', note: 'Create a private support request for account, billing or technical issues. Never send passwords or API keys.' },
  { keywords: ['customer', 'message', 'chat', 'conversation'], title: 'Customer messages', href: '/customer-messages', label: 'Open customer messages', note: 'Reply to customer conversations from the restaurant inbox. Customer conversations are separate from TABLELY support tickets.' },
] as const;

export function selectRestaurantHelp(question: string) {
  const words = new Set(question.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return [...restaurantAiHelp]
    .map((article) => ({ article, score: article.keywords.reduce((score, keyword) => score + Number(words.has(keyword)), 0) }))
    .sort((left, right) => right.score - left.score || left.article.title.localeCompare(right.article.title))
    .slice(0, 3)
    .map(({ article }) => ({ title: article.title, href: article.href, label: article.label, note: article.note }));
}

export const restaurantAiAllowedRoutes = restaurantAiHelp.map(({ href }) => href);
