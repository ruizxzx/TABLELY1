import { getSupabaseBrowserClient } from '@/lib/supabase';

export type PublicTableContext = {
  restaurant_name: string;
  restaurant_slug: string;
  branch_id: string;
  branch_name: string;
  table_id: string;
  table_number: number;
  table_code: string;
};

/**
 * Build 19.1 — anonymous VISIT context.
 *
 * Scanning a QR writes nothing to the database. The customer app only keeps two
 * local, anonymous values:
 *
 *  - device token: stable per browser, informational only. It is never used by
 *    the server to adopt or merge a session, because one phone can be handed
 *    around between customers.
 *  - visit token: identifies one visit to one table. The server hashes it and
 *    uses it to decide whether the first order continues this visit's existing
 *    open session or starts a new persistent session on the same table.
 *
 * A visit token is NOT proof that a persistent table session exists. The
 * session is created by the first real order (or, for PAY_NOW, by successful
 * payment verification).
 */
const VISIT_TTL_MS = 4 * 60 * 60 * 1000;
const CUSTOMER_CONTEXT_NAME_PREFIX = 'tablely:tab:';
let fallbackCustomerContextId: string | null = null;

/**
 * Build 20.1 — browser-only customer visit context.
 *
 * This is deliberately separate from the server visit token, session id, device
 * token and customer identity. The browsing-context marker lives on the current
 * tab via window.name, so a new tab gets a fresh namespace while normal same-tab
 * navigation and reload preserve it. This also avoids relying on sessionStorage
 * as the identity source, because an opener can clone sessionStorage into a new tab.
 */
export function getCustomerVisitContextId() {
  if (typeof window === 'undefined') return null;
  try {
    if (window.name.startsWith(CUSTOMER_CONTEXT_NAME_PREFIX)) {
      const existing = window.name.slice(CUSTOMER_CONTEXT_NAME_PREFIX.length);
      if (existing) return existing;
    }
    const id = randomToken();
    window.name = `${CUSTOMER_CONTEXT_NAME_PREFIX}${id}`;
    return id;
  } catch {
    if (!fallbackCustomerContextId) fallbackCustomerContextId = randomToken();
    return fallbackCustomerContextId;
  }
}

export function deviceTokenKey() { return 'tablely:device'; }

/**
 * Build 20.2 — the visit token is scoped by the same per-tab browser visit
 * context that already scopes cart/coupon storage (Build 20.1), not by
 * tableCode alone. Before this, the visit token lived in plain
 * `tablely:visit:<tableCode>` localStorage, which is shared by every tab of
 * the same browser: two independent browser-tab contexts (visitContextId A
 * and B — each with its own isolated cart) could read back the SAME visit
 * token and therefore resolve to the SAME server session, contradicting the
 * per-context isolation Build 20.1 established. Keying the token exactly the
 * way cartStorageKey()/couponStorageKey() already do closes that gap without
 * touching the server resolver, the RPC signatures, or the identity model.
 *
 * Old `tablely:visit:<tableCode>` keys are intentionally NOT migrated, for
 * the same reason Build 20.1 did not migrate old cart/coupon keys: it would
 * risk leaking one browser context's in-progress visit into another.
 */
export function visitTokenKey(tableCode: string) {
  const contextId = getCustomerVisitContextId() ?? 'ssr';
  return `tablely:visit:${tableCode}:${contextId}`;
}
export function visitStartedKey(tableCode: string) {
  const contextId = getCustomerVisitContextId() ?? 'ssr';
  return `tablely:visit-started:${tableCode}:${contextId}`;
}

function randomToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

export function getOrCreateDeviceToken() {
  if (typeof window === 'undefined') return null;
  try {
    let token = window.localStorage.getItem(deviceTokenKey());
    if (!token) {
      token = randomToken();
      window.localStorage.setItem(deviceTokenKey(), token);
    }
    return token;
  } catch { return null; }
}

export function readVisitToken(tableCode: string) {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(visitTokenKey(tableCode)); } catch { return null; }
}

/** Local only. Never contacts the server, never creates a table session. */
export function getOrCreateVisitToken(tableCode: string) {
  if (typeof window === 'undefined') return null;
  try {
    const started = Number(window.localStorage.getItem(visitStartedKey(tableCode)) ?? 0);
    const existing = window.localStorage.getItem(visitTokenKey(tableCode));
    if (existing && started && Date.now() - started < VISIT_TTL_MS) return existing;
    const token = randomToken();
    window.localStorage.setItem(visitTokenKey(tableCode), token);
    window.localStorage.setItem(visitStartedKey(tableCode), String(Date.now()));
    return token;
  } catch { return null; }
}

/**
 * Explicit "a different guest is using this browser/table now" transition. It
 * only rotates local state — the previous customer's session, orders and
 * payments are untouched on the server.
 */
export function startNewVisit(tableCode: string) {
  if (typeof window === 'undefined') return null;
  try {
    window.localStorage.removeItem(visitTokenKey(tableCode));
    window.localStorage.removeItem(visitStartedKey(tableCode));
  } catch { /* storage unavailable */ }
  clearCart(tableCode);
  clearCouponCode(tableCode);
  return getOrCreateVisitToken(tableCode);
}

export type PublicMenuItem = {
  category_id: string;
  category_name: string;
  category_sort: number;
  subcategory_id: string | null;
  subcategory_name: string | null;
  subcategory_sort: number | null;
  meal_section: string | null;
  item_id: string | null;
  item_name: string | null;
  item_description: string | null;
  item_price: number | null;
  image_url: string | null;
  is_available: boolean | null;
  is_veg: boolean | null;
  is_spicy: boolean | null;
  is_recommended: boolean | null;
  is_featured: boolean | null;
  is_popular: boolean | null;
  preparation_minutes: number | null;
  dietary_tags: string[] | null;
  allergens: string[] | null;
  addons: Array<{ name: string; price: number }> | null;
  variants: Array<{ id:string; name:string; description:string|null; price_delta:number; is_default:boolean; is_available:boolean; sort_order:number; translations:Array<{language_code:string;name:string;description:string|null}> }> | null;
  modifier_groups: Array<{ id:string; name:string; description:string|null; translations:Array<{language_code:string;name:string;description:string|null}>; is_required:boolean; selection_mode:'SINGLE'|'MULTI'; min_select:number; max_select:number; sort_order:number; modifiers:Array<{id:string;name:string;description:string|null;price_delta:number;is_available:boolean;sort_order:number;translations:Array<{language_code:string;name:string;description:string|null}>}> }> | null;
  category_translations: Array<{language_code:string;name:string}> | null;
  subcategory_translations: Array<{language_code:string;name:string}> | null;
  item_translations: Array<{language_code:string;name:string;description:string|null}> | null;
};

export type CartItem = {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  imageUrl: string | null;
  note?: string;
  variant?: { id: string; name: string; priceDelta: number };
  modifiers?: Array<{ id: string; groupId: string; groupName: string; name: string; priceDelta: number }>;
  addons?: Array<{ name: string; price: number }>;
};

export type PublicOrderRow = {
  order_id: string;
  order_number: number;
  restaurant_name: string;
  table_number: number;
  status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal: number;
  tax: number;
  additional_charges: number;
  discount: number;
  total: number;
  charge_breakdown: Array<{ name: string; charge_type: 'TAX' | 'FEE'; calculation_type: 'PERCENT' | 'FIXED'; value: number; amount: number }> | null;
  created_at: string;
  payment_started_at: string | null;
  payment_expires_at: string | null;
  cancellation_reason: string | null;
  rejection_reason: string | null;
  rejection_note: string | null;
  item_id: string | null;
  item_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  selected_addons: Array<{ name: string; price: number }> | null;
  special_instructions: string | null;
  selected_options: Array<{type:string;id?:string;group_id?:string;group_name?:string;name:string;price_delta:number}> | null;
  configuration_snapshot: Record<string, unknown> | null;
};

export async function getPublicTableContext(tableCode: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_public_table_context', { p_table_code: tableCode });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('This table QR is invalid or inactive.');
  return row as PublicTableContext;
}

export async function getPublicPaymentOptions(tableCode: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_public_payment_options', { p_table_code: tableCode });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return { online_payment_enabled: Boolean(row?.online_payment_enabled), plan_id: String(row?.plan_id ?? 'STARTER') };
}

export async function getPublicOrderingOptions(tableCode: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_public_ordering_options', { p_table_code: tableCode });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    pay_at_counter_enabled: row?.pay_at_counter_enabled !== false,
    pay_later_enabled: row?.pay_later_enabled === true,
    online_payment_enabled: row?.online_payment_enabled === true,
    pay_later_available: row?.pay_later_available === true,
    plan_id: String(row?.plan_id ?? 'STARTER'),
  };
}

export type PublicCheckoutCharge = { name: string; charge_type: 'TAX' | 'FEE'; calculation_type: 'PERCENT' | 'FIXED'; value: number; amount: number };
export type PublicCouponOffer = { id:string; code:string; title:string; description:string|null; offer_type:string; discount_type:string; discount_value:number; minimum_order_amount:number; starts_at:string|null; ends_at:string|null; eligible_item_ids:string[]|null };
export type PublicCheckoutPreview = { subtotal:number; discount:number; discounted_subtotal:number; tax:number; additional_charges:number; total:number; charge_breakdown:PublicCheckoutCharge[]|null; coupon_id:string|null; coupon_code:string|null; discount_type:string|null; discount_value:number|null };

export async function getPublicActiveOffers(tableCode: string, items: CartItem[] = []) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const payload = items.map((item) => ({menu_item_id:item.menuItemId,quantity:item.quantity,note:item.note??'',addons:item.addons??[],variant_id:item.variant?.id??null,modifier_ids:(item.modifiers??[]).map(m=>m.id)}));
  const {data,error}=await supabase.rpc('get_public_active_offers_v18',{p_table_code:tableCode,p_items:payload});
  if(error) throw new Error(error.message);
  return (data??[]) as PublicCouponOffer[];
}

export async function previewPublicCheckout(tableCode:string,items:CartItem[],couponCode:string|null,customerPhone?:string) {
  const supabase=getSupabaseBrowserClient();
  if(!supabase) throw new Error('Supabase is not configured.');
  const payload=items.map(item=>({menu_item_id:item.menuItemId,quantity:item.quantity,note:item.note??'',addons:item.addons??[],variant_id:item.variant?.id??null,modifier_ids:(item.modifiers??[]).map(m=>m.id)}));
  const {data,error}=await supabase.rpc('preview_public_checkout_v18',{p_table_code:tableCode,p_items:payload,p_coupon_code:couponCode||null,p_customer_phone:customerPhone||null});
  if(error) throw new Error(error.message);
  const row=Array.isArray(data)?data[0]:data; if(!row) throw new Error('Could not calculate checkout.');
  return row as PublicCheckoutPreview;
}

export function couponStorageKey(tableCode:string){
  const contextId = getCustomerVisitContextId() ?? 'ssr';
  return `tablely:coupon:${tableCode}:${contextId}`;
}
export function saveCouponCode(tableCode:string,code:string){if(typeof window==='undefined')return;window.localStorage.setItem(couponStorageKey(tableCode),code);window.dispatchEvent(new Event('tablely-coupon-change'));}
export function readCouponCode(tableCode:string){if(typeof window==='undefined')return '';return (window.localStorage.getItem(couponStorageKey(tableCode))||'').trim().toUpperCase();}
export function clearCouponCode(tableCode:string){if(typeof window==='undefined')return;window.localStorage.removeItem(couponStorageKey(tableCode));window.dispatchEvent(new Event('tablely-coupon-change'));}

export async function getPublicCheckoutCharges(tableCode: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_public_checkout_charges', { p_table_code: tableCode });
  if (error) throw new Error(error.message);
  return (data ?? []) as PublicCheckoutCharge[];
}

export async function getPublicMenu(tableCode: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_public_menu_for_table', { p_table_code: tableCode });
  if (error) throw new Error(error.message);
  return (data ?? []) as PublicMenuItem[];
}

export async function getPublicMenuLanguageSettings(tableCode: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_public_menu_language_settings_for_table', { p_table_code: tableCode });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error('Could not load restaurant language settings.');
  const settings = data as Record<string, unknown>;
  const supported = new Set(['en', 'hi', 'bn']);
  const enabledLanguages = Array.isArray(settings.enabledLanguages)
    ? [...new Set(settings.enabledLanguages.filter((language): language is string => typeof language === 'string' && supported.has(language)))]
    : [];
  const defaultLanguage = typeof settings.defaultLanguage === 'string' && enabledLanguages.includes(settings.defaultLanguage)
    ? settings.defaultLanguage
    : enabledLanguages[0] ?? 'en';
  if (!enabledLanguages.length) enabledLanguages.push(defaultLanguage);
  return { defaultLanguage, enabledLanguages };
}

export async function createPublicOrder(args: {
  tableCode: string;
  items: CartItem[];
  paymentMethod: 'PAY_AT_COUNTER';
  idempotencyKey: string;
  couponCode?: string;
  note?: string;
  customerName?: string;
  customerPhone?: string;
}) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const payload = args.items.map((item) => ({
    menu_item_id: item.menuItemId,
    quantity: item.quantity,
    note: item.note ?? '',
    addons: item.addons ?? [],
    variant_id: item.variant?.id ?? null,
    modifier_ids: (item.modifiers ?? []).map((m) => m.id),
  }));
  const visitToken = getOrCreateVisitToken(args.tableCode);
  const { data, error } = await supabase.rpc('create_order_for_table_v18', {
    p_table_code: args.tableCode,
    p_items: payload,
    p_payment_method: args.paymentMethod,
    p_idempotency_key: args.idempotencyKey,
    p_customer_note: args.note ?? null,
    p_customer_name: args.customerName ?? null,
    p_customer_phone: args.customerPhone ?? null,
    p_coupon_code: args.couponCode ?? null,
    p_session_token: visitToken,
    p_device_token: getOrCreateDeviceToken(),
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('The order could not be created.');
  return row as { order_id: string; order_number: number; tracking_token: string; total: number; payment_status: string; status: string };
}

export async function openPayLaterSession(tableCode: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('open_pay_later_session', {
    p_table_code: tableCode,
    p_session_token: getOrCreateVisitToken(tableCode),
    p_device_token: getOrCreateDeviceToken(),
  });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) as { id: string };
}

export async function saveOrderEmailNotificationSubscription(args: {
  orderId: string;
  trackingToken: string;
  email: string;
}) {
  const response = await fetch('/api/customer/order-email-notifications', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: args.orderId,
      trackingToken: args.trackingToken,
      email: args.email,
    }),
  });

  const body = await response.json().catch(() => ({} as { error?: string }));
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not save email updates.');
  }

  return body as {
    ok: true;
    subscriptionId: string;
    email: string;
  };
}

export async function createPayLaterOrder(args: {
  tableCode: string;
  items: CartItem[];
  sessionId: string;
  idempotencyKey: string;
  couponCode?: string;
  note?: string;
}) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const payload = args.items.map((item) => ({
    menu_item_id: item.menuItemId,
    quantity: item.quantity,
    note: item.note ?? '',
    addons: item.addons ?? [],
    variant_id: item.variant?.id ?? null,
    modifier_ids: (item.modifiers ?? []).map((m) => m.id),
  }));
  const { data, error } = await supabase.rpc('create_pay_later_order_for_table', {
    p_table_code: args.tableCode,
    p_items: payload,
    p_session_id: args.sessionId,
    p_idempotency_key: args.idempotencyKey,
    p_customer_note: args.note ?? null,
    p_coupon_code: args.couponCode ?? null,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('The Pay-Later order could not be created.');
  return row as { order_id: string; order_number: number; tracking_token: string; total: number; payment_status: string; status: string };
}


export async function createPublicPaymentAttempt(args: {
  tableCode: string;
  items: CartItem[];
  idempotencyKey: string;
  note?: string;
  customerName?: string;
  customerPhone?: string;
  couponCode?: string;
}) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const payload = args.items.map((item) => ({
    menu_item_id: item.menuItemId,
    quantity: item.quantity,
    note: item.note ?? '',
    addons: item.addons ?? [],
    variant_id: item.variant?.id ?? null,
    modifier_ids: (item.modifiers ?? []).map((m) => m.id),
  }));
  const visitToken = getOrCreateVisitToken(args.tableCode);
  const { data, error } = await supabase.rpc('create_payment_attempt_for_table_v18', {
    p_table_code: args.tableCode,
    p_items: payload,
    p_idempotency_key: args.idempotencyKey,
    p_customer_note: args.note ?? null,
    p_customer_name: args.customerName ?? null,
    p_customer_phone: args.customerPhone ?? null,
    p_coupon_code: args.couponCode ?? null,
    p_session_token: visitToken,
    p_device_token: getOrCreateDeviceToken(),
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Could not start the payment session.');
  return row as { payment_attempt_id: string; attempt_token: string; total: number; payment_started_at: string; payment_expires_at: string };
}

export async function retryPublicOrder(args: {
  orderId: string;
  trackingToken: string;
  paymentMethod: 'PAY_NOW' | 'PAY_AT_COUNTER';
}) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('retry_order_after_payment_failure', {
    p_order_id: args.orderId,
    p_tracking_token: args.trackingToken,
    p_payment_method: args.paymentMethod,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Could not create the new order.');
  return row as { order_id: string; order_number: number; tracking_token: string; total: number; payment_status: string; status: string; payment_method: string };
}

export function getCustomerOrderChannel(trackingToken: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  return supabase.channel(`tablely:order:${trackingToken}`, { config: { private: false } });
}

export async function getCustomerOrderOnce(trackingToken: string) {
  return getPublicOrder(trackingToken);
}

export async function createServiceRequest(args: {
  tableCode: string;
  type: 'WAITER' | 'WATER' | 'BILL' | 'ASSISTANCE';
  note?: string;
}) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const visitToken = getOrCreateVisitToken(args.tableCode);
  const { data, error } = await supabase.rpc('create_service_request_for_table', {
    p_table_code: args.tableCode,
    p_type: args.type,
    p_note: args.note ?? null,
    p_session_token: visitToken,
    p_device_token: getOrCreateDeviceToken(),
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] : data;
}

export async function getPublicOrder(trackingToken: string) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_public_order_v2', { p_tracking_token: trackingToken });
  if (error) throw new Error(error.message);
  return (data ?? []) as PublicOrderRow[];
}

export function cartStorageKey(tableCode: string) {
  const contextId = getCustomerVisitContextId() ?? 'ssr';
  return `tablely:cart:${tableCode}:${contextId}`;
}

export function saveCart(tableCode: string, items: CartItem[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(cartStorageKey(tableCode), JSON.stringify(items));
  window.dispatchEvent(new Event('tablely-cart-change'));
}

export function readCart(tableCode: string): CartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cartStorageKey(tableCode)) ?? '[]');
    return Array.isArray(parsed) ? (parsed as CartItem[]) : [];
  } catch {
    return [];
  }
}

export function clearCart(tableCode: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(cartStorageKey(tableCode));
  window.dispatchEvent(new Event('tablely-cart-change'));
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
}
