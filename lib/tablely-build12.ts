export const BUILD12_PERMISSIONS = [
  ['VIEW_ORDERS', 'View orders'], ['EDIT_ORDERS', 'Edit orders'], ['CANCEL_ORDERS', 'Cancel orders'],
  ['KITCHEN_ACCESS', 'Kitchen access'], ['BILLING', 'Billing'], ['CHARGES', 'Charges'], ['PAYMENTS', 'Payments'],
  ['STAFF_MANAGEMENT', 'Staff management'], ['ANALYTICS', 'Analytics'], ['SETTINGS', 'Settings'],
  ['MENU_MANAGEMENT', 'Menu management'], ['BRANCH_MANAGEMENT', 'Branch management'], ['SUBSCRIPTION_MANAGEMENT', 'Subscription management'],
  ['DISCOUNTS_COUPONS', 'Discounts / coupons'],
  ['VIEW_ONLINE_ORDERS', 'View online orders'], ['VIEW_CUSTOMER_DETAILS', 'View customer details'],
  ['MANAGE_ONLINE_ORDERING', 'Manage online ordering'], ['MANAGE_PICKUP', 'Manage pickup'],
  ['VIEW_DELIVERY', 'View delivery'], ['MANAGE_DELIVERY', 'Manage delivery'],
  ['ASSIGN_DELIVERY', 'Assign delivery staff'], ['UPDATE_DELIVERY_STATUS', 'Update delivery status'],
  ['COLLECT_DELIVERY_PAYMENT', 'Collect delivery payment'], ['VIEW_FULFILLMENT_REPORTS', 'View fulfillment reports'],
] as const;
export type Build12Permission = typeof BUILD12_PERMISSIONS[number][0];
