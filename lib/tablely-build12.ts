export const BUILD12_PERMISSIONS = [
  ['VIEW_ORDERS', 'View orders'], ['EDIT_ORDERS', 'Edit orders'], ['CANCEL_ORDERS', 'Cancel orders'],
  ['KITCHEN_ACCESS', 'Kitchen access'], ['BILLING', 'Billing'], ['CHARGES', 'Charges'], ['PAYMENTS', 'Payments'],
  ['STAFF_MANAGEMENT', 'Staff management'], ['ANALYTICS', 'Analytics'], ['SETTINGS', 'Settings'],
  ['MENU_MANAGEMENT', 'Menu management'], ['BRANCH_MANAGEMENT', 'Branch management'], ['SUBSCRIPTION_MANAGEMENT', 'Subscription management'],
  ['DISCOUNTS_COUPONS', 'Discounts / coupons'],
] as const;
export type Build12Permission = typeof BUILD12_PERMISSIONS[number][0];
