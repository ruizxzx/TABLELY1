'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

const statusLabels: Record<string, string> = {
  pending: 'Pending admin review',
  verified: 'Approved and live',
  rejected: 'Disapproved',
  action_required: 'Changes requested',
};

export default function ReviewHistory() {
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  async function load() {
    setLoading(true);
    setMessage('');
    try {
      if (!supabase) throw new Error('Supabase is not configured.');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Please sign in again.');
      const response = await fetch('/api/studio/reviews', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load review history.');
      setReviews(payload.data || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load review history.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return <div className="studio-content">
    <div className="page-title">
      <div><div className="eyebrow">PRODUCT REVIEWS</div><h1>Approval history</h1><p>Track every product submission, admin decision, and requested change.</p></div>
      <button className="btn" onClick={() => void load()} disabled={loading}>Refresh</button>
    </div>
    {message && <div className="error-box">{message}</div>}
    {loading ? <div className="card panel">Loading review history...</div> : !reviews.length ? <div className="card panel"><h3>No review requests yet</h3><p className="muted">When you submit a product for approval, its status and admin feedback will appear here.</p><Link className="btn btn-primary" href="/studio/products">View products</Link></div> : <div className="dashboard-grid">{reviews.map((review) => {
      const product = review.product || {};
      const isEditable = review.status === 'rejected' || review.status === 'action_required';
      return <article className="card panel" key={review.id}>
        <div className="panel-head"><div><div className="eyebrow">{review.store?.name || review.store?.username || 'Your store'}</div><h3>{product.title || 'Product'}</h3></div><span className={`status ${review.status === 'verified' ? 'live' : review.status === 'pending' ? 'pending' : 'draft'}`}>{statusLabels[review.status] || review.status}</span></div>
        <div className="form-grid-2" style={{marginTop:14}}><div><span className="muted">Product type</span><b>{product.product_type || 'Digital product'}</b></div><div><span className="muted">Price</span><b>{product.currency || 'INR'} {Number(product.price || 0).toLocaleString('en-IN')}</b></div><div><span className="muted">Submitted</span><b>{review.submitted_at ? new Date(review.submitted_at).toLocaleString() : '—'}</b></div><div><span className="muted">Last updated</span><b>{review.updated_at ? new Date(review.updated_at).toLocaleString() : '—'}</b></div></div>
        {review.review_note ? <div className={review.status === 'rejected' ? 'error-box' : 'info-note'} style={{marginTop:16}}><b>{review.status === 'rejected' ? 'Admin reason' : 'Admin feedback'}</b><p style={{margin:'6px 0 0',whiteSpace:'pre-wrap'}}>{review.review_note}</p></div> : review.status === 'pending' ? <div className="info-note" style={{marginTop:16}}>Your product is waiting for admin review. You can continue editing, but changes require a new submission.</div> : null}
        {review.reviewed_at && <p className="muted" style={{fontSize:12,marginTop:12}}>Reviewed {new Date(review.reviewed_at).toLocaleString()}</p>}
        <div className="row-actions" style={{marginTop:16}}><Link className="btn btn-sm" href={`/studio/products/${review.product_id}`}>{isEditable ? 'Edit and resubmit' : 'Open product'}</Link>{review.status === 'pending' && <span className="muted" style={{fontSize:12}}>Need to correct something? Edit the product, then submit it again for review.</span>}</div>
      </article>;
    })}</div>}
  </div>;
}
