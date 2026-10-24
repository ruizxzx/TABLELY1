import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../lib/server-admin';
import { getCreatorBalance } from '../../lib/server-finance';
import { requireAdmin, adminPermissionForAction, adminPermissionForSection, assertSameOrigin, withRateLimit, writeAudit } from '../../lib/server-security';
import { getRazorpayProvider } from '../../lib/payments';
import { getCreatorAuth } from '../../lib/payments/razorpay-auth';
import { resolveTxt } from 'node:dns/promises';
import { createBillingPlan, getBillingEnvironment, updateBillingSubscription, cancelBillingSubscription, cancelScheduledBillingUpdate, fetchBillingSubscription } from '../../lib/billing';
import { persistProviderSubscription } from '../../lib/billing-service';

export const dynamic = 'force-dynamic';

function fail(message: string, status = 400) { return NextResponse.json({ ok: false, error: message }, { status }); }
function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const detail = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [detail.message, detail.details, detail.hint, detail.code].filter(value => typeof value === 'string' && value.trim());
    if (parts.length) return parts.join(' | ');
  }
  return fallback;
}

async function provisionAllBillingVariants(db: any, actor: any, environment: string, now: string) {
  const { data: variants, error: variantsError } = await db.from('sellora_plan_variants').select('id,plan_key,billing_period,price_minor,currency,active').eq('active', true).neq('plan_key', 'free').order('plan_key').order('billing_period');
  if (variantsError) throw variantsError;
  const { data: plans, error: plansError } = await db.from('sellora_plans').select('plan_key,name,description').in('plan_key', [...new Set((variants || []).map((variant: any) => variant.plan_key))]);
  if (plansError) throw plansError;
  const results: any[] = [];
  for (const variant of variants || []) {
    const plan = (plans || []).find((entry: any) => entry.plan_key === variant.plan_key);
    try {
      const { data: latestRows, error: latestError } = await db.from('sellora_plan_versions').select('version_no').eq('variant_id', variant.id).eq('environment', environment).order('version_no', { ascending: false }).limit(1);
      if (latestError) throw latestError;
      const versionNo = Number(latestRows?.[0]?.version_no || 0) + 1;
      const { data: version, error: insertError } = await db.from('sellora_plan_versions').insert({ plan_key: variant.plan_key, variant_id: variant.id, version_no: versionNo, amount_minor: variant.price_minor, currency: variant.currency, billing_period: variant.billing_period, environment, provider: 'razorpay', status: 'unprovisioned', is_current: false }).select('*').single();
      if (insertError) throw insertError;
      const providerPlan = await createBillingPlan({ name: `TABLELY ${plan?.name || variant.plan_key} (${variant.billing_period})`, amountMinor: Number(variant.price_minor), currency: String(variant.currency || 'INR').toUpperCase(), description: String(plan?.description || `TABLELY ${variant.plan_key} subscription.`), billingPeriod: variant.billing_period, notes: { sellora_plan_key: variant.plan_key, sellora_billing_period: variant.billing_period, sellora_plan_version_id: version.id, environment } });
      await db.from('sellora_plan_versions').update({ is_current: false, status: 'retired', retired_at: now }).eq('variant_id', variant.id).eq('environment', environment).eq('is_current', true);
      const { error: updateError } = await db.from('sellora_plan_versions').update({ provider_plan_id: providerPlan.id, status: 'current', is_current: true, provisioned_at: now, provisioning_error: null }).eq('id', version.id);
      if (updateError) throw updateError;
      results.push({ planKey: variant.plan_key, billingPeriod: variant.billing_period, providerPlanId: providerPlan.id, status: 'provisioned' });
    } catch (error) {
      results.push({ planKey: variant.plan_key, billingPeriod: variant.billing_period, status: 'failed', error: error instanceof Error ? error.message : 'Provisioning failed' });
    }
  }
  const failures = results.filter((result) => result.status === 'failed');
  await writeAudit({ actorUserId: actor.id, action: 'subscription.all_variants_provisioned', entityType: 'sellora_plan_variants', after: results, metadata: { environment, failureCount: failures.length } });
  return { results, failures: failures.length };
}

async function ensurePublicProductPlacement(db: any, productId: string, now: string) {
  const { data: product, error: productError } = await db.from('products').select('id,store_id,category_id').eq('id', productId).maybeSingle();
  if (productError) throw productError;
  if (!product) throw new Error('Product not found.');
  let categoryId = product.category_id;
  if (!categoryId) {
    const { data: existingCategory, error: categoryLookupError } = await db.from('store_categories').select('id').eq('store_id', product.store_id).eq('slug', 'products').maybeSingle();
    if (categoryLookupError) throw categoryLookupError;
    if (existingCategory) categoryId = existingCategory.id;
    else {
      const { data: createdCategory, error: categoryCreateError } = await db.from('store_categories').insert({ store_id: product.store_id, name: 'Products', slug: 'products', status: 'live', is_visible: true, sort_order: 0, updated_at: now }).select('id').single();
      if (categoryCreateError) throw categoryCreateError;
      categoryId = createdCategory.id;
    }
  }
  const { error: categoryUpdateError } = await db.from('store_categories').update({ status: 'live', is_visible: true, plan_archived: false, plan_archived_at: null, updated_at: now }).eq('id', categoryId);
  if (categoryUpdateError) throw categoryUpdateError;
  return categoryId;
}

async function adminContext(request: Request, permission = '*') {
  try { assertSameOrigin(request); const user = await requireAdmin(request, permission); return user; }
  catch (e) { const message = e instanceof Error ? e.message : 'Unauthorized'; throw Object.assign(new Error(message), { status: message === 'Forbidden' ? 403 : 401 }); }
}

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'admin-read', 120);
  if (limited) return limited;
  const section = new URL(request.url).searchParams.get('section') || 'overview';
  let actor: any;
  try { actor = await adminContext(request, section === 'session' ? 'identity' : section === 'staff' ? 'staff.write' : adminPermissionForSection(section)); } catch(e:any) { return fail(e.message, e.status || 401); }
  const q = new URL(request.url).searchParams;
  const db = getAdminSupabase();
  try {
    if (section === 'session') return NextResponse.json({ ok: true, data: { role: actor.role }, actor });
    if (section === 'staff') {
      const { data, error } = await db.from('admin_staff').select('id,email,user_id,role,active,created_at,updated_at').order('created_at', { ascending: false });
      if (error) throw error;
      return NextResponse.json({ ok: true, data: data || [], actor });
    }
    if (section === 'access-grants') {
      await db.from('creator_access_grants').update({status:'expired',updated_at:new Date().toISOString()}).in('status',['pending','active']).not('expires_at','is',null).lte('expires_at',new Date().toISOString());
      const { data, error } = await db.from('creator_access_grants').select('*').order('created_at',{ascending:false}).limit(250);
      if (error) throw error;
      const rows = [];
      for (const grant of (data || [])) {
        let authEmail = grant.email;
        if (grant.creator_id) { try { authEmail = (await db.auth.admin.getUserById(grant.creator_id)).data.user?.email || grant.email; } catch {} }
        rows.push({...grant, email: authEmail});
      }
      return NextResponse.json({ok:true,data:rows,actor});
    }
    if (section === 'creator-detail') {
      const creatorId = q.get('creatorId') || '';
      if (!creatorId) return fail('Creator ID is required.');
      const [{ data:profile,error:profileError},{data:store,error:storeError},{data:products,error:productsError},{data:orders,error:ordersError},{data:verification,error:verificationError},{data:payouts,error:payoutsError}] = await Promise.all([
        db.from('profiles').select('*').eq('id',creatorId).maybeSingle(),
        db.from('stores').select('*').eq('owner_id',creatorId).maybeSingle(),
        db.from('products').select('id,title,slug,price,currency,status,moderation_status,created_at').eq('store_id', (await db.from('stores').select('id').eq('owner_id',creatorId).maybeSingle()).data?.id || '').order('created_at',{ascending:false}).limit(250),
        db.from('orders').select('id,buyer_email,gross_amount,currency,status,payment_status,delivery_status,created_at,paid_at').eq('creator_id',creatorId).order('created_at',{ascending:false}).limit(250),
        db.from('creator_verifications').select('*').eq('creator_id',creatorId).maybeSingle(),
        db.from('payouts').select('*').eq('creator_id',creatorId).order('requested_at',{ascending:false}).limit(100)
      ]);
      if(profileError)throw profileError;if(storeError)throw storeError;if(productsError)throw productsError;if(ordersError)throw ordersError;if(verificationError)throw verificationError;if(payoutsError)throw payoutsError;
      let authUser:any=null;
      try { authUser=(await db.auth.admin.getUserById(creatorId)).data.user||null; } catch {}
      const balance=await getCreatorBalance(creatorId);
      return NextResponse.json({ok:true,data:{profile,auth:{email:authUser?.email||null},store,products:products||[],orders:orders||[],verification,payouts:payouts||[],balance},actor});
    }

    if (section === 'content') {
      const [{data:pages,error:pagesError},{data:contacts,error:contactsError}] = await Promise.all([
        db.from('sellora_public_content').select('id,slug,title,seo_title,seo_description,draft_content,published_content,draft_version,published_version,published,updated_at,published_at,updated_by,published_by').order('slug'),
        db.from('sellora_contact_submissions').select('*').order('created_at',{ascending:false}).limit(250)
      ]);
      if(pagesError) throw pagesError; if(contactsError) throw contactsError;
      return NextResponse.json({ok:true,data:{pages:pages||[],contacts:contacts||[]},actor});
    }
    if (section === 'settings') {
      const {data:settings,error}=await db.from('platform_settings').select('*').eq('id',1).maybeSingle();
      if(error)throw error;
      return NextResponse.json({ok:true,data:settings,actor});
    }

    if (section === 'subscriptions') {
      const environment = getBillingEnvironment();
      const [{ data: plans, error: plansError }, { data: variants, error: variantsError }, { data: versions, error: versionsError }, { data: subscriptions, error: subsError }] = await Promise.all([
        db.from('sellora_plans').select('plan_key,name,description,price_minor,currency,billing_period,max_products,max_categories,features,active,updated_at').order('price_minor', { ascending: true }),
        db.from('sellora_plan_variants').select('id,plan_key,billing_period,price_minor,currency,annual_discount_percent,active,updated_at').order('plan_key').order('billing_period'),
        db.from('sellora_plan_versions').select('id,plan_key,variant_id,version_no,amount_minor,currency,billing_period,environment,provider,provider_plan_id,status,is_current,provisioning_error,provisioned_at,retired_at,created_at').eq('environment', environment).order('plan_key').order('billing_period').order('version_no', { ascending: false }),
        db.from('sellora_subscriptions').select('id,creator_id,plan_key,variant_id,plan_version_id,billing_period,pending_variant_id,pending_billing_period,environment,provider_subscription_id,provider_plan_id,customer_email,status,amount_minor,currency,current_start,current_end,charge_at,cancel_at_period_end,pending_plan_key,pending_change_at,last_synced_at,created_at,updated_at').eq('environment', environment).order('created_at', { ascending: false }).limit(500),
      ]);
      if (plansError) throw plansError; if (versionsError) throw versionsError; if (subsError) throw subsError;
      const fallbackVariants = (plans || []).flatMap((plan: any) => [
        { id: `${plan.plan_key}-monthly-fallback`, plan_key: plan.plan_key, billing_period: 'monthly', price_minor: plan.price_minor, currency: plan.currency, annual_discount_percent: 0, active: true },
        { id: `${plan.plan_key}-yearly-fallback`, plan_key: plan.plan_key, billing_period: 'yearly', price_minor: Number(plan.price_minor || 0) * 10, currency: plan.currency, annual_discount_percent: Number(plan.price_minor || 0) > 0 ? 16.67 : 0, active: true },
      ]);
      return NextResponse.json({ ok: true, data: { environment, plans: plans || [], variants: variantsError ? fallbackVariants : variants || [], versions: versions || [], subscriptions: subscriptions || [] }, actor });
    }
    if (section === 'overview') {
      const [{count: creators}, {count: orders}, {count: pendingVerification}, {count: pendingPayouts}, {count: refunds}, {data: paidOrders}, {data: fees}] = await Promise.all([
        db.from('profiles').select('id', {count:'exact', head:true}),
        db.from('orders').select('id', {count:'exact', head:true}),
        db.from('creator_verifications').select('id', {count:'exact', head:true}).in('status',['pending','action_required']),
        db.from('payouts').select('id', {count:'exact', head:true}).in('status',['pending','processing','held']),
        db.from('refunds').select('id', {count:'exact', head:true}).in('status',['requested','approved','processing']),
        db.from('orders').select('gross_amount, currency, platform_fee').eq('status','paid').limit(5000),
        db.from('platform_fees').select('amount_minor').limit(5000),
      ]);
      const gmv = (paidOrders||[]).reduce((s:any,o:any)=>s+Number(o.gross_amount||0),0);
      const platformRevenue = (fees||[]).reduce((s:any,f:any)=>s+Number(f.amount_minor||0)/100,0);
      return NextResponse.json({ok:true,data:{creators:creators||0,orders:orders||0,pendingVerification:pendingVerification||0,pendingPayouts:pendingPayouts||0,refunds:refunds||0,gmv,platformRevenue,currency:'INR',actor}});
    }
    if (section === 'verification') {
      const [{ data: requests, error: requestError }, { data: creatorRequests, error: creatorRequestError }] = await Promise.all([
        db.from('product_verification_requests').select('*').order('submitted_at', { ascending: false }).limit(250),
        db.from('creator_verifications').select('*').in('status', ['pending', 'action_required', 'verified', 'rejected']).order('updated_at', { ascending: false }).limit(250),
      ]);
      if (requestError) throw requestError;
      if (creatorRequestError) throw creatorRequestError;
      const rows = requests || [];
      const productIds = rows.map((row: any) => row.product_id).filter(Boolean);
      const creatorIds = [...rows.map((row: any) => row.creator_id), ...(creatorRequests || []).map((row: any) => row.creator_id)].filter(Boolean);
      const storeIds = rows.map((row: any) => row.store_id).filter(Boolean);
      const [{ data: products }, { data: creators }, { data: stores }] = await Promise.all([
        productIds.length ? db.from('products').select('id,title,slug,price,currency,product_type').in('id', productIds) : Promise.resolve({ data: [] }),
        creatorIds.length ? db.from('profiles').select('id,display_name').in('id', creatorIds) : Promise.resolve({ data: [] }),
        storeIds.length ? db.from('stores').select('id,name,username,owner_id').in('id', storeIds) : Promise.resolve({ data: [] }),
      ]);
      const productMap = new Map((products || []).map((row: any) => [row.id, row]));
      const creatorMap = new Map((creators || []).map((row: any) => [row.id, row]));
      const storeMap = new Map((stores || []).map((row: any) => [row.id, row]));
      const productRows = rows.map((row: any) => {
        const product = productMap.get(row.product_id) || row.product_snapshot || {};
        const creator = creatorMap.get(row.creator_id) || {};
        const store = storeMap.get(row.store_id) || {};
        return {
          id: row.id,
          request_type: 'product',
          creator_id: row.creator_id,
          product_id: row.product_id,
          creator: creator.display_name || row.creator_id,
          store: store.name || store.username || row.store_id,
          product: product.title || 'Unknown product',
          product_type: product.product_type || 'Digital product',
          price: product.price ?? '—',
          currency: product.currency || 'INR',
          submitted_at: row.submitted_at,
          status: row.status,
        };
      });
      const creatorRows = (creatorRequests || []).map((row: any) => {
        const creator = creatorMap.get(row.creator_id) || {};
        const store = [...storeMap.values()].find((item: any) => item.owner_id === row.creator_id) || {};
        return {
          id: row.id,
          request_type: 'creator',
          creator_id: row.creator_id,
          creator: creator.display_name || row.creator_id,
          store: store.name || store.username || '—',
          product: 'Creator account verification',
          product_type: 'Account',
          price: '—',
          currency: '—',
          submitted_at: row.updated_at || row.created_at,
          status: row.status,
        };
      });
      return NextResponse.json({ ok: true, data: [...productRows, ...creatorRows].sort((a: any, b: any) => String(b.submitted_at).localeCompare(String(a.submitted_at))), actor });
    }
    if (section === 'badge-requests') {
      const { data: requests, error } = await db.from('creator_verifications').select('id,creator_id,status,verification_details,submitted_at,updated_at,notes').order('updated_at', { ascending: false }).limit(250);
      if (error) throw error;
      const creatorIds = (requests || []).map((row: any) => row.creator_id).filter(Boolean);
      const [{ data: profiles }, { data: stores }] = await Promise.all([
        creatorIds.length ? db.from('profiles').select('id,display_name').in('id', creatorIds) : Promise.resolve({ data: [] }),
        creatorIds.length ? db.from('stores').select('id,owner_id,name,username,verified_badge').in('owner_id', creatorIds) : Promise.resolve({ data: [] }),
      ]);
      const profileMap = new Map((profiles || []).map((row: any) => [row.id, row]));
      const storeMap = new Map((stores || []).map((row: any) => [row.owner_id, row]));
      return NextResponse.json({ ok: true, data: (requests || []).map((row: any) => ({
        id: row.id, request_type: 'badge', creator_id: row.creator_id, creator: profileMap.get(row.creator_id)?.display_name || row.creator_id,
        store: storeMap.get(row.creator_id)?.name || storeMap.get(row.creator_id)?.username || '—', status: row.status,
        submitted_at: row.submitted_at || row.updated_at, full_name: row.verification_details?.fullName || '—',
        public_username: row.verification_details?.username || '—', category: row.verification_details?.category || '—',
        country: row.verification_details?.country || '—', audience: row.verification_details?.audience || '—',
        public_links: (row.verification_details?.links || []).join(' | '), reason: row.verification_details?.reason || '—', notes: row.notes || '—',
      })), actor });
    }
    if (section === 'product-review-detail') {
      const requestId = q.get('requestId') || '';
      if (!requestId) return fail('Review request ID is required.');
      const { data: review, error: reviewError } = await db.from('product_verification_requests').select('*').eq('id', requestId).maybeSingle();
      if (reviewError) throw reviewError;
      if (!review) return fail('Review request not found.', 404);
      const [{ data: product, error: productError }, { data: store, error: storeError }, { data: creator, error: creatorError }, { data: category, error: categoryError }] = await Promise.all([
        db.from('products').select('id,title,slug,short_description,description,price,compare_at_price,currency,product_type,license,refund_policy,digital_delivery_type,cover_image_path,preview_file_path,file_path,file_access_url,status,visibility,created_at,updated_at').eq('id', review.product_id).maybeSingle(),
        db.from('stores').select('id,name,username,bio').eq('id', review.store_id).maybeSingle(),
        db.from('profiles').select('id,display_name').eq('id', review.creator_id).maybeSingle(),
        db.from('store_categories').select('name').eq('id', review.product_snapshot?.category_id || '').maybeSingle(),
      ]);
      if (productError) throw productError;
      if (storeError) throw storeError;
      if (creatorError) throw creatorError;
      if (categoryError) throw categoryError;
      return NextResponse.json({ ok: true, data: { review, product, store, creator, category }, actor });
    }
    const map: Record<string,string> = {
      creators: 'profiles',
      stores: 'stores',
      products: 'products',
      orders: 'orders',
      transactions: 'payment_transactions',
      payouts: 'payouts',
      refunds: 'refunds',
      'audit-logs': 'audit_logs',
      disputes: 'disputes',
      reports: 'product_reports',
      domains: 'custom_domains'
    };
    const table = map[section];
    if (!table) return fail('Unknown admin section.',404);
    if (section === 'reports') {
      const [{data:products,error:pe},{data:creators,error:ce}] = await Promise.all([
        db.from('product_reports').select('*').order('created_at',{ascending:false}).limit(150),
        db.from('creator_reports').select('*').order('created_at',{ascending:false}).limit(150)
      ]);
      if (pe) throw pe; if (ce) throw ce;
      const combined=[...(products||[]).map((r:any)=>({...r,target_type:'product'})),...(creators||[]).map((r:any)=>({...r,target_type:'creator'}))]
        .sort((a:any,b:any)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,250);
      return NextResponse.json({ok:true,data:combined,actor});
    }
    const search = (q.get('search')||'').trim();
    let query: any = db.from(table).select('*').order('created_at',{ascending:false}).limit(250);
    if (search && ['profiles','stores','products','orders','payouts','refunds','payment_transactions','audit_logs','disputes','custom_domains'].includes(table)) {
      const cols: Record<string,string>={profiles:'display_name',stores:'username,name',products:'title,slug',orders:'buyer_email,id',payouts:'id,provider_payout_id',refunds:'id,order_id',payment_transactions:'provider_payment_id,provider_order_id',audit_logs:'action,entity_type',disputes:'provider_reference,id',custom_domains:'domain'};
      query = query.or(cols[table].split(',').map((c:string)=>`${c}.ilike.%${search.replace(/[%_]/g,'') }%`).join(','));
    }
    const {data,error}=await query;
    if(error) throw error;
    return NextResponse.json({ok:true,data:data||[],actor});
  } catch(error) { console.error('[admin GET]',error); return fail(error instanceof Error?error.message:'Admin request failed.',500); }
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'admin-write', 30);
  if (limited) return limited;
  let body: any;
  try { body = await request.json(); } catch { return fail('Invalid request body.'); }
  const action = String(body.action || '');
  let actor: any;
  try { actor = await adminContext(request, adminPermissionForAction(action)); } catch(e:any) { return fail(e.message, e.status || 401); }
  try {
    const db = getAdminSupabase();
    const now = new Date().toISOString();

    if (action === 'provision_all_plans') {
      const result = await provisionAllBillingVariants(db, actor, getBillingEnvironment(), now);
      return NextResponse.json({ ok: true, data: result, warning: result.failures ? `${result.failures} billing variant(s) failed to provision.` : undefined });
    }

    if (action === 'invite_staff') {
      const email = String(body.email || '').trim().toLowerCase();
      const role = String(body.role || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid staff email.');
      if (!['verification', 'content', 'support', 'billing'].includes(role)) return fail('Choose a valid staff role.');
      const { data: existing } = await db.from('admin_staff').select('*').eq('email', email).maybeSingle();
      if (existing?.active) return fail('This email is already an active staff member.', 409);
      const invite = await db.auth.admin.inviteUserByEmail(email, { redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || ''}/login` });
      let invitedUser = invite.data.user || null;
      if (invite.error && !invitedUser) {
        const users = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
        invitedUser = users.data.users.find(user => user.email?.toLowerCase() === email) || null;
        if (!invitedUser) throw invite.error;
      }
      const userId = invitedUser?.id || existing?.user_id || null;
      const { data, error } = await db.from('admin_staff').upsert({ email, user_id: userId, role, active: true, created_by: actor.id, updated_at: now }, { onConflict: 'email' }).select('id,email,user_id,role,active,created_at,updated_at').single();
      if (error) throw error;
      await writeAudit({ actorUserId: actor.id, action: 'staff.invited', entityType: 'admin_staff', entityId: data.id, after: data });
      return NextResponse.json({ ok: true, data, invitationSent: !invite.error });
    }
    if (action === 'update_staff' || action === 'remove_staff') {
      const id = String(body.id || '');
      if (!id) return fail('Staff member is required.');
      const { data: before } = await db.from('admin_staff').select('*').eq('id', id).maybeSingle();
      if (!before) return fail('Staff member not found.', 404);
      const patch = action === 'remove_staff' ? { active: false, updated_at: now } : { role: String(body.role || ''), active: Boolean(body.active), updated_at: now };
      if (action === 'update_staff' && !['verification', 'content', 'support', 'billing'].includes(String(patch.role))) return fail('Choose a valid staff role.');
      const { data, error } = await db.from('admin_staff').update(patch).eq('id', id).select('id,email,user_id,role,active,created_at,updated_at').single();
      if (error) throw error;
      await writeAudit({ actorUserId: actor.id, action: `staff.${action === 'remove_staff' ? 'removed' : 'updated'}`, entityType: 'admin_staff', entityId: id, before, after: data });
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'save_public_content') {
      const slug=String(body.slug||'').trim();
      const allowed=['home','site','contact','vision','founder','privacy','terms','refunds'];
      if(!allowed.includes(slug)) return fail('Invalid content page.');
      const content=body.content;
      if(!content || typeof content!=='object' || Array.isArray(content)) return fail('Invalid content payload.');
      const hrefKeys=['primaryHref','secondaryHref','finalCtaHref','ctaHref'];
      for(const key of hrefKeys){ if(key in content && content[key]!==null && !String(content[key]).startsWith('/')) return fail('Public CTA links must be internal routes.'); }
      for(const listKey of ['nav','footerLinks']){ if(Array.isArray(content[listKey])) for(const item of content[listKey]) if(item?.href && !String(item.href).startsWith('/')) return fail('Public navigation links must be internal routes.'); }
      const {data:before}=await db.from('sellora_public_content').select('*').eq('slug',slug).maybeSingle();
      if(!before) return fail('Content page not found.',404);
      const {data,error}=await db.from('sellora_public_content').update({title:body.title!==undefined?String(body.title):before.title,seo_title:body.seo_title!==undefined?String(body.seo_title):before.seo_title,seo_description:body.seo_description!==undefined?String(body.seo_description):before.seo_description,draft_content:content,draft_version:Number(before.draft_version||0)+1,updated_at:now,updated_by:actor.id}).eq('slug',slug).select('*').single();
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:'CONTENT_UPDATED',entityType:'public_content',entityId:data.id,before,after:data});
      return NextResponse.json({ok:true,data});
    }
    if (action === 'publish_public_content') {
      const slug=String(body.slug||'').trim();
      const {data:before}=await db.from('sellora_public_content').select('*').eq('slug',slug).maybeSingle();
      if(!before) return fail('Content page not found.',404);
      const {data,error}=await db.from('sellora_public_content').update({published_content:before.draft_content,published:true,published_version:Number(before.published_version||0)+1,published_at:now,published_by:actor.id,updated_at:now,updated_by:actor.id}).eq('slug',slug).select('*').single();
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:'CONTENT_PUBLISHED',entityType:'public_content',entityId:data.id,before,after:data});
      return NextResponse.json({ok:true,data});
    }
    if (action === 'unpublish_public_content') {
      const slug=String(body.slug||'').trim();
      const {data:before}=await db.from('sellora_public_content').select('*').eq('slug',slug).maybeSingle();
      if(!before) return fail('Content page not found.',404);
      const {data,error}=await db.from('sellora_public_content').update({published:false,updated_at:now,updated_by:actor.id}).eq('slug',slug).select('*').single();
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:'CONTENT_UNPUBLISHED',entityType:'public_content',entityId:data.id,before,after:data});
      return NextResponse.json({ok:true,data});
    }
    if (action === 'update_contact_submission') {
      const id=String(body.id||''); const status=String(body.status||'');
      if(!id || !['NEW','IN_PROGRESS','CONTACTED','CONVERTED','CLOSED'].includes(status)) return fail('Invalid contact update.');
      const {data,error}=await db.from('sellora_contact_submissions').update({status,internal_notes:body.internal_notes===undefined?undefined:String(body.internal_notes||'').slice(0,5000),updated_by:actor.id,updated_at:now}).eq('id',id).select('*').single();
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:'CONTACT_UPDATED',entityType:'contact_submission',entityId:id,after:data});
      return NextResponse.json({ok:true,data});
    }

    if (action === 'invite_or_grant_creator') {
      const email=String(body.email||'').trim().toLowerCase();
      const plan=String(body.plan||'free');
      const accessType=String(body.accessType||'trial');
      const startsRaw=body.startsAt ? String(body.startsAt) : '';
      const startsAt=startsRaw ? new Date(startsRaw) : new Date();
      const expiresAt=body.expiresAt ? new Date(String(body.expiresAt)) : null;
      const note=String(body.note||'').trim().slice(0,500) || null;
      const sendInvite=Boolean(body.sendInvite);
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid email address.');
      if(!['free','creator','pro','max'].includes(plan)) return fail('Invalid plan.');
      if(!['trial','complimentary','permanent'].includes(accessType)) return fail('Invalid access type.');
      if(Number.isNaN(startsAt.getTime())) return fail('Invalid start time.');
      if(expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= startsAt.getTime())) return fail('End time must be after the start time.');
      const usersPage = await db.auth.admin.listUsers({page:1,perPage:1000});
      if(usersPage.error) throw usersPage.error;
      const existingUser=(usersPage.data.users||[]).find((u:any)=>String(u.email||'').toLowerCase()===email) || null;
      const {data:before}=await db.from('creator_access_grants').select('*').eq('email',email).in('status',['pending','active']).maybeSingle();
      const payload={email,creator_id:existingUser?.id||before?.creator_id||null,plan,access_type:accessType,starts_at:startsAt.toISOString(),expires_at:expiresAt?expiresAt.toISOString():null,status:existingUser?'active':'pending',note,updated_by:actor.id,updated_at:now};
      let finalGrant:any=null;
      if(before?.id){
        const {data,error}=await db.from('creator_access_grants').update(payload).eq('id',before.id).select('*').single();
        if(error)throw error; finalGrant=data;
      } else {
        const {data,error}=await db.from('creator_access_grants').insert({...payload,created_by:actor.id}).select('*').single();
        if(error)throw error; finalGrant=data;
      }
      if(existingUser?.id){
        const {error}=await db.from('creator_plans').upsert({creator_id:existingUser.id,plan,access_source:accessType,access_starts_at:startsAt.toISOString(),access_expires_at:expiresAt?expiresAt.toISOString():null,access_grant_id:finalGrant.id,updated_at:now,updated_by:actor.id},{onConflict:'creator_id'});
        if(error)throw error;
      }
      let invitationSent=false;
      if(sendInvite && !existingUser){
        const redirectTo=process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/,'')}/login?invite=1` : undefined;
        const inv=await db.auth.admin.inviteUserByEmail(email, redirectTo?{redirectTo}:{}) as any;
        if(inv.error){
          await writeAudit({actorUserId:actor.id,action:'creator_access.invite_failed',entityType:'creator_access_grant',entityId:finalGrant.id,after:finalGrant,metadata:{email,error:inv.error.message}});
          return NextResponse.json({ok:true,data:finalGrant,warning:`Access grant saved, but invitation email could not be sent: ${inv.error.message}`},{status:202});
        }
        invitationSent=true;
      }
      await writeAudit({actorUserId:actor.id,action:existingUser?'creator_access.updated':'creator_access.granted',entityType:'creator_access_grant',entityId:finalGrant.id,after:finalGrant,metadata:{email,invitation_sent:invitationSent}});
      return NextResponse.json({ok:true,data:finalGrant,invitationSent});
    }

    if (action === 'revoke_creator_access') {
      const grantId=String(body.grantId||'');
      if(!grantId) return fail('Grant ID is required.');
      const {data:grant,error:getError}=await db.from('creator_access_grants').select('*').eq('id',grantId).maybeSingle();
      if(getError) throw getError;
      if(!grant) return fail('Access grant not found.',404);
      const {error}=await db.from('creator_access_grants').update({status:'revoked',updated_at:now,updated_by:actor.id}).eq('id',grantId);
      if(error) throw error;
      if(grant.creator_id){
        const {error:planError}=await db.rpc('sellora_sync_subscription_entitlement',{p_creator_id:grant.creator_id});
        if(planError) throw planError;
      }
      await writeAudit({actorUserId:actor.id,action:'creator_access.revoked',entityType:'creator_access_grant',entityId:grantId,before:grant,after:{status:'revoked'}});
      return NextResponse.json({ok:true});
    }

    if (action === 'reprovision_plan') {
      const planKey = String(body.planKey || '').toLowerCase();
      const billingPeriod = String(body.billingPeriod || 'monthly').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
      const amountMinor = Math.round(Number(body.amountMinor));
      const annualDiscountPercent = Math.max(0, Math.min(100, Number(body.annualDiscountPercent || 0)));
      const environment = getBillingEnvironment();
      if (!['free','creator','pro','max'].includes(planKey)) return fail('Invalid TABLELY plan.');
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return fail('Invalid plan price.');
      if (planKey === 'free' && amountMinor !== 0) return fail('The Free plan must remain ₹0.');
      if (planKey !== 'free' && amountMinor <= 0) return fail('Paid plans require a positive price.');

      const { data: plan, error: planError } = await db.from('sellora_plans').select('*').eq('plan_key', planKey).maybeSingle();
      if (planError) throw planError;
      if (!plan) return fail('TABLELY plan not found.', 404);
      const { data: variant, error: variantError } = await db.from('sellora_plan_variants').upsert({ plan_key: planKey, billing_period: billingPeriod, price_minor: amountMinor, currency: plan.currency, annual_discount_percent: billingPeriod === 'yearly' ? annualDiscountPercent : 0, updated_at: now }, { onConflict: 'plan_key,billing_period' }).select('*').single();
      if (variantError) throw variantError;
      const { data: latestRows, error: latestError } = await db.from('sellora_plan_versions').select('version_no').eq('variant_id', variant.id).eq('environment', environment).order('version_no', { ascending: false }).limit(1);
      if (latestError) throw latestError;
      const versionNo = Number(latestRows?.[0]?.version_no || 0) + 1;
      const { data: version, error: versionInsertError } = await db.from('sellora_plan_versions').insert({
        plan_key: planKey, variant_id: variant.id, version_no: versionNo, amount_minor: amountMinor, currency: plan.currency, billing_period: billingPeriod, environment, provider:'razorpay', status:'unprovisioned', is_current:false
      }).select('*').single();
      if (versionInsertError) throw versionInsertError;

      if (planKey === 'free') {
        await db.from('sellora_plan_versions').update({ is_current:false, status:'retired', retired_at:now }).eq('variant_id', variant.id).eq('environment', environment).neq('id', version.id);
        const { error: freeVersionError } = await db.from('sellora_plan_versions').update({ is_current:true, status:'current', provisioned_at:now }).eq('id', version.id);
        if (freeVersionError) throw freeVersionError;
      } else {
        try {
          const providerPlan = await createBillingPlan({ name:`TABLELY ${plan.name} (${billingPeriod})`, amountMinor, currency:String(plan.currency).toUpperCase(), description:String(plan.description || `TABLELY ${plan.name} subscription.`), billingPeriod, notes:{sellora_plan_key:planKey,sellora_billing_period:billingPeriod,sellora_plan_version_id:version.id,environment} });
          await db.from('sellora_plan_versions').update({ is_current:false, status:'retired', retired_at:now }).eq('variant_id', variant.id).eq('environment', environment).eq('is_current',true);
          const { error: versionUpdateError } = await db.from('sellora_plan_versions').update({ provider_plan_id:providerPlan.id,status:'current',is_current:true,provisioned_at:now,provisioning_error:null }).eq('id',version.id);
          if (versionUpdateError) throw versionUpdateError;
          const { error: priceError } = await db.from('sellora_plans').update({ price_minor: billingPeriod === 'monthly' ? amountMinor : plan.price_minor, billing_period: 'monthly', updated_at:now }).eq('plan_key',planKey);
          if (priceError) throw priceError;

          const { data: activeSubs, error: activeSubsError } = await db.from('sellora_subscriptions').select('id,creator_id,provider_subscription_id,plan_key,variant_id,provider_plan_id,status,current_end').eq('environment',environment).eq('variant_id',variant.id).in('status',['authenticated','active','pending','paused','halted']).limit(500);
          if (activeSubsError) throw activeSubsError;
          const failures:string[]=[];
          for (const sub of activeSubs || []) {
            if (sub.provider_plan_id === providerPlan.id) continue;
            try {
              await updateBillingSubscription(sub.provider_subscription_id,{planId:providerPlan.id,scheduleChangeAt:'cycle_end',customerNotify:true});
              const { error:subPatchError } = await db.from('sellora_subscriptions').update({pending_plan_key:planKey,pending_variant_id:variant.id,pending_billing_period:billingPeriod,pending_plan_version_id:version.id,pending_change_at:'cycle_end',updated_at:now}).eq('id',sub.id);
              if (subPatchError) throw subPatchError;
            } catch (e) { failures.push(`${sub.id}:${e instanceof Error?e.message:'failed'}`); }
          }
          if (failures.length) await db.from('sellora_plan_versions').update({ provisioning_error:`${failures.length} existing subscription(s) could not be scheduled: ${failures.slice(0,10).join(' | ')}` }).eq('id',version.id);
          await writeAudit({actorUserId:actor.id,action:'subscription.plan_reprovisioned',entityType:'sellora_plan',entityId:planKey,after:{planKey,billingPeriod,amountMinor,annualDiscountPercent,environment,providerPlanId:providerPlan.id,versionNo},metadata:{scheduledSubscriptionCount:(activeSubs||[]).length-failures.length,failures}});
          return NextResponse.json({ok:true,data:{planKey,billingPeriod,amountMinor,annualDiscountPercent,environment,providerPlanId:providerPlan.id,versionNo,scheduledSubscriptions:(activeSubs||[]).length-failures.length,failedSubscriptions:failures.length},warning:failures.length?`${failures.length} existing subscription(s) need manual sync/retry.`:undefined});
        } catch (e) {
          await db.from('sellora_plan_versions').update({ status:'failed', provisioning_error:e instanceof Error?e.message:'Provider provisioning failed' }).eq('id',version.id);
          throw e;
        }
      }
      await db.from('sellora_plans').update({price_minor:amountMinor,updated_at:now}).eq('plan_key',planKey);
      await writeAudit({actorUserId:actor.id,action:'subscription.free_plan_reprovisioned',entityType:'sellora_plan',entityId:planKey,after:{planKey,amountMinor,environment,versionNo}});
      return NextResponse.json({ok:true,data:{planKey,amountMinor,environment,versionNo}});
    }

    if (action === 'sync_subscription') {
      const subscriptionId = String(body.subscriptionId || '');
      if (!subscriptionId) return fail('Subscription ID is required.');
      const { data: sub, error: subError } = await db.from('sellora_subscriptions').select('id,creator_id,provider_subscription_id').eq('id',subscriptionId).maybeSingle();
      if (subError) throw subError; if (!sub) return fail('Subscription not found.',404);
      const remote = await fetchBillingSubscription(sub.provider_subscription_id);
      await persistProviderSubscription(sub.id, remote);
      await writeAudit({actorUserId:actor.id,action:'subscription.admin_sync',entityType:'subscription',entityId:sub.id,after:{status:remote.status,providerPlanId:remote.plan_id}});
      return NextResponse.json({ok:true,data:remote});
    }

    if (action === 'admin_resume_subscription') {
      const subscriptionId = String(body.subscriptionId || '');
      if (!subscriptionId) return fail('Subscription ID is required.');
      const { data: sub, error: subError } = await db.from('sellora_subscriptions').select('*').eq('id',subscriptionId).maybeSingle();
      if (subError) throw subError; if (!sub) return fail('Subscription not found.',404);
      if (!sub.cancel_at_period_end || sub.pending_plan_key !== 'free') return fail('No scheduled cancellation is available to resume.',409);
      const remote = await cancelScheduledBillingUpdate(sub.provider_subscription_id);
      await persistProviderSubscription(sub.id, remote);
      const { error: resumePatchError } = await db.from('sellora_subscriptions').update({ pending_plan_key:null,pending_plan_version_id:null,pending_change_at:null,cancel_at_period_end:false,cancelled_at:null,cancellation_email_sent_at:null,updated_at:now }).eq('id',sub.id);
      if (resumePatchError) throw resumePatchError;
      await writeAudit({actorUserId:actor.id,action:'subscription.admin_cancellation_resumed',entityType:'subscription',entityId:sub.id,before:{pendingPlanKey:'free',cancelAtPeriodEnd:true},after:{pendingPlanKey:null,cancelAtPeriodEnd:false}});
      return NextResponse.json({ok:true,data:remote});
    }

    if (action === 'admin_cancel_subscription') {
      const subscriptionId = String(body.subscriptionId || '');
      if (!subscriptionId) return fail('Subscription ID is required.');
      const { data: sub, error: subError } = await db.from('sellora_subscriptions').select('*').eq('id',subscriptionId).maybeSingle();
      if (subError) throw subError; if (!sub) return fail('Subscription not found.',404);
      if (!['created','authenticated','active','pending','paused','halted'].includes(String(sub.status))) return fail('Subscription is already terminal.',409);
      const remote = await cancelBillingSubscription(sub.provider_subscription_id,true);
      await persistProviderSubscription(sub.id, remote);
      const { error: cancelPatchError } = await db.from('sellora_subscriptions').update({
        pending_plan_key:'free',
        pending_plan_version_id:null,
        pending_change_at:'cycle_end',
        cancel_at_period_end:true,
        cancelled_at:null,
        updated_at:now,
      }).eq('id',sub.id);
      if (cancelPatchError) throw cancelPatchError;
      await writeAudit({actorUserId:actor.id,action:'subscription.admin_cancel_scheduled',entityType:'subscription',entityId:sub.id,after:{cancelAtPeriodEnd:true,pendingPlanKey:'free'}});
      return NextResponse.json({ok:true,data:remote});
    }

    if (action === 'set_store_status') {
      const storeId=String(body.storeId||''), status=String(body.status||'');
      if(!['active','draft','suspended'].includes(status)) return fail('Invalid store status.');
      const {data:before}=await db.from('stores').select('id,status').eq('id',storeId).maybeSingle();
      if(!before)return fail('Store not found.',404);
      const {error}=await db.from('stores').update({status,updated_at:now}).eq('id',storeId);
      if(error)throw error;
      await writeAudit({actorUserId:actor.id,action:`store.${status}`,entityType:'store',entityId:storeId,before,after:{status}});
      return NextResponse.json({ok:true});
    }

    if (action === 'create_adjustment') {
      const creatorId=String(body.creatorId||''), amount=Number(body.amount), direction=String(body.direction||'credit'), reason=String(body.reason||'').trim();
      if(!creatorId||!Number.isFinite(amount)||amount<=0||!reason)return fail('Creator, amount and reason are required.');
      if(!['credit','debit'].includes(direction))return fail('Invalid adjustment direction.');
      const balance=await getCreatorBalance(creatorId);
      if(direction==='debit' && Math.round(amount*100)>balance.available)return fail('Adjustment exceeds available balance.');
      const {data:store}=await db.from('stores').select('id').eq('owner_id',creatorId).maybeSingle();
      const {data:row,error}=await db.from('adjustments').insert({creator_id:creatorId,amount_minor:Math.round(amount*100),direction,kind:direction==='credit'?'manual_credit':'manual_debit',reason,created_by:actor.id}).select('*').single();
      if(error)throw error;
      await writeAudit({actorUserId:actor.id,action:`adjustment.${direction}`,entityType:'adjustment',entityId:row.id,after:row,metadata:{store_id:store?.id||null}});
      return NextResponse.json({ok:true,data:row});
    }

    if (action === 'update_platform_settings') {
      const feeBps=Math.round(Number(body.platformFeeBps));
      const minPayout=Math.round(Number(body.minimumPayoutMinor));
      const holdDays=Math.round(Number(body.payoutHoldDays));
      const defaultCurrency=String(body.defaultCurrency||'INR').toUpperCase();
      const maintenance=Boolean(body.maintenanceMode);
      const siteName=String(body.siteName || '').trim() || 'TABLELY';
      const siteLogoUrl = body.siteLogoUrl !== undefined ? (String(body.siteLogoUrl || '').trim() || null) : undefined;
      const siteFaviconUrl = body.siteFaviconUrl !== undefined ? (String(body.siteFaviconUrl || '').trim() || null) : undefined;
      if(!Number.isInteger(feeBps)||feeBps<0||feeBps>10000)return fail('Invalid platform fee.');
      if(!Number.isInteger(minPayout)||minPayout<0)return fail('Invalid minimum payout.');
      if(!Number.isInteger(holdDays)||holdDays<0||holdDays>365)return fail('Invalid payout hold period.');
      if(!/^[A-Z]{3}$/.test(defaultCurrency))return fail('Invalid default currency.');
      if(siteName.length>80) return fail('Site name is too long.');
      if(siteLogoUrl && !/^https?:\/\//i.test(siteLogoUrl) && !siteLogoUrl.startsWith('/')) return fail('Logo URL must be a valid public URL or local path.');
      if(siteFaviconUrl && !/^https?:\/\//i.test(siteFaviconUrl) && !siteFaviconUrl.startsWith('/')) return fail('Favicon URL must be a valid public URL or local path.');
      const {data:before}=await db.from('platform_settings').select('*').eq('id',1).maybeSingle();
      const patch={id:1,platform_fee_bps:feeBps,minimum_payout_minor:minPayout,payout_hold_days:holdDays,default_currency:defaultCurrency,maintenance_mode:maintenance,site_name:siteName,site_logo_url:siteLogoUrl ?? before?.site_logo_url ?? null,site_favicon_url:siteFaviconUrl ?? before?.site_favicon_url ?? null,updated_at:now,updated_by:actor.id};
      const {data:after,error}=await db.from('platform_settings').upsert(patch).select('*').single();
      if(error)throw error;
      await writeAudit({actorUserId:actor.id,action:'platform_settings.updated',entityType:'platform_settings',entityId:null,before,after});
      return NextResponse.json({ok:true,data:after});
    }

    if (action === 'set_creator_status') {
      const creatorId=String(body.creatorId), status=String(body.status);
      if(!['active','suspended','banned'].includes(status)) return fail('Invalid creator status.');
      const {data:before}=await db.from('profiles').select('id,account_status').eq('id',creatorId).maybeSingle();
      const {error}=await db.from('profiles').update({account_status:status}).eq('id',creatorId);
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:`creator.${status}`,entityType:'creator',entityId:creatorId,before,after:{account_status:status},ip:null});
      return NextResponse.json({ok:true});
    }

    if (action === 'set_product_moderation') {
      const productId=String(body.productId), moderationStatus=String(body.moderationStatus);
      if(!['clear','flagged','hidden','removed'].includes(moderationStatus)) return fail('Invalid moderation status.');
      const {data:before}=await db.from('products').select('id,status,moderation_status').eq('id',productId).maybeSingle();
      const patch:any={moderation_status:moderationStatus,updated_at:now};
      if(moderationStatus==='hidden'||moderationStatus==='removed') patch.status='archived';
      const {error}=await db.from('products').update(patch).eq('id',productId);
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:`product.moderation.${moderationStatus}`,entityType:'product',entityId:productId,before,after:patch});
      return NextResponse.json({ok:true});
    }

    if (action === 'approve_product') {
      const productId=String(body.productId || '').trim();
      if (!productId) return fail('Product ID is required.');
      const categoryId = await ensurePublicProductPlacement(db, productId, now);
      const { data: before } = await db.from('products').select('id,status,published_at,updated_at,category_id').eq('id', productId).maybeSingle();
      const { error } = await db.from('products').update({
        status: 'live',
        visibility: 'public',
        category_id: categoryId,
        published_at: before?.published_at || new Date().toISOString(),
        updated_at: now,
        moderation_status: 'clear',
      }).eq('id', productId);
      if (error) throw error;
      await writeAudit({actorUserId:actor.id,action:'product.approved',entityType:'product',entityId:productId,before,after:{status:'live',visibility:'public',moderation_status:'clear'}});
      return NextResponse.json({ ok: true });
    }

    if (action === 'set_verification') {
      const creatorId=String(body.creatorId), status=String(body.status);
      if(!['not_started','pending','verified','action_required','restricted','rejected'].includes(status)) return fail('Invalid verification status.');
      const {data:before}=await db.from('creator_verifications').select('*').eq('creator_id',creatorId).maybeSingle();
      const patch={creator_id:creatorId,status,submitted_at:before?.submitted_at||now,updated_at:now,provider:body.provider?String(body.provider):before?.provider||null,provider_account_id:body.providerAccountId?String(body.providerAccountId):before?.provider_account_id||null,notes:body.note?String(body.note).slice(0,2000):before?.notes||null};
      const {error}=await db.from('creator_verifications').upsert(patch,{onConflict:'creator_id'});
      if(error) throw error;
      await db.from('stores').update({verified_badge: status === 'verified', updated_at: now}).eq('owner_id', creatorId);
      await writeAudit({actorUserId:actor.id,action:'verification.update',entityType:'creator',entityId:creatorId,before,after:patch});
      return NextResponse.json({ok:true});
    }

    if (action === 'set_product_verification') {
      const requestId = String(body.requestId || '').trim();
      const status = String(body.status || '').trim();
      if (!requestId || !['verified', 'rejected', 'action_required'].includes(status)) return fail('Invalid product verification update.');
      const reviewNote = String(body.note || '').trim().slice(0, 2000);
      if (['rejected', 'action_required'].includes(status) && !reviewNote) return fail(status === 'rejected' ? 'A rejection reason is required.' : 'Tell the creator what information or changes are needed.');
      const { data: review, error: reviewError } = await db.from('product_verification_requests').select('*').eq('id', requestId).maybeSingle();
      if (reviewError) throw reviewError;
      if (!review) return fail('Verification request not found.', 404);
      if (review.status !== 'pending' && status !== 'action_required') return fail('This verification request has already been reviewed.', 409);
      const now = new Date().toISOString();
      const reviewPatch = { status, reviewed_at: now, reviewed_by: actor.id, review_note: reviewNote || null, updated_at: now };
      const { data: updatedReview, error: reviewUpdateError } = await db.from('product_verification_requests').update(reviewPatch).eq('id', requestId).eq('status', review.status).select('id').maybeSingle();
      if (reviewUpdateError) throw reviewUpdateError;
      if (!updatedReview) return fail('This verification request is no longer pending.', 409);
      const categoryId = status === 'verified' ? await ensurePublicProductPlacement(db, review.product_id, now) : null;
      const productPatch = status === 'verified'
        ? { status: 'live', visibility: 'public', category_id: categoryId, published_at: now, updated_at: now }
        : { status: 'draft', visibility: 'private', published_at: null, updated_at: now };
      const { error: productError } = await db.from('products').update(productPatch).eq('id', review.product_id);
      if (productError) {
        await db.from('product_verification_requests').update({ status: 'pending', reviewed_at: null, reviewed_by: null, updated_at: now }).eq('id', requestId);
        throw productError;
      }
      await writeAudit({ actorUserId: actor.id, action: `product.verification.${status}`, entityType: 'product', entityId: review.product_id, before: review, after: { review: reviewPatch, product: productPatch } });
      return NextResponse.json({ ok: true });
    }

    if (action === 'create_payout') {
      // Intentionally manual-record only. Current TABLELY configuration uses Razorpay Standard Checkout
      // and does not assume Route/RazorpayX is enabled for creator settlement.
      const creatorId=String(body.creatorId), amount=Number(body.amount);
      if(!creatorId || !Number.isFinite(amount) || amount<=0) return fail('Invalid payout.');
      const balance=await getCreatorBalance(creatorId);
      if(amount > balance.available) return fail('Payout exceeds available balance.');
      const {data,error}=await db.from('payouts').insert({creator_id:creatorId,amount_minor:Math.round(amount*100),currency:balance.currency,status:'pending',method:'manual_pending_provider_setup',provider:null,metadata:{created_by_admin:actor.id}}).select('*').single();
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:'payout.created',entityType:'payout',entityId:data.id,after:data});
      return NextResponse.json({ok:true,data});
    }

    if (action === 'set_payout_status') {
      const payoutId=String(body.payoutId), status=String(body.status);
      if(!['pending','processing','paid','held','failed','cancelled'].includes(status)) return fail('Invalid payout status.');
      if(status==='paid'){
        const {data:payoutCheck}=await db.from('payouts').select('provider,provider_payout_id').eq('id',payoutId).maybeSingle();
        if(!payoutCheck?.provider || !payoutCheck?.provider_payout_id) return fail('A payout cannot be marked paid without a provider settlement reference.',409);
      }
      const {data:before}=await db.from('payouts').select('*').eq('id',payoutId).maybeSingle();
      if(!before) return fail('Payout not found.',404);
      const patch:any={status,processed_at:['paid','failed','cancelled'].includes(status)?now:null,failure_reason:status==='failed'?String(body.reason||'') : null};
      const {error}=await db.from('payouts').update(patch).eq('id',payoutId);
      if(error) throw error;
      await writeAudit({actorUserId:actor.id,action:`payout.${status}`,entityType:'payout',entityId:payoutId,before,after:patch});
      return NextResponse.json({ok:true});
    }

    if (action === 'refund') {
      const orderId=String(body.orderId), amount=Number(body.amount);
      const {data:order,error:orderError}=await db.from('orders').select('id,status,payment_id,gross_amount,currency,creator_id,refund_amount_minor,payment_model,payment_account_id').eq('id',orderId).maybeSingle();
      if(orderError) throw orderError;
      if(!order || !['paid','partially_refunded'].includes(order.status)) return fail('Only paid orders can be refunded.');
      const amountMinor=Math.round(amount*100);
      const remaining=Math.round(Number(order.gross_amount)*100)-Number(order.refund_amount_minor||0);
      if(!Number.isFinite(amountMinor)||amountMinor<=0||amountMinor>remaining) return fail('Refund amount is invalid.');
      if(!order.payment_id) return fail('Order has no provider payment reference.');
      const provider=getRazorpayProvider();
      const auth=order.payment_model==='creator_connected' && order.payment_account_id ? await getCreatorAuth(order.payment_account_id) : undefined;
      const refund=await provider.refundPayment(order.payment_id,amountMinor,auth) as any;
      const refundId=String(refund?.id||'');
      const newRefunded=Number(order.refund_amount_minor||0)+amountMinor;
      const nextStatus=newRefunded>=Math.round(Number(order.gross_amount)*100)?'refunded':'partially_refunded';
      const {data:row,error}=await db.from('refunds').insert({order_id:order.id,creator_id:order.creator_id,requested_amount_minor:amountMinor,approved_amount_minor:amountMinor,currency:order.currency,status:'succeeded',provider_refund_id:refundId,reviewed_by:actor.id,reviewed_at:now,completed_at:now,reason:String(body.reason||'Admin refund')}).select('*').single();
      if(error) throw error;
      const {error:updateError}=await db.from('orders').update({refund_amount_minor:newRefunded,status:nextStatus,last_refund_at:now,delivery_status:'expired',updated_at:now}).eq('id',order.id);
      if(updateError) throw updateError;
      await db.from('ledger_entries').insert({order_id:order.id,creator_id:order.creator_id,entry_type:'refund',direction:'debit',amount_minor:amountMinor,currency:order.currency,description:'Customer refund',idempotency_key:`refund:${row.id}`});
      try {
        const { sendRefundEmail } = await import('../../lib/server-email');
        await sendRefundEmail(order.id);
      } catch (emailError) {
        console.error('[refund-email]', emailError);
      }
      await writeAudit({actorUserId:actor.id,action:'refund.succeeded',entityType:'order',entityId:order.id,before:order,after:{status:nextStatus,refund_amount_minor:newRefunded,refundId}});
      return NextResponse.json({ok:true,data:row});
    }

    if (action === 'resolve_report') {
      const reportId=String(body.reportId), type=body.type==='creator'?'creator_reports':'product_reports', moderationAction=String(body.moderationAction||'none');
      const {data:report,error:rerr}=await db.from(type).select('*').eq('id',reportId).maybeSingle(); if(rerr) throw rerr; if(!report)return fail('Report not found.',404);
      const patch:any={status:body.status==='dismissed'?'dismissed':'resolved',moderation_action:moderationAction,resolved_by:actor.id,resolved_at:now};
      const {error}=await db.from(type).update(patch).eq('id',reportId); if(error) throw error;
      if(type==='product_reports'&&['hide','remove'].includes(moderationAction)) await db.from('products').update({moderation_status:moderationAction==='hide'?'hidden':'removed',status:'archived',updated_at:now}).eq('id',report.product_id);
      if(type==='creator_reports'&&['suspend','ban'].includes(moderationAction)) await db.from('profiles').update({account_status:moderationAction==='ban'?'banned':'suspended'}).eq('id',report.creator_id);
      await writeAudit({actorUserId:actor.id,action:'report.resolved',entityType:type==='product_reports'?'product_report':'creator_report',entityId:reportId,after:patch});
      return NextResponse.json({ok:true});
    }

    if (action === 'set_dispute') {
      const disputeId=String(body.disputeId), status=String(body.status);
      if(!['open','investigating','evidence_submitted','won','lost','resolved'].includes(status)) return fail('Invalid dispute status.');
      const {data:before}=await db.from('disputes').select('*').eq('id',disputeId).maybeSingle(); if(!before)return fail('Dispute not found.',404);
      const patch={status,internal_notes:body.internalNotes!==undefined?String(body.internalNotes):before.internal_notes,resolution:body.resolution!==undefined?String(body.resolution):before.resolution,updated_at:now};
      const {error}=await db.from('disputes').update(patch).eq('id',disputeId); if(error)throw error;
      await writeAudit({actorUserId:actor.id,action:'dispute.update',entityType:'dispute',entityId:disputeId,before,after:patch});
      return NextResponse.json({ok:true});
    }

    if (action === 'verify_domain') {
      const domainId=String(body.domainId);
      const {data:before}=await db.from('custom_domains').select('*').eq('id',domainId).maybeSingle(); if(!before)return fail('Domain not found.',404);
      let records:string[][]=[];
      try { records = await resolveTxt(`_sellora.${before.domain}`); } catch { return fail('DNS TXT record was not found yet. Add the verification record and try again.',409); }
      const flattened=records.flat();
      if(!flattened.includes(before.verification_token)) return fail('DNS verification token does not match.',409);
      const {error}=await db.from('custom_domains').update({status:'verified',verified_at:now,updated_at:now,ssl_status:'pending'}).eq('id',domainId); if(error)throw error;
      await writeAudit({actorUserId:actor.id,action:'domain.verified',entityType:'custom_domain',entityId:domainId,before,after:{status:'verified'}});
      return NextResponse.json({ok:true});
    }

    return fail('Unknown admin action.',404);
  } catch(error) {
    console.error('[admin POST]',error);
    return fail(errorMessage(error, 'Admin action failed.'), 500);
  }
}
