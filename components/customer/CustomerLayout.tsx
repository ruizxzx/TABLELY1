'use client';

import Link from 'next/link';
import { ArrowLeft, ShoppingBag, MoreHorizontal, X, Droplets, ReceiptText, RefreshCcw, UserRound, Utensils, ClipboardList, History, LogIn, CircleUserRound, MessageSquare } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cartStorageKey, createServiceRequest, formatMoney, getOrCreateDeviceToken, getOrCreateVisitToken, readCart, readVisitToken, startNewVisit, type CartItem } from '@/lib/customer';
import { useEffect, useState } from 'react';
import { FeedbackForm } from '@/components/FeedbackForm';
import { Copy, Share2, Users } from 'lucide-react';

export function CustomerFrame({
  restaurantName,
  tableNumber,
  tableCode,
  restaurantSlug,
  children,
}: {
  restaurantName: string;
  tableNumber: number;
  tableCode: string;
  restaurantSlug: string;
  children: ReactNode;
}) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [serviceBusy, setServiceBusy] = useState<string | null>(null);
  const [serviceMessage, setServiceMessage] = useState<string | null>(null);
  const [brand, setBrand] = useState<{logo_url:string|null;primary_color:string;secondary_color:string;accent_color:string;customer_theme:string;menu_header:string|null} | null>(null);
  const [customerSignedIn, setCustomerSignedIn] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [sharedTab, setSharedTab] = useState<{ join_code: string; status: string } | null>(null);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [sharedMessage, setSharedMessage] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setCart(readCart(tableCode));
    const onStorage=(event:StorageEvent)=>{
      if(event.storageArea!==window.localStorage || event.key!==cartStorageKey(tableCode)) return;
      sync();
    };
    sync();
    window.addEventListener('storage', onStorage);
    window.addEventListener('tablely-cart-change', sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('tablely-cart-change', sync);
    };
  }, [tableCode]);

  useEffect(() => {
    let cancelled = false;
    const loadSharedTab = async () => {
      const { getSupabaseBrowserClient } = await import('@/lib/supabase');
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data } = await supabase.rpc('get_my_active_pay_later_sessions');
      const row = (data ?? []).find((item: { table_number?: number; role?: string; join_code?: string | null }) => item.table_number === tableNumber && item.role === 'OWNER' && item.join_code);
      if (!cancelled && row) setSharedTab({ join_code: row.join_code, status: row.status });
    };
    void loadSharedTab();
    return () => { cancelled = true; };
  }, [tableNumber]);

  async function createSharedTab() {
    const { getSupabaseBrowserClient } = await import('@/lib/supabase');
    const supabase = getSupabaseBrowserClient();
    if (!supabase || sharedBusy) return;
    setSharedBusy(true); setSharedMessage(null);
    const { data, error } = await supabase.rpc('create_shared_pay_later_tab', {
      p_table_code: tableCode,
      p_session_token: readVisitToken(tableCode),
      p_device_token: getOrCreateDeviceToken(),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error) setSharedMessage(error.message.includes('Authentication') ? 'Sign in as a TABLELY customer to create a shared tab.' : error.message);
    else if (row?.join_code) { setSharedTab({ join_code: row.join_code, status: row.session?.status ?? 'ACTIVE' }); setSharedMessage('Shared tab created.'); }
    setSharedBusy(false);
  }

  async function copySharedCode() {
    if (!sharedTab) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(sharedTab.join_code);
      else { const input = document.createElement('textarea'); input.value = sharedTab.join_code; document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove(); }
      setSharedMessage('Code copied.');
    } catch { setSharedMessage('Could not copy the code. Please select and copy it manually.'); }
  }

  async function shareSharedCode() {
    if (!sharedTab) return;
    if (!navigator.share) { setSharedMessage('Copy the code and share it manually.'); return; }
    try { await navigator.share({ title: 'TABLELY shared Pay-Later tab', text: `Join my TABLELY shared Pay-Later tab.\nJoin code: ${sharedTab.join_code}` }); } catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; setSharedMessage('Could not open sharing. You can copy the code instead.'); }
  }

  useEffect(() => {
    let cancelled = false;
    const loadCustomer = async () => {
      const { getSupabaseBrowserClient } = await import('@/lib/supabase');
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.auth.getUser();
      if (!cancelled) setCustomerSignedIn(Boolean(data.user));
    };
    void loadCustomer();
    return () => { cancelled = true; };
  }, []);

  // Build 19.1 — opening the QR page only establishes a LOCAL visit context.
  // No table session is created until the customer actually places an order, so
  // a scan never occupies the table and never leaves a stray session behind.
  useEffect(() => { getOrCreateVisitToken(tableCode); }, [tableCode]);

  useEffect(() => {
    let cancelled = false;
    const loadBrand = async () => {
      const { getSupabaseBrowserClient } = await import('@/lib/supabase');
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.rpc('get_public_brand_profile', { p_table_code: tableCode });
      const row = Array.isArray(data) ? data[0] : data;
      if (!cancelled && row) setBrand(row as typeof brand);
    };
    void loadBrand();
    return () => { cancelled = true; };
  }, [tableCode]);

  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  return (
    <main className="customer-page" style={{'--customer-primary': brand?.primary_color ?? '#111111', '--customer-secondary': brand?.secondary_color ?? '#f5f5f5', '--customer-accent': brand?.accent_color ?? '#ee7c30'} as CSSProperties}>
      <header className="customer-header">
        <div className="customer-header-inner">
          <div>
            <div className="customer-brand">{brand?.logo_url ? <img src={brand.logo_url} alt="" /> : 'Tablely'}</div>
            <strong>{restaurantName}</strong>
            <span>{brand?.menu_header || `Table ${tableNumber}`}</span>
          </div>
          <div className="customer-header-actions"><button type="button" className="customer-more-button" aria-label="Table services" onClick={() => { setMoreOpen(v => !v); setServiceMessage(null); }}><MoreHorizontal size={19}/></button>{count > 0 ? <Link href={`/r/${restaurantSlug}/table/${tableCode}/cart`} className="customer-cart-pill"><ShoppingBag size={17}/><span>{count}</span><b>{formatMoney(total)}</b></Link> : null}</div>
        </div>
        <nav className="customer-nav" aria-label="Customer navigation">
          <Link href={`/r/${restaurantSlug}/table/${tableCode}`} className="customer-secondary-button"><Utensils size={14}/> Menu</Link>
          <Link href="/customer/orders" className="customer-secondary-button"><ClipboardList size={14}/> Orders</Link>
          <Link href="/customer/history" className="customer-secondary-button"><History size={14}/> History</Link>
          {customerSignedIn ? <Link href="/customer/account" className="customer-secondary-button"><CircleUserRound size={14}/> Profile</Link> : <><Link href={`/customer/login?next=${encodeURIComponent(`/r/${restaurantSlug}/table/${tableCode}`)}`} className="customer-secondary-button"><LogIn size={14}/> Sign in</Link><Link href={`/customer/signup?next=${encodeURIComponent(`/r/${restaurantSlug}/table/${tableCode}`)}`} className="customer-secondary-button">Sign up</Link></>}
        </nav>
      </header>
      {moreOpen ? <div className="customer-service-panel"><div className="customer-service-head"><strong>Table services</strong><button type="button" className="icon-button" onClick={() => setMoreOpen(false)}><X size={16}/></button></div>{serviceMessage?<div className="notice notice-success">{serviceMessage}</div>:null}{sharedMessage?<div className="notice notice-info">{sharedMessage}</div>:null}<button disabled={sharedBusy} onClick={()=>void createSharedTab()}><Users size={16}/> {sharedBusy?'Creating shared tab…':'Create shared Pay-Later tab'}</button>{sharedTab?<div className="customer-shared-tab"><strong>Shared Pay-Later tab</strong><span>Status: {sharedTab.status}</span><b>{sharedTab.join_code}</b><div className="button-row"><button className="button button-light compact" onClick={()=>void copySharedCode()}><Copy size={14}/> Copy code</button><button className="button button-light compact" onClick={()=>void shareSharedCode()}><Share2 size={14}/> Share</button></div></div>:null}<button disabled={Boolean(serviceBusy)} onClick={async()=>{setServiceBusy('WAITER');try{await createServiceRequest({tableCode,type:'WAITER'});setServiceMessage('Waiter requested.')}catch(e){setServiceMessage(e instanceof Error?e.message:'Could not send request.')}finally{setServiceBusy(null)}}}><UserRound size={16}/> Request waiter</button><button disabled={Boolean(serviceBusy)} onClick={async()=>{setServiceBusy('WATER');try{await createServiceRequest({tableCode,type:'WATER'});setServiceMessage('Water requested.')}catch(e){setServiceMessage(e instanceof Error?e.message:'Could not send request.')}finally{setServiceBusy(null)}}}><Droplets size={16}/> Need water</button><button disabled={Boolean(serviceBusy)} onClick={async()=>{setServiceBusy('BILL');try{await createServiceRequest({tableCode,type:'BILL'});setServiceMessage('Bill requested.')}catch(e){setServiceMessage(e instanceof Error?e.message:'Could not send request.')}finally{setServiceBusy(null)}}}><ReceiptText size={16}/> Request bill</button><button disabled={Boolean(serviceBusy)} onClick={()=>{if(!window.confirm('Start a new visit? This clears the cart and any applied coupon on this device. Orders already placed are not affected.'))return;startNewVisit(tableCode);setServiceMessage('New visit started on this table.')}}><RefreshCcw size={16}/> Start new visit</button><button onClick={()=>{setMoreOpen(false);setFeedbackOpen(true)}}><MessageSquare size={16}/> Report a problem / suggest an idea</button></div> : null}
      {feedbackOpen?<FeedbackForm source="CUSTOMER" tableCode={tableCode} onClose={()=>setFeedbackOpen(false)}/>:null}
      {children}
    </main>
  );
}

export function CustomerBack({ href, label = 'Back' }: { href: string; label?: string }) {
  return <Link href={href} className="customer-back"><ArrowLeft size={15} /> {label}</Link>;
}
