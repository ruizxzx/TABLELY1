"use client";

import Link from 'next/link';
import { getProductPath } from '../../../lib/public-paths';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '../../../lib/supabase';
import { removeStorageFiles, uploadProductFile, uploadStoreMedia, publicMediaUrl } from '../../../lib/storage';
import { validateCoverFile, validateDigitalFile, validateDigitalLink } from '../../../lib/products';
import { planLimitMessage } from '../../../lib/entitlements';
import AdvancedProductPanel from '../../../components/AdvancedProductPanel';

const productTypes = ['Course', 'Template', 'Guide', 'Preset', 'Asset', 'E-book', 'Other'];
const ACCEPT_DIGITAL = '.pdf,.zip,.epub,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.mp4,.webm,.mp3,.wav,.png,.jpg,.jpeg,.webp,.gif,.txt';

export default function EditProduct() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [product, setProduct] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [compareAtPrice, setCompareAtPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<any[]>([]);
  const [productType, setProductType] = useState('Course');
  const [license, setLicense] = useState('');
  const [refundPolicy, setRefundPolicy] = useState('');
  const [status, setStatus] = useState<'draft'|'live'|'archived'>('draft');
  const [cover, setCover] = useState<File | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<File | null>(null);
  const [deliveryType, setDeliveryType] = useState<'upload'|'link'>('upload');
  const [fileAccessUrl, setFileAccessUrl] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [scheduledPublishAt, setScheduledPublishAt] = useState('');
  const [maxPurchases, setMaxPurchases] = useState('');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [downloadExpiryDays, setDownloadExpiryDays] = useState('30');
  const [requiresLicenseKey, setRequiresLicenseKey] = useState(false);
  const [licenseTerms, setLicenseTerms] = useState('');

  useEffect(() => {
    if (!supabase || !id) return;
    async function load() {
      setLoading(true);
      const { data: { user } } = await supabase!.auth.getUser();
      if (!user) { setMessage('Your session has expired. Please log in again.'); setLoading(false); return; }
      const { data: store } = await supabase!.from('stores').select('id').eq('owner_id', user.id).maybeSingle();
      if (!store) { setMessage('Create your store first.'); setLoading(false); return; }
      const [{ data, error }, { data: cats }, { data: storeMeta }] = await Promise.all([
        supabase!.from('products').select('id,store_id,title,slug,short_description,description,price,compare_at_price,currency,category,category_id,cover_image_path,file_path,file_access_url,digital_delivery_type,preview_file_path,product_type,license,refund_policy,status,visibility,scheduled_publish_at,max_purchases,max_downloads,download_expiry_days,requires_license_key,license_terms,created_at,updated_at,published_at,plan_archived').eq('id', id).eq('store_id', store.id).maybeSingle(),
        supabase!.from('store_categories').select('id,name,slug,status,is_visible').eq('store_id', store.id).order('sort_order',{ascending:true}).order('created_at',{ascending:true}),
        supabase!.from('stores').select('username').eq('id', store.id).maybeSingle(),
      ]);
      if (error || !data) { setMessage('Product not found.'); setLoading(false); return; }
      setCategories(cats || []);
      setCategoryId(data.category_id ?? '');
      setProduct({ ...data, store_username: storeMeta?.username ?? null });
      setTitle(data.title ?? '');
      setShortDescription(data.short_description ?? '');
      setDescription(data.description ?? '');
      setPrice(String(data.price ?? ''));
      setCompareAtPrice(data.compare_at_price == null ? '' : String(data.compare_at_price));
      setProductType(data.product_type ?? 'Course');
      setLicense(data.license ?? '');
      setRefundPolicy(data.refund_policy ?? '');
      setStatus(data.status);
      setDeliveryType(data.digital_delivery_type === 'link' ? 'link' : 'upload');
      setFileAccessUrl(data.file_access_url ?? '');
      setScheduledPublishAt(data.scheduled_publish_at ? new Date(data.scheduled_publish_at).toISOString().slice(0,16) : '');
      setMaxPurchases(data.max_purchases == null ? '' : String(data.max_purchases));
      setMaxDownloads(data.max_downloads == null ? '' : String(data.max_downloads));
      setDownloadExpiryDays(String(data.download_expiry_days ?? 30));
      setRequiresLicenseKey(Boolean(data.requires_license_key));
      setLicenseTerms(data.license_terms ?? '');
      setLoading(false);
    }
    void load();
  }, [id]);

  const coverError = useMemo(() => validateCoverFile(cover), [cover]);
  const fileError = useMemo(() => validateDigitalFile(file), [file]);
  const previewError = useMemo(() => validateDigitalFile(preview), [preview]);
  const linkError = useMemo(() => deliveryType === 'link' ? validateDigitalLink(fileAccessUrl) : null, [deliveryType, fileAccessUrl]);

  async function removeCurrentFile() {
    if (!supabase || !product?.file_path) return;
    if (!window.confirm('Remove the current digital file? The product will become a draft.')) return;
    setSaving(true); setMessage('Removing digital file…');
    try {
      const { error } = await supabase.from('products').update({ file_path: null, digital_delivery_type: 'upload', status: 'draft', published_at: null, updated_at: new Date().toISOString() }).eq('id', product.id);
      if (error) throw error;
      try { await removeStorageFiles('product-files', [product.file_path]); } catch {}
      setProduct({ ...product, file_path: null, digital_delivery_type: 'upload', status: 'draft', published_at: null, plan_archived: false, plan_archived_at: null });
      setDeliveryType('upload'); setFileAccessUrl(''); setStatus('draft'); setMessage('Digital file removed.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not remove file.'); }
    finally { setSaving(false); }
  }

  async function removePreview() {
    if (!supabase || !product?.preview_file_path) return;
    if (!window.confirm('Remove the current preview file?')) return;
    setSaving(true); setMessage('Removing preview…');
    try {
      const { error } = await supabase.from('products').update({ preview_file_path: null, updated_at: new Date().toISOString() }).eq('id', product.id);
      if (error) throw error;
      try { await removeStorageFiles('product-files', [product.preview_file_path]); } catch {}
      setProduct({ ...product, preview_file_path: null }); setMessage('Preview removed.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not remove preview.'); }
    finally { setSaving(false); }
  }

  async function save(forcedStatus?: 'live'|'draft') {
    setMessage('');
    if (!supabase || !product) return;
    const publishRequested = forcedStatus === 'live';
    const productWasLive = product.status === 'live';
    const reviewStatus = 'draft';
    if (!title.trim()) return setMessage('Product title is required.');
    const amount = Number(price);
    if (!Number.isFinite(amount) || amount < 0) return setMessage('Enter a valid price.');
    if (compareAtPrice && (!Number.isFinite(Number(compareAtPrice)) || Number(compareAtPrice) < 0)) return setMessage('Enter a valid compare-at price.');
    const deliveryValidationError = coverError || fileError || previewError || (deliveryType === 'link' && (publishRequested || fileAccessUrl.trim()) ? linkError : null);
    if (deliveryValidationError) return setMessage(deliveryValidationError);
    if (!categoryId) return setMessage('Choose a category before saving.');
    if (publishRequested && deliveryType === 'upload' && !file && !product.file_path) return setMessage('A digital file is required before admin review.');
    if (publishRequested && deliveryType === 'link' && linkError) return setMessage(linkError);
    setSaving(true); setProgress('Saving product…');
    let newCover: string | null = null;
    let newFile: string | null = null;
    let newPreview: string | null = null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Please log in again.');
      if (cover) { setProgress('Uploading cover…'); newCover = await uploadStoreMedia(user.id, product.id, cover); }
      if (file && deliveryType === 'upload') { setProgress('Uploading digital file…'); newFile = await uploadProductFile(user.id, product.id, file); }
      if (preview) { setProgress('Uploading preview…'); newPreview = await uploadProductFile(user.id, `${product.id}/preview`, preview); }
      const categoryName = categories.find((c) => c.id === categoryId)?.name || product.category || '';
      const statusChanged = reviewStatus !== product.status;
      const next = {
        title: title.trim(), short_description: shortDescription.trim() || null, description: description.trim() || null,
        price: Math.round(amount), compare_at_price: compareAtPrice ? Math.round(Number(compareAtPrice)) : null,
        category: categoryName.trim() || null, category_id: categoryId, digital_delivery_type: deliveryType,
        file_access_url: deliveryType === 'link' ? fileAccessUrl.trim() : null, product_type: productType,
        visibility: 'private',
        license: license.trim() || null, refund_policy: refundPolicy.trim() || null, status: reviewStatus,
        scheduled_publish_at: scheduledPublishAt ? new Date(scheduledPublishAt).toISOString() : null,
        max_purchases: maxPurchases ? Math.max(1, Math.round(Number(maxPurchases))) : null,
        max_downloads: maxDownloads ? Math.max(1, Math.round(Number(maxDownloads))) : null,
        download_expiry_days: Math.min(3650, Math.max(1, Math.round(Number(downloadExpiryDays || 30)))),
        requires_license_key: requiresLicenseKey, license_terms: licenseTerms.trim() || null,
        published_at: null,
        cover_image_path: newCover ?? product.cover_image_path,
        file_path: deliveryType === 'upload' ? (newFile ?? product.file_path) : null,
        preview_file_path: newPreview ?? product.preview_file_path,
        updated_at: new Date().toISOString(),
        plan_archived: product.plan_archived === true && !statusChanged ? true : false,
        plan_archived_at: product.plan_archived === true && !statusChanged ? product.plan_archived_at : null,
      };
      const { error } = await supabase.from('products').update(next).eq('id', product.id);
      if (error) throw error;
      if (publishRequested) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('Your session has expired. Please log in again.');
        const reviewResponse = await fetch(`/api/products/${encodeURIComponent(product.id)}/submit`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const reviewPayload = await reviewResponse.json().catch(() => ({}));
        if (!reviewResponse.ok) throw new Error(reviewPayload.error || 'Could not submit product for admin review.');
      }
      if (newCover && product.cover_image_path) { try { await removeStorageFiles('store-media', [product.cover_image_path]); } catch {} }
      if (newFile && product.file_path) { try { await removeStorageFiles('product-files', [product.file_path]); } catch {} }
      if (newPreview && product.preview_file_path) { try { await removeStorageFiles('product-files', [product.preview_file_path]); } catch {} }
      setProduct({ ...product, ...next }); setCover(null); setFile(null); setPreview(null); setProgress(null);
      setMessage(productWasLive
        ? 'Changes saved. The product has been moved back to draft and must be re-approved before it can go live again.'
        : publishRequested
          ? 'Saved and submitted for admin approval. The product remains hidden until it is approved.'
          : 'Saved successfully.');
    } catch (error) {
      if (newCover) { try { await removeStorageFiles('store-media', [newCover]); } catch {} }
      if (newFile) { try { await removeStorageFiles('product-files', [newFile]); } catch {} }
      if (newPreview) { try { await removeStorageFiles('product-files', [newPreview]); } catch {} }
      setProgress(null); setMessage(planLimitMessage(error instanceof Error ? error.message : 'Could not save product.'));
    } finally { setSaving(false); }
  }

  async function setVisibility(nextStatus: 'live'|'draft') {
    if (nextStatus === 'live') {
      setStatus('draft');
      setMessage('This product must be approved by an admin before it can go live.');
      await save('live');
      return;
    }
    setStatus('draft');
    await save('draft');
  }

  async function removeProduct() {
    if (!supabase || !product) return;
    if (!window.confirm(`Remove “${product.title}”? Products with order history will be archived instead of deleted.`)) return;
    setDeleting(true); setMessage('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Your session has expired. Please log in again.');
      const response = await fetch(`/api/products/${encodeURIComponent(product.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not remove product.');
      router.push('/studio/products');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not remove product.');
    } finally { setDeleting(false); }
  }

  if (loading) return <div className="studio-content"><div className="loading-card card">Loading product…</div></div>;
  if (!product) return <div className="studio-content"><div className="card panel error-box">{message || 'Product not found.'}</div></div>;
  const coverUrl = publicMediaUrl(product.cover_image_path);
  const currentDelivery = deliveryType === 'link' ? 'Cloud / external link' : (product.file_path ? 'Uploaded file' : 'No delivery file');

  return <div className="studio-content">
    <div className="page-title"><div><div className="eyebrow">PRODUCT ENGINE</div><h1>Edit product</h1><p>Update content, pricing, files and publication state without leaving Studio.</p></div><div className="row-actions"><Link className="btn" href={product.store_username ? getProductPath(product.store_username, product.slug) : '/studio/store'}>Preview page</Link><Link className="btn" href="/studio/products">Back</Link></div></div>
    <div className="product-editor-grid">
      <div className="card panel"><div className="section-label">01 · PRODUCT INFORMATION</div>
        {coverUrl ? <img src={coverUrl} alt="" className="editor-cover" /> : <div className="editor-cover placeholder-cover" />}
        <label className="label">Product title *</label><input className="input" value={title} onChange={e=>setTitle(e.target.value)} maxLength={120}/>
        <label className="label">Short description</label><input className="input" value={shortDescription} onChange={e=>setShortDescription(e.target.value)} maxLength={180}/>
        <label className="label">Full description</label><textarea className="input textarea-lg" value={description} onChange={e=>setDescription(e.target.value)} maxLength={10000}/>
        <div className="form-grid-2"><div><label className="label">Type</label><select className="input" value={productType} onChange={e=>setProductType(e.target.value)}>{productTypes.map(x=><option key={x}>{x}</option>)}</select></div><div><label className="label">Category</label><select className="input" value={categoryId} onChange={e=>setCategoryId(e.target.value)}><option value="">Select a category</option>{categories.filter(c=>c.status==='live').map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{!categories.length&&<div className="muted" style={{fontSize:12,marginTop:6}}>Create a category in <Link href="/studio/categories">Categories</Link>.</div>}</div></div>
      </div>
      <div className="card panel"><div className="section-label">02 · PRICING + POLICY</div>
        <div className="form-grid-2"><div><label className="label">Price (INR)</label><input className="input" value={price} onChange={e=>setPrice(e.target.value.replace(/[^0-9]/g,''))}/></div><div><label className="label">Compare-at price</label><input className="input" value={compareAtPrice} onChange={e=>setCompareAtPrice(e.target.value.replace(/[^0-9]/g,''))}/></div></div>
        <label className="label">License</label><input className="input" value={license} onChange={e=>setLicense(e.target.value)}/>
        <label className="label">Refund policy</label><textarea className="input" style={{height:110,paddingTop:13,resize:'vertical'}} value={refundPolicy} onChange={e=>setRefundPolicy(e.target.value)}/>
        <label className="label">Publication status</label><div className="info-note"><b>Review state:</b> {status === 'live' ? 'Live' : status === 'archived' ? 'Archived' : 'Draft pending admin approval'}</div>
        <div className="info-note"><b>Current:</b> {product.status}. {product.plan_archived ? 'Automatically archived after a plan downgrade.' : currentDelivery}.</div>
      </div>
      <div className="card panel"><div className="section-label">03 · DIGITAL DELIVERY + PREVIEW</div>
        <label className="label">Delivery method</label>
        <select className="input" value={deliveryType} onChange={e=>{setDeliveryType(e.target.value as 'upload'|'link');setMessage('')}}><option value="upload">Upload a file</option><option value="link">Add as link</option></select>
        {deliveryType === 'upload' ? <div style={{marginTop:10}}><label className="label">New digital file</label><input className="input" type="file" accept={ACCEPT_DIGITAL} onChange={e=>setFile(e.target.files?.[0] ?? null)}/><p className="muted file-picked">Maximum uploaded digital file size: 100 MB.</p>{product.file_path && <button type="button" className="btn btn-sm" onClick={()=>void removeCurrentFile()} disabled={saving||deleting}>Remove current file</button>}</div> : <div style={{marginTop:10}}><label className="label">Cloud / delivery link *</label><input className="input" type="url" value={fileAccessUrl} onChange={e=>setFileAccessUrl(e.target.value)} placeholder="https://drive.google.com/..."/><p className="muted file-picked">Buyers are redirected to this HTTPS URL after verified payment.</p></div>}
        <div style={{marginTop:16}}><label className="label">Preview file</label><input className="input" type="file" accept={ACCEPT_DIGITAL} onChange={e=>setPreview(e.target.files?.[0] ?? null)}/>{product.preview_file_path && <div className="row-actions" style={{marginTop:10}}><a className="btn btn-sm" target="_blank" rel="noreferrer" href={`/api/products/${encodeURIComponent(product.id)}/preview`}>View preview</a><a className="btn btn-sm" href={`/api/products/${encodeURIComponent(product.id)}/preview?download=1`}>Download preview</a><button type="button" className="btn btn-sm" onClick={()=>void removePreview()} disabled={saving||deleting}>Remove preview</button></div>}</div>
        <div className="info-note" style={{marginTop:16}}>Preview files are public only while the product is live and public. Paid delivery stays protected; link delivery is an external URL supplied by the creator.</div>
      </div>
      <div className="card panel"><div className="section-label">04 · SALES CONTROLS</div>
        <div className="form-grid-2"><div><label className="label">Scheduled publish</label><input className="input" type="datetime-local" value={scheduledPublishAt} onChange={e=>setScheduledPublishAt(e.target.value)}/></div><div><label className="label">Download expiry (days)</label><input className="input" type="number" min="1" max="3650" value={downloadExpiryDays} onChange={e=>setDownloadExpiryDays(e.target.value)}/></div></div>
        <div className="form-grid-2" style={{marginTop:10}}><div><label className="label">Maximum purchases</label><input className="input" type="number" min="1" value={maxPurchases} onChange={e=>setMaxPurchases(e.target.value)} placeholder="Unlimited"/></div><div><label className="label">Maximum downloads</label><input className="input" type="number" min="1" value={maxDownloads} onChange={e=>setMaxDownloads(e.target.value)} placeholder="Unlimited"/></div></div>
        <label className="check-row" style={{marginTop:14}}><input type="checkbox" checked={requiresLicenseKey} onChange={e=>setRequiresLicenseKey(e.target.checked)}/><span><b>Require license key</b><small className="muted">Enable when you are ready to enforce key-based product access.</small></span></label>
        <label className="label">License terms</label><textarea className="input" style={{height:100,paddingTop:13,resize:'vertical'}} value={licenseTerms} onChange={e=>setLicenseTerms(e.target.value)} placeholder="Usage, commercial rights, redistribution rules…"/>
      </div>
      <div className="card panel"><div className="section-label">05 · VARIANTS & VERSIONS</div><AdvancedProductPanel productId={product.id} /></div>
      <div className="card panel sticky-editor"><div className="section-label">06 · ACTIONS</div>
        <div className="publish-preview"><div className="mini-cover" style={coverUrl ? {backgroundImage:`url(${coverUrl})`,backgroundSize:'cover',backgroundPosition:'center'} : undefined}/><div><div className="muted" style={{fontSize:10,textTransform:'uppercase'}}>{categories.find(c=>c.id===categoryId)?.name || 'Digital product'}</div><b>{title}</b><div className="publish-price">₹{Number(price||0).toLocaleString('en-IN')}</div></div></div>
        {progress && <div className="progress-wrap"><div className="progress-bar"><span/></div><div className="muted" style={{fontSize:12}}>{progress}</div></div>}
        {message && <div className={message.includes('Saved') || message.includes('removed') ? 'success-box' : 'error-box'}>{message}</div>}
        <div className="publish-actions"><button className="btn" disabled={saving||deleting} onClick={()=>void save()}>{saving?'Saving…':'Save changes'}</button><button className="btn btn-primary" disabled={saving||deleting} onClick={()=>void setVisibility(status==='live'?'draft':'live')}>{status==='live'?'Set draft':'Submit for approval'}</button></div>
        <button className="danger-action" disabled={saving||deleting} onClick={()=>void removeProduct()}>{deleting?'Deleting…':'Remove product'}</button>
      </div>
    </div>
  </div>;
}
