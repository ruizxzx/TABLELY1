export function formatMoney(amount: number, currency = 'INR') {
  return currency.toUpperCase() === 'INR' ? `₹${Number(amount || 0).toLocaleString('en-IN')}` : `${currency.toUpperCase()} ${Number(amount || 0).toLocaleString('en-IN')}`;
}
