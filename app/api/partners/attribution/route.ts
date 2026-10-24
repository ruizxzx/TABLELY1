import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema = z.object({ website: z.string().max(300).optional(), googleBusiness: z.string().max(300).optional(), gstin: z.string().max(20).optional() });

export async function POST(request: Request) {
  const values = schema.safeParse(await request.json().catch(() => ({})));
  if (!values.success) return NextResponse.json({ error: 'Invalid business verification details.' }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: 'Server configuration is incomplete.' }, { status: 503 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email_confirmed_at) return NextResponse.json({ error: 'Confirm your email before linking a referral.' }, { status: 401 });
  const cookieStore = await cookies();
  const token = cookieStore.get('tablely_referral_tracking')?.value;
  if (!token) return NextResponse.json({ ok: true, attributed: false });
  const { data: click } = await admin.from('tablely_referral_clicks').select('id,partner_id,clicked_at,expires_at,claimed_at').eq('tracking_id', token).maybeSingle();
  if (!click || click.claimed_at || new Date(click.expires_at).getTime() < Date.now()) return NextResponse.json({ ok: true, attributed: false });
  const { data: partner } = await admin.from('tablely_partners').select('id,status,email,phone').eq('id', click.partner_id).maybeSingle();
  if (partner?.status !== 'APPROVED') return NextResponse.json({ ok: true, attributed: false });
  const { data: staff } = await admin.from('staff').select('organization_id,role').eq('user_id', user.id).eq('active', true).eq('role', 'OWNER').order('created_at').limit(1).maybeSingle();
  if (!staff?.organization_id) return NextResponse.json({ error: 'Finish creating your restaurant first.' }, { status: 409 });
  const { data: org } = await admin.from('organizations').select('id,name,owner_id,created_at').eq('id', staff.organization_id).eq('owner_id', user.id).maybeSingle();
  if (!org || new Date(org.created_at).getTime() < new Date(click.clicked_at).getTime()) return NextResponse.json({ ok: true, attributed: false });
  const { data: branch } = await admin.from('branches').select('name,address,phone').eq('organization_id', org.id).order('created_at').limit(1).maybeSingle();
  const { data: profile } = await admin.from('profiles').select('full_name,phone').eq('id', user.id).maybeSingle();
  const flags: string[] = [];
  const phone = user.phone ?? profile?.phone ?? branch?.phone ?? '';
  if (partner.email.toLowerCase() === (user.email ?? '').toLowerCase() || (phone && partner.phone === phone)) flags.push('PARTNER_SELF_REFERRAL');
  if (phone) {
    const { data: duplicate } = await admin.from('profiles').select('id').eq('phone', phone).neq('id', user.id).limit(1);
    if (duplicate?.length) flags.push('PHONE_MATCH');
  }
  if (user.email) {
    const { data: emailMatch } = await admin.from('organizations').select('id').eq('business_email', user.email).neq('id', org.id).limit(1);
    if (emailMatch?.length) flags.push('EMAIL_MATCH');
  }
  if (branch?.address) {
    const { data: addressMatch } = await admin.from('branches').select('id').eq('address', branch.address).neq('organization_id', org.id).limit(1);
    if (addressMatch?.length) flags.push('ADDRESS_MATCH');
  }
  const businessUrl = values.data.website || null;
  if (businessUrl) {
    let host='';try{host=new URL(businessUrl).hostname.replace(/^www\./,'').toLowerCase().replace(/[^a-z0-9.-]/g,'')}catch{}
    if (host) {
      const [{ data: websiteMatches },{data:googleMatches}] = await Promise.all([
        admin.from('tablely_partner_referrals').select('id').ilike('website_url',`%${host}%`).neq('restaurant_organization_id',org.id).limit(1),
        admin.from('tablely_partner_referrals').select('id').ilike('google_business_url',`%${host}%`).neq('restaurant_organization_id',org.id).limit(1),
      ]);
      if (websiteMatches?.length||googleMatches?.length) flags.push('WEBSITE_DOMAIN_MATCH');
    }
  }
  if (values.data.gstin) {
    const { data: taxMatches } = await admin.from('tablely_partner_referrals').select('id').eq('gstin',values.data.gstin.toUpperCase()).neq('restaurant_organization_id',org.id).limit(1);
    if (taxMatches?.length) flags.push('GSTIN_MATCH');
  }
  const meta = user.user_metadata ?? {};
  const { error } = await admin.from('tablely_partner_referrals').insert({
    partner_id: partner.id, restaurant_organization_id: org.id, click_id: click.id,
    submitted_restaurant_name: String(meta.restaurant_name ?? org.name), submitted_owner_name: String(profile?.full_name ?? meta.full_name ?? ''),
    submitted_phone: String(phone), submitted_email: user.email, submitted_address: String(branch?.address ?? meta.restaurant_address ?? ''), submitted_branch: branch?.name ?? null,
    website_url: businessUrl, google_business_url: values.data.googleBusiness || null, gstin: values.data.gstin?.toUpperCase() || null,
    status: flags.includes('PARTNER_SELF_REFERRAL') ? 'REJECTED' : flags.length ? 'NEEDS_REVIEW' : 'BUSINESS_VERIFICATION_PENDING', fraud_flags: flags, locked_at: new Date().toISOString(),
  });
  if (error && error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 400 });
  await admin.from('tablely_referral_clicks').update({ claimed_at: new Date().toISOString() }).eq('id', click.id).is('claimed_at', null);
  cookieStore.delete('tablely_referral_tracking');
  return NextResponse.json({ ok: true, attributed: error?.code !== '23505', status: flags.includes('PARTNER_SELF_REFERRAL') ? 'REJECTED' : flags.length ? 'NEEDS_REVIEW' : 'BUSINESS_VERIFICATION_PENDING' });
}
