'use client';

import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';

type Receipt = {
  order_id: string; order_number: number; receipt_number: string; restaurant_name: string; restaurant_logo: string | null;
  branch_name: string; branch_address: string | null; branch_phone: string | null; created_at: string; status: string;
  payment_status: string; payment_method: string | null; subtotal: number; tax: number; additional_charges: number;
  discount: number; coupon_code: string | null; total: number; collected_amount: number; outstanding_amount: number;
  refund_amount: number;
  items: Array<{ id: string; item_name_snapshot: string; quantity: number; unit_price: number; line_total: number; special_instructions: string | null; selected_options: Array<{ type: string; name: string; group_name?: string }> | null }>;
  transactions: Array<{ id: string; provider: string; provider_payment_id: string | null; amount: number; currency: string; status: string; method: string | null; created_at: string }>;
};

const money = (value: number) => `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CustomerReceiptPage({ params }: { params: Promise<{ orderId: string }> }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const { orderId } = await params;
      const response = await fetch(`/api/customer/orders/${encodeURIComponent(orderId)}/receipt`, { cache: 'no-store' });
      const body = await response.json() as Receipt & { error?: string };
      if (!response.ok) setError(body.error ?? 'Could not load this receipt.'); else setReceipt(body);
    })();
  }, [params]);
  if (error) return <main className="auth-page"><div className="auth-panel"><Link href="/customer/history" className="customer-back"><ArrowLeft size={15}/> Order history</Link><div className="notice notice-error">{error}</div></div></main>;
  if (!receipt) return <main className="auth-page"><div className="auth-panel"><p className="muted-small">Loading receipt…</p></div></main>;
  return <main className="receipt-page">
    <div className="receipt-toolbar no-print"><Link href={`/customer/history/${receipt.order_id}`} className="customer-back"><ArrowLeft size={15}/> Order details</Link><button className="button button-primary" onClick={() => window.print()}><Printer size={15}/> Print / save PDF</button></div>
    <article className="receipt-card">
      <header className="receipt-header">{receipt.restaurant_logo ? <img className="receipt-logo" src={receipt.restaurant_logo} alt={`${receipt.restaurant_name} logo`} /> : null}<div className="eyebrow">PAYMENT RECEIPT · NOT A TAX INVOICE</div><h1>{receipt.restaurant_name}</h1><p>{receipt.branch_name}{receipt.branch_address ? ` · ${receipt.branch_address}` : ''}{receipt.branch_phone ? ` · ${receipt.branch_phone}` : ''}</p></header>
      <div className="receipt-meta"><span>Receipt {receipt.receipt_number}</span><span>Order #{receipt.order_number}</span><span>{new Date(receipt.created_at).toLocaleString('en-IN')}</span></div>
      <div className="receipt-items">{receipt.items.map(item => <div className="receipt-item" key={item.id}><div><strong>{item.quantity} × {item.item_name_snapshot}</strong>{item.selected_options?.length ? <small>{item.selected_options.map(option => `${option.group_name ? `${option.group_name}: ` : ''}${option.name}`).join(' · ')}</small> : null}{item.special_instructions ? <small>{item.special_instructions}</small> : null}</div><span>{money(item.line_total)}</span></div>)}</div>
      <div className="receipt-totals"><div><span>Subtotal</span><b>{money(receipt.subtotal)}</b></div>{receipt.coupon_code ? <div><span>Coupon · {receipt.coupon_code}</span><b>Applied</b></div> : null}{receipt.discount > 0 ? <div><span>Discount</span><b>-{money(receipt.discount)}</b></div> : null}<div><span>Tax</span><b>{money(receipt.tax)}</b></div>{receipt.additional_charges > 0 ? <div><span>Additional charges</span><b>{money(receipt.additional_charges)}</b></div> : null}<div className="receipt-total"><strong>Total bill</strong><strong>{money(receipt.total)}</strong></div><div><span>Collected</span><b>{money(receipt.collected_amount)}</b></div>{receipt.refund_amount > 0 ? <div><span>Refunded</span><b>-{money(receipt.refund_amount)}</b></div> : null}<div className="receipt-total"><strong>Outstanding</strong><strong>{money(receipt.outstanding_amount)}</strong></div></div>
      {receipt.transactions?.length ? <section className="receipt-transactions"><h2>Payment transactions</h2>{receipt.transactions.map(transaction => <div key={transaction.id}><span>{transaction.method || transaction.provider} · {transaction.status}{transaction.provider_payment_id ? ` · ${transaction.provider_payment_id}` : ''}</span><b>{money(transaction.amount)}</b></div>)}</section> : null}
      <footer className="receipt-footer"><span>Payment: {receipt.payment_status} · {receipt.payment_method ?? '—'}</span><span>Order status: {receipt.status}</span><span>{receipt.outstanding_amount > 0 ? 'Partial payment acknowledgement' : 'Fully settled'}</span></footer>
    </article>
  </main>;
}
