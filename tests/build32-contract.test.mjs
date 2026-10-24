import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Build 32 migration creates tenant-keyed engagement records with RLS enabled', async () => {
  const sql = await read('supabase/migrations/20261024030000_build32_customer_engagement_retention.sql');
  for (const table of ['restaurant_whatsapp_connections','restaurant_customer_preferences','restaurant_loyalty_ledger','restaurant_customer_feedback','restaurant_google_reviews']) assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(sql, /alter table public\.%I enable row level security/);
  assert.match(sql, /revoke all on public\.%I from anon,authenticated,public/);
});

test('loyalty accrual is order-idempotent and full refunds create reversal entries', async () => {
  const sql = await read('supabase/migrations/20261024030000_build32_customer_engagement_retention.sql');
  assert.match(sql, /order:'\|\|new\.id::text\|\|':earn/);
  assert.match(sql, /on conflict\(organization_id,event_key\) do nothing/);
  assert.match(sql, /REFUND_REVERSAL/);
  assert.match(sql, /payment_status::text='REFUNDED'/);
});

test('WhatsApp delivery uses Meta Cloud API and signed webhook, with bounded retries', async () => {
  const worker = await read('app/api/cron/customer-engagement/route.ts');
  const webhook = await read('app/api/webhooks/meta-whatsapp/route.ts');
  assert.match(worker, /graph\.facebook\.com/);
  assert.match(worker, /attempts\+1/);
  assert.match(webhook, /x-hub-signature-256/);
  assert.match(webhook, /timingSafeEqual/);
  assert.match(webhook, /UNSUBSCRIBE/);
});

test('checkout preferences are separate, optional, and order-token verified', async () => {
  const route = await read('app/api/customer-engagement/preferences/route.ts');
  const checkout = await read('components/customer/CustomerCheckoutClient.tsx');
  assert.match(route, /tracking_token/);
  assert.match(route, /whatsapp_marketing/);
  assert.match(route, /feedback_messages/);
  assert.match(checkout, /whatsappServiceConsent/);
  assert.match(checkout, /whatsappMarketingConsent/);
  assert.match(checkout, /feedbackConsent/);
});

test('Google review publishing is explicit and location-mapped', async () => {
  const route = await read('app/api/engagement/google/route.ts');
  const oauth = await read('app/api/engagement/google/connect/route.ts');
  assert.match(oauth, /business\.manage/);
  assert.match(route, /verified mapped location/);
  assert.match(route, /draft_reply/);
  assert.match(route, /publish_reply/);
  assert.match(route, /method:'PUT'/);
});

test('Build 32 reuses existing menu translation data and language picker', async () => {
  const customerMenu = await read('components/customer/CustomerMenuClient.tsx');
  const settings = await read('app/customer-engagement/page.tsx');
  assert.match(customerMenu, /item_translations/);
  assert.match(customerMenu, /setLanguage/);
  assert.match(settings, /defaultLanguage/);
  assert.match(settings, /enabledLanguages/);
});

test('loyalty expiry is an idempotent service-role ledger operation with bounded batches', async () => {
  const migration = await read('supabase/migrations/20261024060000_build32_loyalty_expiry_processor.sql');
  const route = await read('app/api/cron/loyalty-expiry/route.ts');
  assert.match(migration, /entry_type='EARN'/);
  assert.match(migration, /'expiry:'\|\|expired\.id::text,'EXPIRY'/);
  assert.match(migration, /expiry:'\|\|expired\.id::text/);
  assert.match(migration, /on conflict\(organization_id,event_key\) do nothing/);
  assert.match(migration, /to service_role/);
  assert.match(route, /process_restaurant_loyalty_expiry/);
  assert.match(route, /Bearer \$\{secret\}/);
  assert.match(route, /p_limit: 500/);
});

test('completed paid customer orders expose neutral private-feedback and Google-review links only', async () => {
  const route = await read('app/api/customer-engagement/order/route.ts');
  const customerOrder = await read('components/customer/CustomerOrderClient.tsx');
  assert.match(route, /tracking_token/);
  assert.match(route, /order\.status !== 'COMPLETED' \|\| order\.payment_status !== 'PAID'/);
  assert.match(route, /restaurant_feedback_invitations/);
  assert.match(route, /restaurant_review_invitations/);
  assert.match(customerOrder, /Share your experience/);
  assert.match(customerOrder, /Give private feedback/);
  assert.match(customerOrder, /View Google review link/);
  assert.match(customerOrder, /Both options are voluntary/);
});

test('customer loyalty wallets require the signed-in identity and scope ledger rows to its profile', async () => {
  const route = await read('app/api/customer/loyalty/route.ts');
  const page = await read('app/customer/loyalty/page.tsx');
  assert.match(route, /getBearerUser\(request\)/);
  assert.match(route, /customer_profiles/);
  assert.match(route, /auth_user_id', user\.id/);
  assert.match(route, /\.eq\('customer_id', profile\.id\)/);
  assert.match(route, /MAX_ENTRIES = 10000/);
  assert.match(route, /expiredEarningsNotProcessed/);
  assert.doesNotMatch(route, /customerId.*searchParams/);
  assert.match(page, /authorization: `Bearer \$\{accessToken\}`/);
  assert.match(page, /Points redemption at checkout is not available yet/);
});

test('loyalty earning requires explicit restaurant-scoped customer consent', async () => {
  const migration = await read('supabase/migrations/20261024063127_build32_loyalty_explicit_consent.sql');
  const route = await read('app/api/customer/loyalty/route.ts');
  const page = await read('app/customer/loyalty/page.tsx');
  assert.match(migration, /loyalty_consent_at timestamptz/);
  assert.match(migration, /p\.loyalty_enrolled and p\.loyalty_consent_at is not null/);
  assert.match(migration, /p\.loyalty_consent_withdrawn_at is null/);
  assert.match(migration, /create table if not exists public\.restaurant_loyalty_consent_events/);
  assert.match(migration, /set_restaurant_loyalty_consent/);
  assert.match(migration, /grant execute on function public\.set_restaurant_loyalty_consent\(uuid,uuid,boolean\) to service_role/);
  assert.doesNotMatch(migration, /values\(v_org,v_customer,v_phone,true\)/);
  assert.match(route, /getBearerUser\(request\)/);
  assert.match(route, /set_restaurant_loyalty_consent/);
  assert.match(page, /By joining, you agree/);
  assert.match(page, /By joining, you agree/);
  assert.match(page, /Leave this program/);
});

test('feedback surveys render configured neutral questions and expose the same review link without rating gates', async () => {
  const route = await read('app/api/public-feedback/[invitationId]/route.ts');
  const page = await read('app/feedback/[invitationId]/page.tsx');
  const settings = await read('app/api/engagement/route.ts');
  assert.match(settings, /feedbackQuestionsSchema\.optional/);
  assert.match(settings, /questions,updated_by/);
  assert.match(route, /getQuestions\(setting\?\.questions\)/);
  assert.match(route, /restaurant_review_invitations/);
  assert.match(route, /reviewUrl:review\?/);
  assert.match(route, /answers/);
  assert.match(page, /Your honest experience helps the restaurant improve/);
  assert.match(page, /regardless of your private feedback/);
  assert.match(page, /reviewUrl/);
});

test('feedback email consent is separate from order updates and marketing', async () => {
  const migration = await read('supabase/migrations/20261024064200_build32_feedback_email_delivery.sql');
  const route = await read('app/api/customer-engagement/preferences/route.ts');
  const checkout = await read('components/customer/CustomerCheckoutClient.tsx');
  const engagement = await read('app/api/engagement/route.ts');
  assert.match(migration, /feedback_email_consent_at timestamptz/);
  assert.match(migration, /feedback_email_consent_source text/);
  assert.match(migration, /feedback_email_withdrawn_at timestamptz/);
  assert.match(migration, /check\(channel in \('IN_APP','WHATSAPP','EMAIL'\)\)/);
  assert.match(route, /feedbackEmail:z\.boolean\(\)\.optional\(\)/);
  assert.match(route, /feedback_email_consent_version/);
  assert.match(route, /feedback_email_consent_source:'ORDER_CHECKOUT'/);
  assert.match(checkout, /emailFeedbackConsent/);
  assert.match(checkout, /Email me once for private feedback after my visit/);
  assert.match(checkout, /emailNotifications:emailUpdatesEnabled/);
  assert.match(engagement, /channel:z\.enum\(\['IN_APP','WHATSAPP','EMAIL'\]\)/);
});

test('feedback email worker verifies consent and paid completion, uses Resend, and retries a bounded number of times', async () => {
  const worker = await read('app/api/cron/customer-engagement-email/route.ts');
  const unsubscribe = await read('app/api/customer-engagement/email-unsubscribe/route.ts');
  const migration = await read('supabase/migrations/20261024064200_build32_feedback_email_delivery.sql');
  assert.match(worker, /CRON_SECRET/);
  assert.match(worker, /RESEND_API_KEY/);
  assert.match(worker, /api\.resend\.com\/emails/);
  assert.match(worker, /order\?\.status === 'COMPLETED'/);
  assert.match(worker, /order\.payment_status === 'PAID'/);
  assert.match(worker, /feedback_email_withdrawn_at/);
  assert.match(worker, /MAX_ATTEMPTS = 5/);
  assert.match(worker, /attempts: nextAttempt/);
  assert.match(worker, /status: 'SENT'/);
  assert.match(worker, /email-unsubscribe\?invitationId=/);
  assert.match(migration, /feedback_email_consent_at is not null/);
  assert.match(migration, /feedback_email_withdrawn_at is null/);
  assert.match(migration, /'order:'\|\|new\.id::text\|\|':FEEDBACK_EMAIL'/);
  assert.match(unsubscribe, /timingSafeEqual/);
  assert.match(unsubscribe, /feedback_email_withdrawn_at/);
  assert.match(unsubscribe, /feedback_email_consent_withdrawn/);
});

test('restaurant engagement reads require settings access and feedback triage is branch-scoped', async () => {
  const route = await read('app/api/engagement/route.ts');
  const google = await read('app/api/engagement/google/route.ts');
  assert.match(route, /export async function GET\(\)\{\s*const x=await context\(\);if\('error'in x\)return x\.error;\s*if\(!\(await ownerOnly\(x\)\)\)/);
  assert.match(route, /restaurant_customer_feedback'\)\.select\([^;]+\.eq\('organization_id',org\)\.eq\('branch_id',branch\)/);
  assert.match(route, /update\(\{status:b\.status[^;]+\.eq\('id',b\.feedbackId\)\.eq\('organization_id',org\)\.eq\('branch_id',branch\)/);
  assert.match(google, /if\(!x\.ctx\.branches\.some\(v=>v\.id===review\.branch_id\)\)return NextResponse\.json\(\{error:'Branch access denied\.'\}/);
});

test('WhatsApp STOP revokes every WhatsApp consent and delivery events cannot downgrade status', async () => {
  const webhook = await read('app/api/webhooks/meta-whatsapp/route.ts');
  const worker = await read('app/api/cron/customer-engagement/route.ts');
  assert.match(webhook, /feedback_messages: false/);
  assert.match(webhook, /\.eq\('phone', tail\)/);
  assert.match(webhook, /customer_withdrew_whatsapp_consent/);
  assert.match(webhook, /statusError/);
  assert.match(webhook, /Webhook event could not be durably recorded/);
  assert.doesNotMatch(webhook, /\.like\('phone'/);
  assert.match(worker, /\[payload\.customerName\?\.'Customer',payload\.orderNumber\?\?''/);
  assert.match(worker, /\.eq\('status','SENDING'\)/);
  assert.match(worker, /\.eq\('branch_id',row\.branch_id\)/);
});

test('Build 32 reporting is aggregated without list caps and public language settings follow restaurant configuration', async () => {
  const route = await read('app/api/engagement/route.ts');
  const migration = await read('supabase/migrations/20261024070000_build32_metrics_language_phone_hardening.sql');
  const publicMenu = await read('components/customer/CustomerMenuClient.tsx');
  const settingsRoute = await read('app/api/engagement/route.ts');
  assert.match(route, /restaurant_engagement_branch_metrics/);
  assert.match(migration, /restaurant_engagement_branch_metrics/);
  assert.match(migration, /restaurant_customer_preferences_anon_phone_uidx/);
  assert.match(migration, /get_public_menu_language_settings_for_table/);
  assert.match(publicMenu, /getPublicMenuLanguageSettings/);
  assert.match(settingsRoute, /auto_translate:false/);
});

test('The engagement dashboard no longer offers a nonfunctional AI-translation toggle', async () => {
  const page = await read('app/customer-engagement/page.tsx');
  assert.doesNotMatch(page, /AI translation|autoTranslate/);
  assert.match(page, /entered and reviewed manually/);
});
