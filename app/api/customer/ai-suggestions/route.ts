import { NextResponse } from 'next/server';
import { z } from 'zod';
import { executeRestaurantAssistant } from '@/lib/ai-management';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  tableCode: z.string().trim().min(1).max(64),
  question: z.string().trim().min(1).max(500),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(200),
  })).max(4).optional().default([]),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Ask a menu question up to 500 characters.' }, { status: 400 });
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Restaurant menu assistant is not configured.' }, { status: 503 });

  const { data: rows, error: contextError } = await admin.rpc('get_restaurant_ai_public_context', {
    p_table_code: parsed.data.tableCode,
  });
  if (contextError) {
    console.error('Customer AI context lookup failed', { code: contextError.code });
    return NextResponse.json({ error: 'The menu assistant could not load this restaurant menu.' }, { status: 503 });
  }
  const context = Array.isArray(rows) ? rows[0] : rows;
  if (!context?.branch_id || !context?.organization_id || !context.restaurant_name) {
    return NextResponse.json({ error: 'This restaurant QR menu is not available.' }, { status: 404 });
  }

  const allowedItems = Array.isArray(context.menu) ? context.menu : [];
  try {
    const generated = await executeRestaurantAssistant({
      organizationId: context.organization_id,
      branchId: context.branch_id,
      audience: 'customer',
      mode: 'support',
      question: JSON.stringify({
        recentConversation: parsed.data.history,
        currentQuestion: parsed.data.question,
      }),
      context: {
        restaurantName: context.restaurant_name,
        menu: allowedItems,
        popularItems: Array.isArray(context.popular_items) ? context.popular_items : [],
        dishLevelRatings: 'unavailable',
      },
    });
    if (!generated.parsed || typeof generated.parsed !== 'object') throw new Error('The assistant returned an invalid response.');
    const result = generated.parsed as Record<string, unknown>;
    if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('The assistant returned an empty response.');
    const allowedIds = new Set(allowedItems.map((item: Record<string, unknown>) => String(item.id)));
    const recommendations = Array.isArray(result.recommendedItemIds)
      ? [...new Set(result.recommendedItemIds.filter((id): id is string => typeof id === 'string' && allowedIds.has(id)))].slice(0, 3)
      : [];
    const byId = new Map(allowedItems.map((item: Record<string, unknown>) => [String(item.id), item]));
    return NextResponse.json({
      answer: result.answer.slice(0, 1000),
      recommendations: recommendations.map((id) => byId.get(id)).filter(Boolean),
      remainingRequests: generated.remainingRequests,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The menu assistant could not answer right now.';
    const limited = message.includes('daily AI assistant limit');
    return NextResponse.json({ error: message }, { status: limited ? 429 : 503 });
  }
}
