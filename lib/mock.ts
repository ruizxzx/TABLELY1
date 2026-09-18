export type OrderStatus = 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED';

export type MenuItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  available: boolean;
  image?: string;
};

export const categories = ['Bestsellers', 'Main Course', 'Indian Breads', 'Beverages'];
export const restaurant = { name: 'Tablely Kitchen', slug: 'tablely-kitchen' };

export type MockOrder = {
  id: string;
  table: number;
  itemCount: number;
  total: number;
  status: OrderStatus;
  payment: 'PAID' | 'PENDING';
};

export const menu: MenuItem[] = [
  { id: '1', name: 'Butter Chicken', description: 'Creamy tomato gravy, tender chicken.', price: 280, category: 'Main Course', available: true },
  { id: '2', name: 'Paneer Tikka Masala', description: 'Charred paneer in smoky masala gravy.', price: 220, category: 'Main Course', available: true },
  { id: '3', name: 'Dal Makhani', description: 'Slow-cooked black lentils finished with butter.', price: 180, category: 'Main Course', available: true },
  { id: '4', name: 'Garlic Naan', description: 'Tandoor baked naan with garlic and butter.', price: 80, category: 'Indian Breads', available: true },
  { id: '5', name: 'Masala Dosa', description: 'Crisp dosa with spiced potato filling.', price: 160, category: 'Bestsellers', available: true },
  { id: '6', name: 'Coke', description: 'Chilled 300 ml bottle.', price: 40, category: 'Beverages', available: true },
];

export const orders: MockOrder[] = [
  { id: '#1048', table: 12, itemCount: 5, total: 720, status: 'PREPARING', payment: 'PAID' },
  { id: '#1049', table: 5, itemCount: 2, total: 300, status: 'NEW', payment: 'PENDING' },
  { id: '#1047', table: 3, itemCount: 3, total: 340, status: 'READY', payment: 'PAID' },
  { id: '#1046', table: 8, itemCount: 2, total: 200, status: 'SERVED', payment: 'PAID' },
];

export const navItems = [
  { href: '/dashboard', label: 'Overview', icon: 'LayoutDashboard' },
  { href: '/orders', label: 'Orders', icon: 'ClipboardList' },
  { href: '/tables', label: 'Tables', icon: 'Table2' },
  { href: '/qr', label: 'QR Codes', icon: 'QrCode' },
  { href: '/menu', label: 'Menu', icon: 'UtensilsCrossed' },
  { href: '/kitchen', label: 'Kitchen', icon: 'ChefHat' },
];
