import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAdminSupabase } from '@/app/lib/server-admin';
import { getBearerUser, withRateLimit } from '@/app/lib/server-security';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 1000;
const MAX_ENTRIES = 10000;
const consentSchema = z.object({
  organizationId: z.string().uuid(),
  enrolled: z.boolean(),
});

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

type LedgerEntry = {
  id: string;
  organization_id: string;
  order_id: string | null;
  event_key: string;
  entry_type: string;
  points: number;
  amount: number | null;
  expires_at: string | null;
  reverses_entry_id: string | null;
  created_at: string;
};

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'customer-loyalty-wallet', 30);
  if (limited) return limited;

  try {
    const user = await getBearerUser(request);
    if (!user) return privateJson({ error: 'Sign in to view your loyalty accounts.' }, 401);

    const db = getAdminSupabase();
    const { data: profile, error: profileError } = await db
      .from('customer_profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return privateJson({ wallets: [] });

    const entries: LedgerEntry[] = [];
    for (let offset = 0; offset < MAX_ENTRIES; offset += PAGE_SIZE) {
      const { data, error } = await db
        .from('restaurant_loyalty_ledger')
        .select('id,organization_id,order_id,event_key,entry_type,points,amount,expires_at,reverses_entry_id,created_at')
        .eq('customer_id', profile.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;
      entries.push(...(data ?? []) as LedgerEntry[]);
      if (!data || data.length < PAGE_SIZE) break;
      if (offset + PAGE_SIZE >= MAX_ENTRIES) {
        return privateJson({ error: 'Your loyalty history is too large to load right now.' }, 503);
      }
    }

    const [{ data: programs, error: programsError }, { data: preferences, error: preferencesError }] = await Promise.all([
      db.from('restaurant_loyalty_programs').select('organization_id,enabled,currency_per_point,points_expire_days,points_per_currency,minimum_redemption_points').eq('enabled', true).limit(500),
      db.from('restaurant_customer_preferences').select('organization_id,loyalty_enrolled,loyalty_consent_at,loyalty_consent_withdrawn_at').eq('customer_id', profile.id),
    ]);
    if (programsError) throw programsError;
    if (preferencesError) throw preferencesError;

    const organizationIds = [...new Set([
      ...entries.map((entry) => entry.organization_id),
      ...(programs ?? []).map((program) => program.organization_id),
      ...(preferences ?? []).map((preference) => preference.organization_id),
    ])];
    if (!organizationIds.length) return privateJson({ wallets: [] });

    const { data: organizations, error: organizationsError } = await db
      .from('organizations')
      .select('id,name,status')
      .in('id', organizationIds);
    if (organizationsError) throw organizationsError;

    const now = Date.now();
    const activeOrganizations = new Set((organizations ?? []).filter((row) => row.status === 'ACTIVE').map((row) => row.id));
    const wallets = organizationIds.filter((id) => activeOrganizations.has(id)).map((organizationId) => {
      const ledger = entries.filter((entry) => entry.organization_id === organizationId);
      const balanceFromLedger = ledger.reduce((sum, entry) => sum + Number(entry.points), 0);
      const expiredEarningsNotProcessed = ledger
        .filter((entry) => entry.entry_type === 'EARN' && entry.expires_at && Date.parse(entry.expires_at) <= now)
        .reduce((sum, earning) => {
          const expiryRecorded = ledger.some((entry) =>
            entry.entry_type === 'EXPIRY'
            && (entry.reverses_entry_id === earning.id || entry.event_key === `expiry:${earning.id}`)
          );
          if (expiryRecorded) return sum;

          const reversalPoints = ledger
            .filter((entry) => entry.reverses_entry_id === earning.id)
            .reduce((total, entry) => total + Number(entry.points), 0);
          const refundPoints = earning.order_id
            ? ledger
              .filter((entry) => entry.entry_type === 'REFUND_REVERSAL' && entry.order_id === earning.order_id && !entry.reverses_entry_id)
              .reduce((total, entry) => total + Number(entry.points), 0)
            : 0;
          return sum + Math.max(0, Number(earning.points) + reversalPoints + refundPoints);
        }, 0);
      const organization = organizations?.find((row) => row.id === organizationId);
      const program = programs?.find((row) => row.organization_id === organizationId);
      const preference = preferences?.find((row) => row.organization_id === organizationId);

      return {
        organizationId,
        restaurantName: organization?.name ?? 'Restaurant',
        enabled: program?.enabled === true,
        enrolled: preference?.loyalty_enrolled === true
          && Boolean(preference.loyalty_consent_at)
          && !preference.loyalty_consent_withdrawn_at,
        availablePoints: Math.max(0, balanceFromLedger - expiredEarningsNotProcessed),
        currencyPerPoint: Number(program?.currency_per_point ?? 0),
        pointsPerCurrency: Number(program?.points_per_currency ?? 0),
        minimumRedemptionPoints: Number(program?.minimum_redemption_points ?? 0),
        pointsExpireDays: program?.points_expire_days ?? null,
        earnedPoints: ledger.filter((entry) => entry.entry_type === 'EARN').reduce((sum, entry) => sum + Math.max(0, Number(entry.points)), 0),
        redeemedPoints: ledger.filter((entry) => entry.entry_type === 'REDEEM').reduce((sum, entry) => sum + Math.abs(Number(entry.points)), 0),
        transactions: ledger.slice(0, 50).map(({ id, entry_type, points, amount, created_at, expires_at }) => ({
          id,
          type: entry_type,
          points: Number(points),
          amount: amount === null ? null : Number(amount),
          createdAt: created_at,
          expiresAt: expires_at,
        })),
      };
    });

    return privateJson({ wallets });
  } catch (error) {
    console.error('customer loyalty wallet', error);
    return privateJson({ error: 'Your loyalty accounts could not be loaded.' }, 500);
  }
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'customer-loyalty-consent', 10);
  if (limited) return limited;

  try {
    const parsed = consentSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return privateJson({ error: 'Choose a valid loyalty program.' }, 400);

    const user = await getBearerUser(request);
    if (!user) return privateJson({ error: 'Sign in to manage loyalty enrollment.' }, 401);

    const db = getAdminSupabase();
    const { data: profile, error: profileError } = await db
      .from('customer_profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return privateJson({ error: 'Your customer profile is unavailable.' }, 404);

    const { error: consentError } = await db.rpc('set_restaurant_loyalty_consent', {
      p_auth_user_id: user.id,
      p_organization_id: parsed.data.organizationId,
      p_enrolled: parsed.data.enrolled,
    });
    if (consentError) {
      if (consentError.message.includes('not active')) return privateJson({ error: 'This restaurant loyalty program is not active.' }, 409);
      if (consentError.message.includes('unavailable')) return privateJson({ error: 'This restaurant is unavailable.' }, 404);
      if (consentError.message.includes('profile not found')) return privateJson({ error: 'Your customer profile is unavailable.' }, 404);
      throw consentError;
    }

    return privateJson({ ok: true, enrolled: parsed.data.enrolled });
  } catch (error) {
    console.error('customer loyalty consent', error);
    return privateJson({ error: 'Your loyalty enrollment could not be updated.' }, 500);
  }
}
