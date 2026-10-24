'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardList, Copy, CreditCard, Gift, History, Share2, UserRound } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type HistoryRow = { order_id: string; order_number: number; restaurant_name: string; created_at: string; total: number; status: string };
type TabRow = { session_id: string; table_number: number; restaurant_name: string; outstanding: number; status: string; role: 'OWNER'|'MEMBER'; join_code?: string | null };
type TabDetail = { session_id: string; branch_name: string; table_number: number; status: string; role: 'OWNER'|'MEMBER'; outstanding: number; orders: Array<{ order_id: string; order_number: number; total: number; status: string; payment_status: string; created_at: string; customer_name: string }>; members: Array<{ customer_profile_id: string; name: string; role: string }> };

export default function CustomerAccountPage() {
  const [profile, setProfile] = useState<{ name: string | null; email: string | null; phone: string | null } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [tabs, setTabs] = useState<TabRow[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [details, setDetails] = useState<Record<string, TabDetail | null>>({});
  const [settling, setSettling] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    void (async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = '/customer/login?next=/customer/account'; return; }
      const [{ data: profileData, error: profileError }, { data: historyData, error: historyError }, { data: tabData, error: tabError }] = await Promise.all([
        supabase.from('customer_profiles').select('name,email,phone').eq('auth_user_id', user.user.id).single(),
        supabase.rpc('get_my_customer_history'),
        supabase.rpc('get_my_active_pay_later_sessions'),
      ]);
      if (profileError || historyError || tabError) { setError(profileError?.message ?? historyError?.message ?? tabError?.message ?? 'Could not load account.'); return; }
      const nextProfile = profileData as typeof profile;
      setProfile(nextProfile); setName(nextProfile?.name ?? ''); setPhone(nextProfile?.phone ?? '');
      setHistory((historyData ?? []) as HistoryRow[]); setTabs((tabData ?? []) as TabRow[]);
    })();
  }, []);

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setError(null);
    setMessage(null);
    const { error: saveError } = await supabase.rpc('update_customer_profile', { p_name: name, p_phone: phone });
    setMessage(saveError ? null : 'Profile updated.');
    if (saveError) setError(saveError.message);
  }

  async function logout() {
    const supabase = getSupabaseBrowserClient();
    if (supabase) await supabase.auth.signOut();
    window.location.href = '/customer/login';
  }

  async function loadTabDetail(sessionId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: detailError } = await supabase.rpc('get_my_pay_later_session_detail', { p_session_id: sessionId });
    if (detailError) { setError(detailError.message); return; }
    setDetails(current => ({ ...current, [sessionId]: data as TabDetail }));
  }

  async function settle(sessionId: string, method: 'CASH' | 'UPI') {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSettling(sessionId);
    const { error: settleError } = await supabase.rpc('settle_pay_later_session', { p_session_id: sessionId, p_method: method });
    setSettling(null);
    if (settleError) { setError(settleError.message); return; }
    setMessage(`Pay-Later tab settled by ${method}.`);
    setTabs(current => current.map(tab => tab.session_id === sessionId ? { ...tab, outstanding: 0, status: 'CLOSED' } : tab));
    setDetails(current => ({ ...current, [sessionId]: null }));
  }

  async function settleOnline(sessionId: string) {
    if (settling) return;
    setSettling(sessionId); setError(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch('/api/payments/pay-later/create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, idempotencyKey }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not initialize online payment.');
      const RazorpayCtor = (window as unknown as { Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, handler: (payload: unknown) => void) => void } }).Razorpay;
      if (!RazorpayCtor) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.async = true;
          script.onload = () => resolve(); script.onerror = () => reject(new Error('Could not load Razorpay Checkout.'));
          document.body.appendChild(script);
        });
      }
      const ReadyRazorpay = (window as unknown as { Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, handler: (payload: unknown) => void) => void } }).Razorpay;
      if (!ReadyRazorpay) throw new Error('Razorpay Checkout is unavailable.');
      await new Promise<void>((resolve, reject) => {
        const checkout = new ReadyRazorpay({
          key: body.keyId, amount: body.amount, currency: body.currency, order_id: body.razorpayOrderId,
          name: body.restaurantName ?? 'Tablely',
          handler: async (payment: unknown) => {
            try {
              const details = payment as { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
              const verified = await fetch('/api/payments/pay-later/verify', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ attemptId: body.attemptId, attemptToken: body.attemptToken, razorpayPaymentId: details.razorpay_payment_id, razorpayOrderId: details.razorpay_order_id, razorpaySignature: details.razorpay_signature }),
              });
              const result = await verified.json().catch(() => ({}));
              if (!verified.ok) throw new Error(result.error ?? 'Could not verify payment.');
              resolve();
            } catch (error) { reject(error); }
          },
        });
        checkout.on('payment.failed', () => reject(new Error('Online payment failed.')));
        checkout.open();
      });
      setMessage('Pay-Later tab settled online.');
      setTabs(current => current.map(tab => tab.session_id === sessionId ? { ...tab, outstanding: 0, status: 'CLOSED' } : tab));
      setDetails(current => ({ ...current, [sessionId]: null }));
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not settle online.'); }
    finally { setSettling(null); }
  }

  async function joinTab() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !joinCode.trim()) return;
    const { error: joinError } = await supabase.rpc('join_shared_pay_later_tab', { p_join_code: joinCode.trim() });
    if (joinError) { setError(joinError.message); return; }
    setJoinCode(''); setMessage('Joined the shared tab.'); window.location.reload();
  }

  async function copyCode(code: string) {
    try { await navigator.clipboard.writeText(code); setMessage('Code copied.'); } catch { setError('Could not copy the code. Please select it and copy manually.'); }
  }

  async function shareCode(code: string) {
    if (!navigator.share) { setMessage('Copy the code and share it manually.'); return; }
    try { await navigator.share({ title: 'TABLELY shared Pay-Later tab', text: `Join my TABLELY shared Pay-Later tab.\nJoin code: ${code}` }); } catch (shareError) { if (!(shareError instanceof DOMException && shareError.name === 'AbortError')) setMessage('Could not open sharing. You can copy the code instead.'); }
  }

  return <main className="auth-page"><div className="auth-panel" style={{maxWidth:760}}><div className="eyebrow">TABLELY CUSTOMER</div><h1>Your account</h1><p>Manage your profile, follow current orders, and revisit past visits.</p><div className="button-row" style={{ marginTop: 18 }}><Link href="/customer/orders" className="button button-light"><ClipboardList size={14}/> Ongoing orders</Link><Link href="/customer/history" className="button button-light"><History size={14}/> Full history</Link><Link href="/customer/loyalty" className="button button-light"><Gift size={14}/> Loyalty points</Link></div>{error ? <div className="notice notice-error">{error}</div> : null}{message ? <div className="notice notice-success">{message}</div> : null}<section className="customer-checkout-card"><h2><UserRound size={16}/> Profile</h2><p>{profile?.email ?? 'Loading…'}</p><label>Name<input value={name} onChange={e=>setName(e.target.value)}/></label><label>Phone<input value={phone} onChange={e=>setPhone(e.target.value)}/></label><div className="button-row"><button className="button button-primary" onClick={()=>void save()}>Save profile</button><button className="button button-light" onClick={()=>void logout()}>Log out</button></div></section><section className="customer-checkout-card"><h2>Active Pay-Later tabs</h2>{tabs.length ? tabs.map(tab=>{const detail=details[tab.session_id];return <div key={tab.session_id} className="customer-tab-card"><div className="ops-order-meta"><span>{tab.restaurant_name} · Table {tab.table_number} · {tab.role}</span><span><strong>₹{Number(tab.outstanding).toLocaleString('en-IN')}</strong></span></div>{tab.role==='OWNER'&&tab.join_code?<div className="customer-shared-tab"><strong>Shared Pay-Later tab</strong><span>Join code</span><b>{tab.join_code}</b><div className="button-row"><button className="button button-light compact" onClick={()=>void copyCode(tab.join_code!)}><Copy size={14}/> Copy code</button><button className="button button-light compact" onClick={()=>void shareCode(tab.join_code!)}><Share2 size={14}/> Share</button></div></div>:null}<div className="button-row"><button className="button button-light compact" onClick={()=>void loadTabDetail(tab.session_id)}>View tab</button>{tab.role==='OWNER'&&tab.outstanding>0?<><button className="button button-light compact" disabled={settling===tab.session_id} onClick={()=>void settle(tab.session_id,'CASH')}>Cash</button>  <button className="button button-primary compact" disabled={settling===tab.session_id} onClick={()=>void settle(tab.session_id,'UPI')}>UPI</button><button className="button button-primary compact" disabled={settling===tab.session_id} onClick={()=>void settleOnline(tab.session_id)}><CreditCard size={14}/> Pay online</button></>:null}</div>{detail?<div className="customer-tab-detail"><p className="muted-small">{detail.members.length} member{detail.members.length===1?'':'s'} · {detail.status}</p>{detail.members.map(member=><div className="ops-order-meta" key={member.customer_profile_id}><span>{member.name} · {member.role}</span></div>)}{detail.orders.map(order=><div className="ops-order-meta" key={order.order_id}><span>#{order.order_number} · {order.customer_name} · {order.status}</span><strong>₹{Number(order.total).toLocaleString('en-IN')} · {order.payment_status}</strong></div>)}</div>:null}</div>}) : <p className="muted-small">No active tabs.</p>}<div className="button-row"><input value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())} placeholder="Shared tab join code"/><button className="button button-light" onClick={()=>void joinTab()}>Join existing tab</button></div></section><section className="customer-checkout-card"><h2>Recent order history</h2>{history.length ? history.slice(0, 5).map(row=><div className="ops-order-meta" key={row.order_id}><span>#{row.order_number} · {row.restaurant_name} · {new Date(row.created_at).toLocaleDateString()}</span><strong>₹{Number(row.total).toLocaleString('en-IN')} · {row.status}</strong></div>) : <p className="muted-small">No authenticated orders yet.</p>}{history.length > 5 ? <Link href="/customer/history" className="customer-back" style={{ marginTop: 14 }}>View all history</Link> : null}</section></div></main>;
}
