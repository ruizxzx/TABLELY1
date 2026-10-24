'use client';

import { useEffect, useMemo, useState } from 'react';
import CustomerCRMPanel from '../../components/CustomerCRMPanel';
import { supabase } from '../../lib/supabase';
import { formatMoney } from '../../lib/format';

export default function Customers() {
  const [orders, setOrders] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!supabase) { setLoading(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const { data } = await supabase.from('orders').select('buyer_email,gross_amount,currency,created_at,status,products(title)').eq('creator_id', user.id).eq('status', 'paid').order('created_at', { ascending: false });
      setOrders(data || []);
      setLoading(false);
    })();
  }, []);

  const customers = useMemo(() => {
    const map = new Map<string, any>();
    for (const order of orders) {
      const email = order.buyer_email;
      const customer = map.get(email) || { email, orders: 0, spent: 0, currency: order.currency, products: new Set<string>(), last: order.created_at };
      customer.orders += 1;
      customer.spent += Number(order.gross_amount || 0);
      customer.products.add(order.products?.title || 'Deleted product');
      if (new Date(order.created_at) > new Date(customer.last)) customer.last = order.created_at;
      map.set(email, customer);
    }
    return [...map.values()].filter(customer => !query || customer.email.toLowerCase().includes(query.toLowerCase()));
  }, [orders, query]);

  return <div className="studio-content">
    <div className="page-title"><div><div className="eyebrow">CUSTOMERS</div><h1>Customers</h1><p>Buyer history aggregated from verified paid orders.</p></div></div>
    <div className="toolbar"><input className="input" style={{ maxWidth: 380 }} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search customer email" /></div>
    <div className="card panel">
      {loading ? <div className="loading-card">Loading customers...</div> : <div className="table-scroll"><table className="table"><thead><tr><th>Email</th><th>Orders</th><th>Products purchased</th><th>Total spent</th><th>Last purchase</th><th>CRM</th></tr></thead><tbody>{customers.map(customer => <tr key={customer.email}><td><b>{customer.email}</b></td><td>{customer.orders}</td><td>{[...customer.products].join(', ')}</td><td>{formatMoney(customer.spent, customer.currency)}</td><td>{new Date(customer.last).toLocaleString('en-IN')}</td><td><CustomerCRMPanel email={customer.email} /></td></tr>)}</tbody></table></div>}
      {!loading && !customers.length && <div className="empty-state">No customers found.</div>}
    </div>
  </div>;
}
