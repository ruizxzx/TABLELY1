export type Product = {
  id: string;
  slug: string;
  title: string;
  description: string;
  price: number;
  category: string;
  status: 'Live' | 'Draft';
  sales: number;
};

export const demoStore = {
  username: 'krish',
  name: "Krish's Store",
  creator: 'Krish',
  bio: 'Digital products for a better you. Learn. Build. Grow.',
};

export const demoProducts: Product[] = [
  { id: 'p1', slug: 'web-development-course', title: 'Web Development Course', description: 'Complete guide from basics to advanced.', price: 499, category: 'Courses', status: 'Live', sales: 124 },
  { id: 'p2', slug: 'react-cheat-sheet', title: 'React Cheat Sheet', description: 'Quick reference for React developers.', price: 99, category: 'Guides', status: 'Live', sales: 43 },
  { id: 'p3', slug: 'portfolio-template', title: 'Portfolio Template', description: 'Modern clean portfolio template.', price: 199, category: 'Templates', status: 'Live', sales: 31 },
  { id: 'p4', slug: 'notion-productivity-pack', title: 'Notion Productivity Pack', description: 'Templates for organizing your work.', price: 149, category: 'Templates', status: 'Draft', sales: 0 },
  { id: 'p5', slug: '100-lightroom-presets', title: '100 Lightroom Presets', description: 'Professional presets for creators.', price: 299, category: 'Presets', status: 'Live', sales: 28 },
  { id: 'p6', slug: 'ui-design-assets', title: 'UI Design Assets', description: '500+ UI components and assets.', price: 349, category: 'Assets', status: 'Live', sales: 19 },
];

export function getProduct(slug: string) {
  return demoProducts.find((p) => p.slug === slug);
}
