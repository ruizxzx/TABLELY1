import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { assertSameOrigin, getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getCreatorEntitlements, featureDenied } from '../../../lib/server-entitlements';

export const dynamic = 'force-dynamic';
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

const SEGMENT_OPERATORS = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'after', 'before', 'exists', 'not_exists']);
const SEGMENT_FIELDS = new Set(['status', 'tags', 'source', 'product_purchased', 'has_purchased', 'purchase_count', 'total_spent', 'last_purchase_date', 'signup_date', 'email_engagement']);

type SegmentValidation =
  | { valid: true; normalized: { connector: 'AND' | 'OR'; conditions: Record<string, unknown>[] } }
  | { valid: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (value === null || value === undefined) return null;
  return String(value);
}

function compareScalar(left: string | number | boolean | string[] | null | undefined, operator: string, value: unknown): boolean {
  const right = normalizeValue(value);
  const leftValues = Array.isArray(left) ? left.map((entry) => normalizeValue(entry)) : [left];

  switch (operator) {
    case 'equals': return leftValues.some((entry) => entry === right);
    case 'not_equals': return leftValues.every((entry) => entry !== right);
    case 'contains': {
      if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase().includes(right.toLowerCase());
      if (Array.isArray(left)) return left.some((entry) => typeof entry === 'string' && typeof right === 'string' && entry.toLowerCase().includes(right.toLowerCase()));
      return false;
    }
    case 'not_contains': {
      if (typeof left === 'string' && typeof right === 'string') return !left.toLowerCase().includes(right.toLowerCase());
      return true;
    }
    case 'in': {
      if (Array.isArray(right)) return leftValues.some((entry) => right.some((candidate) => normalizeValue(candidate) === entry));
      return leftValues.some((entry) => entry === right);
    }
    case 'not_in': {
      if (Array.isArray(right)) return leftValues.every((entry) => !right.some((candidate) => normalizeValue(candidate) === entry));
      return leftValues.every((entry) => entry !== right);
    }
    case 'gt': return typeof left === 'number' && typeof right === 'number' ? left > right : false;
    case 'gte': return typeof left === 'number' && typeof right === 'number' ? left >= right : false;
    case 'lt': return typeof left === 'number' && typeof right === 'number' ? left < right : false;
    case 'lte': return typeof left === 'number' && typeof right === 'number' ? left <= right : false;
    case 'exists': return left != null && left !== '' && left !== false;
    case 'not_exists': return left == null || left === '' || left === false;
    case 'after': {
      if (left == null || right == null || typeof left !== 'string' || typeof right !== 'string') return false;
      return new Date(left).getTime() > new Date(right).getTime();
    }
    case 'before': {
      if (left == null || right == null || typeof left !== 'string' || typeof right !== 'string') return false;
      return new Date(left).getTime() < new Date(right).getTime();
    }
    default: return false;
  }
}

function validateSegmentDefinition(definition: unknown): SegmentValidation {
  if (!isPlainObject(definition)) return { valid: false, message: 'Segment definition must be an object.' };
  const root = definition as Record<string, unknown>;
  const conditions = Array.isArray(root.conditions) ? (root.conditions as Record<string, unknown>[]) : [];
  const connector = root.connector === 'OR' ? 'OR' : 'AND';
  if (!conditions.length) return { valid: true, normalized: { connector, conditions: [] } };

  const walk = (value: unknown, path = 'root'): SegmentValidation => {
    if (!isPlainObject(value)) return { valid: false, message: `Invalid condition at ${path}.` };
    if (value.type === 'group') {
      const nested = Array.isArray(value.conditions) ? value.conditions : [];
      for (let index = 0; index < nested.length; index += 1) {
        const result = walk(nested[index], `${path}.conditions[${index}]`);
        if (!result.valid) return result;
      }
      if (value.connector && value.connector !== 'AND' && value.connector !== 'OR') return { valid: false, message: `Unsupported group connector at ${path}.` };
      return { valid: true, normalized: { connector: 'AND', conditions: [] } };
    }

    const operator = typeof value.operator === 'string' ? value.operator : '';
    const field = typeof value.field === 'string' ? value.field : '';
    if (!SEGMENT_FIELDS.has(field)) return { valid: false, message: `Unsupported field at ${path}: ${field || 'missing'}` };
    if (!SEGMENT_OPERATORS.has(operator)) return { valid: false, message: `Unsupported operator at ${path}: ${operator || 'missing'}` };
    return { valid: true, normalized: { connector: 'AND', conditions: [] } };
  };

  for (let index = 0; index < conditions.length; index += 1) {
    const result = walk(conditions[index], `conditions[${index}]`);
    if (!result.valid) return result;
  }

  return { valid: true, normalized: { connector, conditions } };
}

async function evaluateSegment(storeId: string, definition: Record<string, unknown>, db: any) {
  const validation = validateSegmentDefinition(definition);
  if (!validation.valid) return { ok: false, error: validation.message || 'Segment definition is invalid.' };

  const normalizedDefinition = validation.normalized;
  const { data: subscribers, error: subscriberError } = await db.from('email_subscribers').select('id,email,status,source,created_at,last_seen_at').eq('store_id', storeId).order('created_at', { ascending: false });
  if (subscriberError) throw subscriberError;

  const tagsMap = new Map<string, Set<string>>();
  const tagMembers = await db.from('email_subscriber_tag_members').select('subscriber_id, tag_id');
  const relevantTagIds = tagMembers && tagMembers.data ? tagMembers.data.map((row: any) => row.tag_id) : [];
  const tagNameMap = new Map<string, string>();
  if (relevantTagIds.length) {
    const { data: tagMeta } = await db.from('email_subscriber_tags').select('id,name').in('id', relevantTagIds);
    (tagMeta || []).forEach((row: any) => tagNameMap.set(String(row.id), String(row.name)));
  }
  for (const row of tagMembers?.data || []) {
    const key = String(row.subscriber_id);
    const names = tagsMap.get(key) || new Set<string>();
    const tagName = tagNameMap.get(String(row.tag_id));
    if (tagName) names.add(tagName);
    tagsMap.set(key, names);
  }

  const orderRows = await db.from('orders').select('id,store_id,buyer_email,gross_amount,status,created_at,product_id').eq('store_id', storeId).eq('status', 'paid');
  const spentMap = new Map<string, number>();
  const purchaseCounts = new Map<string, number>();
  const lastPurchaseMap = new Map<string, string>();
  const purchasedProducts = new Map<string, Set<string>>();
  for (const row of orderRows.data || []) {
    const key = String((row.buyer_email || '').trim().toLowerCase());
    const amount = Number(row.gross_amount || 0);
    purchaseCounts.set(key, (purchaseCounts.get(key) || 0) + 1);
    spentMap.set(key, (spentMap.get(key) || 0) + amount);
    const existing = lastPurchaseMap.get(key) || String(row.created_at || '');
    if (!existing || new Date(String(row.created_at || '')).getTime() > new Date(existing).getTime()) lastPurchaseMap.set(key, String(row.created_at || ''));
    const productSet = purchasedProducts.get(key) || new Set<string>();
    const productName = row.product_id ? String(row.product_id) : 'product';
    productSet.add(productName);
    purchasedProducts.set(key, productSet);
  }

  const campaignRows = await db.from('email_campaign_recipients').select('campaign_id,subscriber_id,opened_at,clicked_at,status');
  const openedBySubscriber = new Map<string, number>();
  const clickedBySubscriber = new Map<string, number>();
  if (campaignRows.data && campaignRows.data.length) {
    for (const row of campaignRows.data) {
      const key = String(row.subscriber_id);
      if (row.opened_at) openedBySubscriber.set(key, (openedBySubscriber.get(key) || 0) + 1);
      if (row.clicked_at) clickedBySubscriber.set(key, (clickedBySubscriber.get(key) || 0) + 1);
    }
  }

  const eligible = (subscribers || []).filter((subscriber: any) => {
    const emailKey = String(subscriber.email || '').trim().toLowerCase();
    const names = tagsMap.get(String(subscriber.id)) || new Set<string>();
    const productSet = purchasedProducts.get(emailKey) || new Set<string>();
    const matches = (condition: Record<string, any>): boolean => {
      const type = String(condition.type || 'condition');
      if (type === 'group') {
        const connector = (condition.connector || 'AND').toUpperCase();
        const nested = Array.isArray(condition.conditions) ? condition.conditions : [];
        const result = nested.map((entry) => matches(entry));
        return connector === 'OR' ? result.some(Boolean) : result.every(Boolean);
      }
      const field = String(condition.field || '');
      const op = String(condition.operator || 'equals');
      const value = normalizeValue(condition.value);
      switch (field) {
        case 'status': return compareScalar(String(subscriber.status || 'active'), op, value);
        case 'tags': return compareScalar(Array.from(names), op, value);
        case 'source': return compareScalar(String(subscriber.source || ''), op, value);
        case 'product_purchased': return compareScalar(Array.from(productSet), op, value);
        case 'has_purchased': return compareScalar(Boolean((purchaseCounts.get(emailKey) || 0) > 0), op, value);
        case 'purchase_count': return compareScalar(Number(purchaseCounts.get(emailKey) || 0), op, Number(value));
        case 'total_spent': return compareScalar(Number(spentMap.get(emailKey) || 0), op, Number(value));
        case 'last_purchase_date': return compareScalar(lastPurchaseMap.get(emailKey) || null, op, value);
        case 'signup_date': return compareScalar(String(subscriber.created_at || ''), op, value);
        case 'email_engagement': {
          const engagement = String(value || '').toLowerCase();
          if (engagement === 'opened_campaign') return compareScalar(Boolean((openedBySubscriber.get(String(subscriber.id)) || 0) > 0), op, true);
          if (engagement === 'clicked_campaign') return compareScalar(Boolean((clickedBySubscriber.get(String(subscriber.id)) || 0) > 0), op, true);
          if (engagement === 'never_opened') return compareScalar(Boolean((openedBySubscriber.get(String(subscriber.id)) || 0) === 0), op, true);
          return false;
        }
        default: return false;
      }
    };

    const conditions = Array.isArray(normalizedDefinition.conditions) ? normalizedDefinition.conditions : [];
    if (!conditions.length) return false;
    const connector = String(normalizedDefinition.connector || 'AND').toUpperCase();
    const results = conditions.map((entry) => matches(entry as Record<string, any>));
    return connector === 'OR' ? results.some(Boolean) : results.every(Boolean);
  });

  return { ok: true, count: eligible.length, preview: eligible.slice(0, 10).map((subscriber: any) => ({ id: subscriber.id, email: subscriber.email, status: subscriber.status })) };
}

async function campaignAnalyticsForStore(storeId: string, db: any) {
  const { data: campaigns, error: campaignError } = await db.from('email_campaigns').select('id,name,subject,audience,status,created_at,sent_at').eq('store_id', storeId).order('created_at', { ascending: false });
  if (campaignError) throw campaignError;
  const campaignRows = campaigns || [];
  const subscriberMap = new Map<string, any>();
  const { data: subscribers, error: subscriberError } = await db.from('email_subscribers').select('id,email,status').eq('store_id', storeId);
  if (subscriberError) throw subscriberError;
  (subscribers || []).forEach((subscriber: any) => subscriberMap.set(String(subscriber.id), subscriber));

  const results = await Promise.all(campaignRows.map(async (campaign: any) => {
    const { data: recipients, error: recipientError } = await db.from('email_campaign_recipients').select('id,subscriber_id,status,sent_at,opened_at,clicked_at').eq('campaign_id', campaign.id);
    if (recipientError) throw recipientError;
    const rows = recipients || [];
    const sent = rows.filter((row: any) => row.status === 'sent' || !!row.sent_at).length;
    const delivered = sent;
    const failed = rows.filter((row: any) => row.status === 'failed').length;
    const bounced = rows.filter((row: any) => row.status === 'bounced').length;
    const opened = rows.filter((row: any) => !!row.opened_at).length;
    const clicked = rows.filter((row: any) => !!row.clicked_at).length;
    const unsubscribed = rows.filter((row: any) => subscriberMap.get(String(row.subscriber_id))?.status === 'unsubscribed').length;
    const openRate = delivered ? (opened / delivered) * 100 : 0;
    const clickRate = delivered ? (clicked / delivered) * 100 : 0;
    const unsubscribeRate = rows.length ? (unsubscribed / rows.length) * 100 : 0;
    const bounceRate = delivered ? (bounced / delivered) * 100 : 0;
    return {
      id: campaign.id,
      name: campaign.name,
      subject: campaign.subject,
      audience: campaign.audience || { type: 'all' },
      status: campaign.status,
      sentAt: campaign.sent_at || null,
      recipients: rows.length,
      sent,
      delivered,
      failed,
      bounced,
      opened,
      openRate,
      clicked,
      clickRate,
      unsubscribed,
      unsubscribeRate,
      bounceRate,
    };
  }));

  return results;
}

async function creatorContext(userId: string) {
  const db = getAdminSupabase();
  const { data: store, error } = await db.from('stores').select('id').eq('owner_id', userId).maybeSingle();
  if (error) throw error;
  return { db, store };
}

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'studio-marketing-data', 30);
  if (limited) return limited;
  try {
    const user = await getBearerUser(request);
    if (!user) return fail('Unauthorized', 401);
    const { db, store } = await creatorContext(user.id);
    const entitlements = await getCreatorEntitlements(user.id);
    if (!entitlements.features.email_marketing) return NextResponse.json(featureDenied(entitlements, 'email_marketing', 'creator'), { status: 403 });
    const url = new URL(request.url);
    const mode = String(url.searchParams.get('mode') || '').trim();
    if (!store) {
      if (mode === 'campaign-analytics') return NextResponse.json({ ok: true, data: [] });
      return NextResponse.json({ ok: true, data: { subscribers: [], tags: [], segments: [], campaigns: [] } });
    }
    if (mode === 'campaign-analytics') {
      const analytics = await campaignAnalyticsForStore(store.id, db);
      return NextResponse.json({ ok: true, data: analytics });
    }
    const search = String(url.searchParams.get('search') || '').trim().slice(0, 120);
    const subscriberQuery = db.from('email_subscribers').select('id,email,source,status,created_at,last_seen_at,unsubscribed_at').eq('store_id', store.id).order('created_at', { ascending: false }).limit(1000);
    const [{ data: subscribers, error: subscriberError }, { data: tags, error: tagError }, { data: segments, error: segmentError }, { data: campaigns, error: campaignError }] = await Promise.all([
      search ? subscriberQuery.ilike('email', `%${search}%`) : subscriberQuery,
      db.from('email_subscriber_tags').select('id,name,created_at').eq('store_id', store.id).order('name'),
      db.from('email_segments').select('id,name,definition,created_at,updated_at').eq('store_id', store.id).order('name'),
      db.from('email_campaigns').select('id,name,subject,preview_text,audience,status,scheduled_at,sent_at,created_at,updated_at').eq('store_id', store.id).order('created_at', { ascending: false }).limit(100),
    ]);
    if (subscriberError || tagError || segmentError || campaignError) throw subscriberError || tagError || segmentError || campaignError;
    return NextResponse.json({ ok: true, data: { subscribers: subscribers || [], tags: tags || [], segments: segments || [], campaigns: campaigns || [] } });
  } catch (error) {
    console.error('[studio/marketing:get]', error);
    return fail('Could not load email marketing data.', 500);
  }
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'studio-marketing-write', 30);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Unauthorized', 401);
    const body = await request.json() as Record<string, any>;
    const action = String(body.action || '');
    const { db, store } = await creatorContext(user.id);
    if (!store) return fail('Store not found.', 404);
    const entitlements = await getCreatorEntitlements(user.id);
    const requiresMarketing = ['create_tag', 'tag_subscriber', 'save_segment', 'evaluate_segment', 'get_campaign_analytics', 'create_campaign', 'update_campaign', 'schedule_campaign', 'configure_welcome', 'configure_automation'].includes(action);
    if (requiresMarketing && !entitlements.features.email_marketing) return NextResponse.json(featureDenied(entitlements, 'email_marketing', 'creator'), { status: 403 });

    if (action === 'create_tag') {
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return fail('Tag name is required.');
      const { data, error } = await db.from('email_subscriber_tags').insert({ store_id: store.id, name }).select('*').single();
      if (error) return fail(error.code === '23505' ? 'That tag already exists.' : error.message, error.code === '23505' ? 409 : 400);
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'tag_subscriber') {
      const subscriberId = String(body.subscriberId || '');
      const tagId = String(body.tagId || '');
      const [{ data: subscriber }, { data: tag }] = await Promise.all([
        db.from('email_subscribers').select('id').eq('id', subscriberId).eq('store_id', store.id).maybeSingle(),
        db.from('email_subscriber_tags').select('id').eq('id', tagId).eq('store_id', store.id).maybeSingle(),
      ]);
      if (!subscriber || !tag) return fail('Subscriber or tag not found.', 404);
      const { error } = await db.from('email_subscriber_tag_members').upsert({ subscriber_id: subscriber.id, tag_id: tag.id });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (action === 'save_segment') {
      const name = String(body.name || '').trim().slice(0, 80);
      const definition = body.definition && typeof body.definition === 'object' ? body.definition : {};
      if (!name) return fail('Segment name is required.');
      const validation = validateSegmentDefinition(definition);
      if (!validation.valid) return fail(validation.message || 'Invalid segment definition.', 400);
      const { data, error } = await db.from('email_segments').upsert({ store_id: store.id, name, definition: validation.normalized, updated_at: new Date().toISOString() }, { onConflict: 'store_id,name' }).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'evaluate_segment') {
      const definition = body.definition && typeof body.definition === 'object' ? body.definition : {};
      const validation = validateSegmentDefinition(definition);
      if (!validation.valid) return fail(validation.message || 'Invalid segment definition.', 400);
      const result = await evaluateSegment(store.id, validation.normalized, db);
      if (!result.ok) return fail(result.error || 'Segment could not be evaluated.', 400);
      return NextResponse.json({ ok: true, data: result });
    }

    if (action === 'get_campaign_analytics') {
      const analytics = await campaignAnalyticsForStore(store.id, db);
      return NextResponse.json({ ok: true, data: analytics });
    }

    if (action === 'create_campaign' || action === 'update_campaign') {
      const campaignId = action === 'update_campaign' ? String(body.campaignId || '') : '';
      const payload = { store_id: store.id, name: String(body.name || '').trim().slice(0, 120), subject: String(body.subject || '').trim().slice(0, 180), preview_text: String(body.previewText || '').trim().slice(0, 240) || null, content_html: String(body.contentHtml || '').slice(0, 200000), audience: body.audience && typeof body.audience === 'object' ? body.audience : { type: 'all' }, updated_at: new Date().toISOString() };
      if (!payload.name || !payload.subject || !payload.content_html) return fail('Campaign name, subject, and content are required.');
      const query = action === 'update_campaign' ? db.from('email_campaigns').update(payload).eq('id', campaignId).eq('store_id', store.id).eq('status', 'draft') : db.from('email_campaigns').insert({ ...payload, status: 'draft' });
      const { data, error } = await query.select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'schedule_campaign') {
      const campaignId = String(body.campaignId || '');
      const scheduledAt = body.scheduledAt ? new Date(String(body.scheduledAt)) : new Date();
      if (!campaignId || !Number.isFinite(scheduledAt.getTime())) return fail('Choose a valid campaign schedule.');
      const { data, error } = await db.from('email_campaigns').update({ status: 'scheduled', scheduled_at: scheduledAt.toISOString(), updated_at: new Date().toISOString() }).eq('id', campaignId).eq('store_id', store.id).eq('status', 'draft').select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'configure_welcome' || action === 'configure_automation') {
      const triggerType = String(body.triggerType || (action === 'configure_welcome' ? 'new_subscriber' : '')).trim();
      const allowedTriggerTypes = ['new_subscriber', 'customer_purchase', 'day_after_signup', 'segment_match'];
      if (!allowedTriggerTypes.includes(triggerType)) return fail('Unsupported automation trigger type.', 400);
      const campaignId = String(body.campaignId || '');
      const segmentId = String(body.segmentId || '');
      const enabled = body.enabled !== false;
      const delaySeconds = Number(body.delaySeconds ?? 0);
      const nextRunAt = body.nextRunAt ? new Date(String(body.nextRunAt)) : null;
      const payload: Record<string, any> = {
        store_id: store.id,
        trigger_type: triggerType,
        campaign_id: campaignId,
        segment_id: segmentId || null,
        enabled,
        delay_seconds: Number.isFinite(delaySeconds) ? Math.max(0, delaySeconds) : 0,
        next_run_at: nextRunAt && Number.isFinite(nextRunAt.getTime()) ? nextRunAt.toISOString() : null,
        metadata: isPlainObject(body.metadata) ? body.metadata : {},
        updated_at: new Date().toISOString(),
      };
      if (!campaignId) return fail('Campaign selection is required.', 400);
      const { data, error } = await db.from('email_automations').upsert({ ...payload }, { onConflict: 'store_id,trigger_type' }).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    return fail('Unsupported email marketing action.');
  } catch (error) {
    console.error('[studio/marketing:post]', error);
    return fail(error instanceof Error ? error.message : 'Could not update email marketing.', 500);
  }
}