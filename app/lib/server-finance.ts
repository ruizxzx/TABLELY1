import { getAdminSupabase } from './server-admin';

export async function recordSaleLedger(orderId: string, storeId: string, creatorId: string | null, input: {
  grossMinor: number; paymentFeeMinor: number; platformFeeMinor: number; currency: string;
}) {
  const admin = getAdminSupabase();
  const sellerNetMinor = Math.max(0, input.grossMinor - input.paymentFeeMinor - input.platformFeeMinor);
  const rows = [
    { order_id: orderId, store_id: storeId, creator_id: creatorId, entry_type: 'sale', direction: 'credit', amount_minor: input.grossMinor, currency: input.currency, description: 'Gross sale', idempotency_key: `sale:${orderId}` },
    { order_id: orderId, store_id: storeId, creator_id: creatorId, entry_type: 'payment_fee', direction: 'debit', amount_minor: input.paymentFeeMinor, currency: input.currency, description: 'Payment processing fee', idempotency_key: `payment-fee:${orderId}` },
    { order_id: orderId, store_id: storeId, creator_id: creatorId, entry_type: 'platform_fee', direction: 'debit', amount_minor: input.platformFeeMinor, currency: input.currency, description: 'Platform fee', idempotency_key: `platform-fee:${orderId}` },
    { order_id: orderId, store_id: storeId, creator_id: creatorId, entry_type: 'seller_net', direction: 'credit', amount_minor: sellerNetMinor, currency: input.currency, description: 'Creator net', idempotency_key: `seller-net:${orderId}` },
  ];
  const { error } = await admin.from('ledger_entries').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  if (error) throw error;
  return sellerNetMinor;
}

export async function getCreatorBalance(creatorId: string) {
  const admin = getAdminSupabase();
  const { data, error } = await admin.from('ledger_entries')
    .select('amount_minor,direction,currency,entry_type')
    .eq('creator_id', creatorId);
  if (error) throw error;

  // Seller balance is based on the immutable seller_net credits plus
  // explicit adjustments/refund debits. Gross sale and fee entries are
  // reconciliation records and must not be double-counted here.
  let earned = 0;
  let adjustments = 0;
  for (const row of data || []) {
    const amount = Math.max(0, Number(row.amount_minor || 0));
    if (row.entry_type === 'seller_net' && row.direction === 'credit') earned += amount;
    if (row.entry_type === 'adjustment') adjustments += row.direction === 'credit' ? amount : -amount;
    if (['refund','chargeback'].includes(row.entry_type)) adjustments -= amount;
  }

  const { data: payouts, error: payoutError } = await admin.from('payouts')
    .select('amount_minor,status,currency')
    .eq('creator_id', creatorId);
  if (payoutError) throw payoutError;

  const committed = (payouts || [])
    .filter(p => ['pending','processing','paid'].includes(p.status))
    .reduce((sum, p) => sum + Math.max(0, Number(p.amount_minor || 0)), 0);

  const totalEarned = Math.max(0, earned + adjustments);
  const available = Math.max(0, totalEarned - committed);
  const pending = (payouts || [])
    .filter(p => p.status === 'pending')
    .reduce((sum, p) => sum + Math.max(0, Number(p.amount_minor || 0)), 0);

  return {
    available,
    pending,
    totalEarned,
    paidOut: (payouts || []).filter(p => p.status === 'paid').reduce((s,p)=>s+Math.max(0,Number(p.amount_minor||0)),0),
    currency: data?.[0]?.currency || payouts?.[0]?.currency || 'INR'
  };
}
