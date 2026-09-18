'use client';

import { RefreshCw, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

type Review = { id: string; order_id: string; rating: number; comment: string | null; created_at: string; order_number: number | null; customer_name: string | null };

export default function ReviewsPage() {
  const [rows, setRows] = useState<Review[]>([]);
  const [branchName, setBranchName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    const context = await getCurrentRestaurantContext(supabase);
    if (!context.data) { setError(context.error?.message ?? 'Workspace not found.'); setLoading(false); return; }
    setBranchName(context.data.branch.name);
    const { data, error: reviewError } = await supabase
      .from('restaurant_reviews')
      .select('id,order_id,rating,comment,created_at,orders(order_number,customer_name)')
      .eq('branch_id', context.data.branch.id)
      .order('created_at', { ascending: false }).limit(200);
    if (reviewError) setError(reviewError.message);
    else setRows((data ?? []).map((row) => {
      const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
      return { ...row, order_number: order?.order_number ?? null, customer_name: order?.customer_name ?? null } as Review;
    }));
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  const average = rows.length ? rows.reduce((sum, row) => sum + Number(row.rating), 0) / rows.length : 0;
  const stars = (rating: number) => <span className="review-stars" aria-label={`${rating} out of 5 stars`}>{Array.from({ length: 5 }, (_, index) => <Star key={index} size={16} fill={index < rating ? 'currentColor' : 'none'} strokeWidth={index < rating ? 1.5 : 1.25} />)}</span>;
  return <StudioShell><SectionHeader eyebrow="CUSTOMER VOICE" title="Reviews" description={`${branchName} · feedback from served and completed paid orders`} action={<button className="button button-light" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={15}/> Refresh</button>} />
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <div className="metric-grid"><div className="metric-card"><div className="metric-head"><span>Average rating</span><Star size={16}/></div><strong>{average ? average.toFixed(1) : '—'}</strong><small>out of 5</small></div><div className="metric-card"><div className="metric-head"><span>Total reviews</span><Star size={16}/></div><strong>{rows.length}</strong><small>customer responses</small></div></div>
    <section className="surface-card"><div className="card-heading"><div><h2>Recent reviews</h2><p>One review per eligible customer order.</p></div></div>{loading ? <p className="muted-small">Loading reviews…</p> : rows.length ? <div className="data-table"><div className="data-row data-head"><span>Customer</span><span>Rating</span><span>Feedback</span><span>Date</span></div>{rows.map(row => <div className="data-row review-row" key={row.id}><div><strong>{row.customer_name || 'Customer'}</strong><span>Order #{row.order_number ?? '—'}</span></div><div>{stars(Number(row.rating))}<small className="review-rating-number">{Number(row.rating).toFixed(1)}</small></div><span>{row.comment || 'No written feedback.'}</span><span>{new Date(row.created_at).toLocaleDateString('en-IN')}</span></div>)}</div> : <p className="muted-small">No reviews yet.</p>}</section>
  </StudioShell>;
}
