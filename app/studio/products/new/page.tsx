"use client";

import Link from 'next/link';
import { DragEvent, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { removeStorageFiles, uploadProductFile, uploadStoreMedia } from '../../../lib/storage';
import { uniqueSlug, validateCoverFile, validateDigitalFile, validateDigitalLink } from '../../../lib/products';
import { getEffectivePlan } from '../../../lib/entitlements';

const productTypes = ['Course', 'Template', 'Guide', 'Preset', 'Asset', 'E-book', 'Other'];

export default function NewProduct() {
  const [title, setTitle] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [compareAtPrice, setCompareAtPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<any[]>([]);
  const [plan, setPlan] = useState('free');
  const [productCount, setProductCount] = useState(0);
  const [productType, setProductType] = useState('Course');
  const [license, setLicense] = useState('Personal use');
  const [refundPolicy, setRefundPolicy] = useState('Digital products are non-refundable unless required by law.');
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [preview, setPreview] = useState<File | null>(null);
  const [deliveryType, setDeliveryType] = useState<'upload'|'link'>('upload');
  const [fileAccessUrl, setFileAccessUrl] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedStatus, setSavedStatus] = useState<'draft'|'live'>('draft');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !active) return;
      const { data: store } = await supabase.from('stores').select('id').eq('owner_id', user.id).maybeSingle();
      if (!store || !active) return;
      const [{ data: cats }, { data: planRow }, { count }] = await Promise.all([
        supabase.from('store_categories').select('id,name,slug').eq('store_id', store.id).eq('is_visible', true).eq('status','live').order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
        supabase.from('creator_plans').select('plan,access_source,access_starts_at,access_expires_at').eq('creator_id', user.id).maybeSingle(),
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('store_id', store.id),
      ]);
      if (!active) return;
      const nextCats = cats || [];
      setCategories(nextCats);
      setPlan(getEffectivePlan(planRow));
      setProductCount(count || 0);
      if (!categoryId && nextCats[0]) setCategoryId(nextCats[0].id);
    })();
    return () => { active = false; };
  }, [categoryId]);

  const coverError = useMemo(() => validateCoverFile(cover), [cover]);
  const fileError = useMemo(() => validateDigitalFile(file), [file]);
  const previewError = useMemo(() => validateDigitalFile(preview), [preview]);
  const linkError = useMemo(() => deliveryType === 'link' ? validateDigitalLink(fileAccessUrl) : null, [deliveryType, fileAccessUrl]);

  function pickFile(next: File | null, kind: 'cover' | 'file' | 'preview') {
    if (kind === 'cover') setCover(next);
    else if (kind === 'file') setFile(next);
    else setPreview(next);
    setMessage('');
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, kind: 'cover' | 'file' | 'preview') {
    event.preventDefault();
    pickFile(event.dataTransfer.files?.[0] ?? null, kind);
  }

  async function saveProduct(publish: boolean) {
    setMessage('');
    if (!supabase) return setMessage('Supabase is not configured.');
    if (!title.trim()) return setMessage('Add a product title.');
    const amount = Math.round(Number(price));
    if (!Number.isFinite(amount) || amount < 0) return setMessage('Enter a valid INR price.');
    if (compareAtPrice && (!Number.isFinite(Number(compareAtPrice)) || Number(compareAtPrice) < 0)) return setMessage('Enter a valid compare-at price.');
    const deliveryValidationError = coverError || fileError || previewError || (deliveryType === 'link' && (publish || fileAccessUrl.trim()) ? linkError : null);
    if (deliveryValidationError) return setMessage(deliveryValidationError || 'Please fix the selected files.');
    if (!categoryId) return setMessage('Choose a category before saving this product.');
    if (publish && deliveryType === 'upload' && !file) return setMessage('A digital file is required before publishing.');
    if (publish && deliveryType === 'link' && linkError) return setMessage(linkError);
    setPublishing(true);
    setProgress('Preparing…');
    const uploadedPaths: { bucket: string; path: string }[] = [];
    let productNd: string | null = null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Your session has expired. Please log in again.');
      const { data: store, error: storeError } = await supabase.from('stores').select('id').eq('owner_id', user.id).maybeSingle();
      if (storeError) throw storeError;
      if (!store) throw new Error('Create your store before adding products.');
      const slug = await uniqueSlug(store.id, title);

      // Generate the row first because etorage policies intentionally bind files to the creator/product ND.
      // Nf anything after this fails, the catch block removes the partially-created product.
      const { data: product, error: insertError } = await supabase.from('products').insert({
        store_id: store.id,
        title: title.trim(),
        slug,
        short_description: shortDescription.trim() || null,
        description: description.trim() || null,
        price: amount,
        compare_at_price: compareAtPrice ? Math.round(Number(compareAtPrice)) : null,
        currency: 'INR',
        category: (categories.find((c) => c.id === categoryId)?.name || '').trim() || null,
        category_id: categoryId,
        digital_delivery_type: deliveryType,
        file_access_url: deliveryType === 'link' ? fileAccessUrl.trim() : null,
        product_type: productType,
        license: license.trim() || null,
        refund_policy: refundPolicy.trim() || null,
        // Always create the row as a draft. The entitlement trigger requires delivery
        // configuration before a product can become live. Publishing happens only after uploads finish.
        status: 'draft',
        visibility: 'public',
        published_at: null,
      }).select('id').single();
      if (insertError) throw insertError;
      productNd = product.id;

      let coverPath: string | null = null;
      let filePath: string | null = null;
      let previewPath: string | null = null;

      if (cover) {
        setProgress('Uploading cover image…');
        coverPath = await uploadStoreMedia(user.id, product.id, cover);
        uploadedPaths.push({ bucket: 'store-media', path: coverPath });
      }
      if (file && deliveryType === 'upload') {
        setProgress('Uploading digital file…');
        filePath = await uploadProductFile(user.id, product.id, file);
        uploadedPaths.push({ bucket: 'product-files', path: filePath });
      }
      if (preview) {
        setProgress('Uploading preview…');
        previewPath = await uploadProductFile(user.id, `${product.id}/preview`, preview);
        uploadedPaths.push({ bucket: 'product-files', path: previewPath });
      }

      setProgress('Finalizing product…');
      const { error: updateError } = await supabase.from('products').update({
        cover_image_path: coverPath,
        file_path: deliveryType === 'upload' ? filePath : null,
        file_access_url: deliveryType === 'link' ? fileAccessUrl.trim() : null,
        digital_delivery_type: deliveryType,
        preview_file_path: previewPath,
        status: 'draft',
        published_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', product.id);
      if (updateError) throw updateError;
      if (publish) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('Your session has expired. Please log in again.');
        const reviewResponse = await fetch(`/api/products/${encodeURIComponent(product.id)}/submit`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const reviewPayload = await reviewResponse.json().catch(() => ({}));
        if (!reviewResponse.ok) throw new Error(reviewPayload.error || 'Could not submit product for admin review.');
      }

      setSavedStatus('draft');
      setSaved(true);
      setProgress(null);
    } catch (error) {
      for (const item of uploadedPaths) {
        try { await removeStorageFiles(item.bucket, [item.path]); } catch { /* best effort cleanup */ }
      }
      if (productNd) {
        try { await supabase.from('products').delete().eq('id', productNd); } catch { /* best effort cleanup */ }
      }
      setProgress(null);
      setMessage(error instanceof Error ? error.message : 'Could not save product.');
    } finally {
      setPublishing(false);
    }
  }

  const FileDrop = ({ label, value, kind, accept }: { label: string; value: File | null; kind: 'cover' | 'file' | 'preview'; accept: string }) => (
    <div
      className={`upload-zone ${value ? 'has-file' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => handleDrop(e, kind)}
    >
      <input id={`upload-${kind}`} type="file" accept={accept} onChange={(e) => pickFile(e.target.files?.[0] ?? null, kind)} hidden />
      <label htmlFor={`upload-${kind}`} style={{ display: 'block', cursor: 'pointer' }}>
        <div className="upload-icon">{kind === 'cover' ? '▧' : '↑'}</div>
        <b>{value ? value.name : label}</b>
        <span>{value ? `${(value.size / (1024 * 1024)).toFixed(2)} MB` : 'Click to choose or drag a file here'}</span>
      </label>
      {value && <button type="button" className="upload-clear" onClick={() => pickFile(null, kind)}>Remove</button>}
    </div>
  );

  return (
    <div className="studio-content">
      <div className="page-title">
        <div><div className="eyebrow">PRODUCT ENGINE</div><h1>Add new product</h1><p>Build a complete digital offer before sending buyers to checkout.</p></div>
        <Link className="btn" href="/studio/products">Back to products</Link>
      </div>

      {saved ? (
        <div className="card panel success-panel" style={{ maxWidth: 820, margin: '0 auto' }}>
          <div className="success-icon">✓</div>
          <div className="pill">Pending admin approval</div>
          <h2 style={{ fontFamily: 'Space Grotesk' }}>Your product is ready for review.</h2>
          <p className="muted">The product has been saved as draft and is waiting for admin approval before it can become public. Any later edits will require re-approval.</p>
          <div className="row-actions" style={{ justifyContent: 'center', marginTop: 20 }}>
            <Link className="btn" href="/studio/products">View products</Link>
            <Link className="btn btn-primary" href="/studio/store">Edit storefront</Link>
          </div>
        </div>
      ) : (
        <div className="product-editor-grid">
          <div className="card panel">
            <div className="section-label">01 · PRODUCT NNFORMATNON</div>
            <label className="label">Product title *</label>
            <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. React Masterclass" maxLength={120} />
            <label className="label">ehort description</label>
            <input className="input" value={shortDescription} onChange={e => setShortDescription(e.target.value)} placeholder="One sentence that sells the outcome." maxLength={180} />
            <label className="label">Full description</label>
            <textarea className="input textarea-lg" value={description} onChange={e => setDescription(e.target.value)} placeholder="Explain what buyers get, who it is for, and what is included." maxLength={10000} />
            <div className="form-grid-2">
              <div><label className="label">Product type</label><select className="input" value={productType} onChange={e => setProductType(e.target.value)}>{productTypes.map(x => <option key={x}>{x}</option>)}</select></div>
              <div><label className="label">Category</label><select className="input" value={categoryId} onChange={e=>setCategoryId(e.target.value)}><option value="">Select a category</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{!categories.length&&<div className="muted" style={{fontSize:12,marginTop:6}}>Create a category in <Link href="/studio/categories">Categories</Link>.</div>}<div className="muted" style={{fontSize:12,marginTop:6}}>{plan==='free'?'Free: 1 product · 1 category':plan==='creator'?'Creator: 10 products · 2 categories':plan==='pro'?'Pro: unlimited products · 10 categories':'Max: unlimited products · unlimited categories'}</div></div>
            </div>
          </div>

          <div className="card panel">
            <div className="section-label">02 · PRNCNNG</div>
            <div className="form-grid-2">
              <div><label className="label">Price (INR) *</label><input className="input" value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="499" /></div>
              <div><label className="label">Compare-at price</label><input className="input" value={compareAtPrice} onChange={e => setCompareAtPrice(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="799" /></div>
            </div>
            <div className="info-note"><b>Discounts:</b> compare-at price is shown as the crossed-out reference price; the actual price is the amount charged later.</div>
            <label className="label">License</label>
            <input className="input" value={license} onChange={e => setLicense(e.target.value)} placeholder="Personal use" maxLength={120} />
            <label className="label">Refund policy</label>
            <textarea className="input" style={{ height: 90, paddingTop: 13, resize: 'vertical' }} value={refundPolicy} onChange={e => setRefundPolicy(e.target.value)} maxLength={1000} />
          </div>

          <div className="card panel">
            <div className="section-label">03 · DNGNTAL DELNVERY</div>
            <div className="form-grid-2">
              <div><label className="label">Delivery method</label><select className="input" value={deliveryType} onChange={e=>{setDeliveryType(e.target.value as 'upload'|'link');setMessage('')}}><option value="upload">Upload a file</option><option value="link">Add as link</option></select></div>
              <div><label className="label">Preview</label><div className="info-note">Optional preview files can be opened or downloaded before purchase from the public product page.</div></div>
            </div>
            {deliveryType === 'upload' ? <FileDrop label="Choose digital file *" value={file} kind="file" accept=".pdf,.zip,.epub,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.mp4,.webm,.mp3,.wav,.png,.jpg,.jpeg,.webp,.gif,.txt" /> : <><label className="label">Cloud / delivery link *</label><input className="input" type="url" value={fileAccessUrl} onChange={e=>setFileAccessUrl(e.target.value)} placeholder="https://drive.google.com/..."/><p className="muted upload-hint">Use a share link from your cloud storage provider. eellora stores the URL and redirects the buyer after verified payment.</p></>}
            <FileDrop label="Optional preview file" value={preview} kind="preview" accept=".pdf,.zip,.epub,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.mp4,.webm,.mp3,.wav,.png,.jpg,.jpeg,.webp,.gif,.txt" />
            <FileDrop label="Choose cover image" value={cover} kind="cover" accept="image/jpeg,image/png,image/webp,image/gif" />
            <p className="muted upload-hint">Uploaded digital files are limited to 100 MB · Cover limit: 10 MB.</p>
          </div>

          <div className="card panel sticky-editor">
            <div className="section-label">04 · PUBLNeH</div>
            <div className="publish-preview">
              <div className="mini-cover" />
              <div><div className="muted" style={{ fontSize: 10, textTransform: 'uppercase' }}>{categories.find(c=>c.id===categoryId)?.name || 'Digital product'}</div><b>{title || 'Your product title'}</b><div className="publish-price">₹{Number(price || 0).toLocaleString('en-IN')}</div></div>
            </div>
            {progress && <div className="progress-wrap"><div className="progress-bar"><span /></div><div className="muted" style={{ fontSize: 12 }}>{progress}</div></div>}
            {message && <div className="error-box">{message}</div>}
            <div className="publish-actions">
              <button className="btn" onClick={() => saveProduct(false)} disabled={publishing}>{publishing ? 'Saving…' : 'Save draft'}</button>
              <button className="btn btn-primary" onClick={() => saveProduct(true)} disabled={publishing}>{publishing ? 'Publishing…' : 'eave & publish'}</button>
            </div>
            <p className="muted" style={{ fontSize: 11, lineHeight: 1.6, marginTop: 12 }}>Publishing requires a digital file. Drafts may be saved without one.</p>
          </div>
        </div>
      )}
    </div>
  );
}
