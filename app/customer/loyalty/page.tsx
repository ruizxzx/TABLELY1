'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Gift, History, RefreshCw } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Transaction = {
  id: string;
  type: string;
  points: number;
  amount: number | null;
  createdAt: string;
  expiresAt: string | null;
};

type Wallet = {
  organizationId: string;
  restaurantName: string;
  enabled: boolean;
  availablePoints: number;
  currencyPerPoint: number;
  pointsPerCurrency: number;
  minimumRedemptionPoints: number;
  pointsExpireDays: number | null;
  enrolled: boolean;
  earnedPoints: number;
  redeemedPoints: number;
  transactions: Transaction[];
};

export default function CustomerLoyaltyPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingOrganizationId, setSavingOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) {
      setError('Could not verify your customer account.');
      setLoading(false);
      return;
    }
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      window.location.href = '/customer/login?next=/customer/loyalty';
      return;
    }

    try {
      const response = await fetch('/api/customer/loyalty', {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load loyalty accounts.');
      setWallets((result.wallets ?? []) as Wallet[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load loyalty accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  async function updateEnrollment(wallet: Wallet, enrolled: boolean) {
    setSavingOrganizationId(wallet.organizationId);
    setError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error: sessionError } = await supabase?.auth.getSession() ?? { data: null, error: null };
      if (sessionError) throw new Error('Could not verify your customer account.');
      const accessToken = data?.session?.access_token;
      if (!accessToken) {
        window.location.href = '/customer/login?next=/customer/loyalty';
        return;
      }
      const response = await fetch('/api/customer/loyalty', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ organizationId: wallet.organizationId, enrolled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not update loyalty enrollment.');
      await load();
    } catch (enrollmentError) {
      setError(enrollmentError instanceof Error ? enrollmentError.message : 'Could not update loyalty enrollment.');
    } finally {
      setSavingOrganizationId(null);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="auth-page">
      <div className="auth-panel" style={{ maxWidth: 760 }}>
        <div className="eyebrow">TABLELY CUSTOMER</div>
        <h1>Your loyalty</h1>
        <p>Points are kept separate for each restaurant and are based on its recorded loyalty ledger.</p>
        <div className="button-row" style={{ marginTop: 18 }}>
          <Link href="/customer/account" className="button button-light"><History size={14} /> Account</Link>
          <button className="button button-light" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> Refresh</button>
        </div>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        {loading ? <p className="muted-small">Loading your loyalty accounts…</p> : wallets.length ? wallets.map((wallet) => (
          <section className="customer-checkout-card" key={wallet.organizationId}>
            <div className="ops-order-meta">
              <span><Gift size={15} /> {wallet.restaurantName}</span>
              <strong>{wallet.availablePoints.toLocaleString()} points</strong>
            </div>
            <p className="muted-small">
              {wallet.enabled ? 'Program active' : 'Program currently inactive'}
              {wallet.pointsPerCurrency > 0 ? ` · Earn ${wallet.pointsPerCurrency} point${wallet.pointsPerCurrency === 1 ? '' : 's'} per ₹1 eligible spend` : ''}
              {wallet.currencyPerPoint > 0 ? ` · Estimated value ₹${(wallet.availablePoints * wallet.currencyPerPoint).toFixed(2)}` : ''}
              {wallet.pointsExpireDays ? ` · New points expire after ${wallet.pointsExpireDays} days` : ''}
            </p>
            {wallet.enabled ? <div className="customer-loyalty-consent">
              {wallet.enrolled ? <>
                <p className="muted-small">You are enrolled. Eligible future orders linked to your signed-in customer account can earn points. Guest orders are not automatically linked.</p>
                <button className="button button-light compact" disabled={savingOrganizationId === wallet.organizationId} onClick={() => void updateEnrollment(wallet, false)}>
                  {savingOrganizationId === wallet.organizationId ? 'Updating…' : 'Leave this program'}
                </button>
              </> : <>
                <p className="muted-small">By joining, you agree that this restaurant may associate eligible future orders linked to your signed-in customer account with this restaurant-specific points balance. Enrollment does not link guest visits or enable checkout redemption.</p>
                <button className="button button-primary compact" disabled={savingOrganizationId === wallet.organizationId} onClick={() => void updateEnrollment(wallet, true)}>
                  {savingOrganizationId === wallet.organizationId ? 'Joining…' : 'Join this rewards program'}
                </button>
              </>}
            </div> : <p className="muted-small">Enrollment is unavailable while this program is inactive.</p>}
            <div className="orders-summary"><span>Points earned</span><strong>{wallet.earnedPoints.toLocaleString()}</strong></div>
            <div className="orders-summary"><span>Points redeemed</span><strong>{wallet.redeemedPoints.toLocaleString()}</strong></div>
            <h2 style={{ marginTop: 18 }}>Recent activity</h2>
            {wallet.transactions.length ? wallet.transactions.map((transaction) => (
              <div className="ops-order-meta" key={transaction.id}>
                <span>{transaction.type.replaceAll('_', ' ')} · {new Date(transaction.createdAt).toLocaleDateString()}</span>
                <strong>{transaction.points > 0 ? '+' : ''}{transaction.points.toLocaleString()}</strong>
              </div>
            )) : <p className="muted-small">No points activity yet.</p>}
            <p className="muted-small">Points redemption at checkout is not available yet.</p>
          </section>
        )) : !error ? (
          <section className="customer-empty-card">
            <p>No loyalty points are associated with this customer account yet. Guest visits are not automatically merged into this account.</p>
            <Link href="/" className="button button-primary">Browse restaurants</Link>
          </section>
        ) : null}
      </div>
    </main>
  );
}
