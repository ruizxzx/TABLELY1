'use client';

import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';

type Receipt = {
  order_id: string;
  order_number: number;
  restaurant_name: string;
  branch_name: string;
  branch_address: string | null;
  branch_phone: string | null;
  created_at: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal: number;
  tax: number;
  additional_charges: number;
  discount: number;
  coupon_code: string | null;
  total: number;
  items: Array<{ id: string; item_name_snapshot: string; quantity: number; unit_price: number; line_total: number; special_instructions: string | null }>;
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
      if (!response.ok) setError(body.error ?? 'Could not load this receipt.');
      else setReceipt(body);
    })();
  }, [params]);

  if (error) return <main className="auth-page"><div className="auth-panel"><Link href="/customer/history" className="customer-back"><ArrowLeft size={15}/> Order history</Link><div className="notice notice-error">{error}</div></div></main>;
  if (!receipt) return <main className="auth-page"><div className="auth-panel"><p className="muted-small">Loading receipt…</p></div></main>;

  return <main className="receipt-page">
    <div className="receipt-toolbar no-print"><Link href={`/customer/history/${receipt.order_id}`} className="customer-back"><ArrowLeft size={15}/> Order details</Link><button className="button button-primary" onClick={() => window.print()}><Printer size={15}/> Print receipt</button></div>
    <article className="receipt-card">
      <header className="receipt-header"><div className="eyebrow">TABLELY CUSTOMER RECEIPT</div><h1>{receipt.restaurant_name}</h1><p>{receipt.branch_name}{receipt.branch_address ? ` · ${receipt.branch_address}` : ''}{receipt.branch_phone ? ` · ${receipt.branch_phone}` : ''}</p></header>
      <div className="receipt-meta"><span>Order #{receipt.order_number}</span><span>{new Date(receipt.created_at).toLocaleString('en-IN')}</span></div>
      <div className="receipt-items">{receipt.items.map(item => <div className="receipt-item" key={item.id}><div><strong>{item.quantity} × {item.item_name_snapshot}</strong>{item.special_instructions ? <small>{item.special_instructions}</small> : null}</div><span>{money(item.line_total)}</span></div>)}</div>
      <div className="receipt-totals"><div><span>Subtotal</span><b>{money(receipt.subtotal)}</b></div>{receipt.coupon_code ? <div><span>Coupon · {receipt.coupon_code}</span><b>—</b></div> : null}{receipt.discount > 0 ? <div><span>Discount</span><b>-{money(receipt.discount)}</b></div> : null}<div><span>Tax</span><b>{money(receipt.tax)}</b></div>{receipt.additional_charges > 0 ? <div><span>Additional charges</span><b>{money(receipt.additional_charges)}</b></div> : null}<div className="receipt-total"><strong>Total</strong><strong>{money(receipt.total)}</strong></div></div>
      <footer className="receipt-footer"><span>Payment: {receipt.payment_status} · {receipt.payment_method ?? '—'}</span><span>Order status: {receipt.status}</span></footer>
    </article>
  </main>;
}
